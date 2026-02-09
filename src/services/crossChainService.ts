/**
 * Cross-Chain Transfer Service
 *
 * Handles cross-chain token transfers using Li.Fi bridge.
 */

import { ethers } from 'ethers';

import { Logger } from '../helpers/loggerHelper';
import type { IBlockchain } from '../models/blockchainModel';
import type { SetupContractReturn } from '../types/commonType';
import {
  getLifiQuote,
  getLifiToken,
  type LifiChain,
  type LifiToken,
  validateAddressForChainType
} from './lifi/lifiService';
import { getChatterpayABI } from './web3/abiService';

// ============================================================================
// Types
// ============================================================================

export interface CrossChainTransferParams {
  /** Source network config (Scroll) */
  networkConfig: IBlockchain;
  /** Contract setup with signers */
  setupContractsResult: SetupContractReturn;
  /** User's ChatterPay wallet address */
  fromAddress: string;
  /** Recipient address on destination chain */
  toAddress: string;
  /** Source token address */
  sourceTokenAddress: string;
  /** Source token symbol */
  sourceTokenSymbol: string;
  /** Amount to transfer (in token units, e.g., "10.5") */
  amount: string;
  /** Source token decimals */
  sourceTokenDecimals: number;
  /** Destination chain info from Li.Fi */
  destChain: LifiChain;
  /** Destination token symbol (defaults to source symbol) */
  destTokenSymbol?: string;
  /** Unique log key */
  logKey: string;
}

export interface CrossChainTransferResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
  /** Li.Fi bridge details */
  bridgeDetails?: {
    tool: string;
    estimatedToAmount: string;
    destToken: LifiToken;
  };
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Execute a cross-chain transfer using Li.Fi bridge
 */
export async function executeCrossChainTransfer(
  params: CrossChainTransferParams
): Promise<CrossChainTransferResult> {
  const {
    networkConfig,
    setupContractsResult,
    fromAddress,
    toAddress,
    sourceTokenAddress,
    sourceTokenSymbol,
    amount,
    sourceTokenDecimals,
    destChain,
    destTokenSymbol,
    logKey
  } = params;

  const provider = setupContractsResult.provider;
  const proxyAddress = setupContractsResult.proxy.proxyAddress;
  const backendSigner = setupContractsResult.backPrincipal;

  try {
    // 1. Validate destination address format
    Logger.info(
      'executeCrossChainTransfer',
      logKey,
      `Validating address ${toAddress} for chain type ${destChain.chainType}`
    );

    if (!validateAddressForChainType(toAddress, destChain.chainType)) {
      return {
        success: false,
        error: `Invalid address format for ${destChain.name}. Expected ${destChain.chainType} format.`
      };
    }

    // 2. Lookup destination token
    const destSymbol = destTokenSymbol || sourceTokenSymbol;
    Logger.info(
      'executeCrossChainTransfer',
      logKey,
      `Looking up token ${destSymbol} on ${destChain.key}`
    );

    const destToken = await getLifiToken(destChain.key, destSymbol, logKey);
    if (!destToken) {
      return {
        success: false,
        error: `Token ${destSymbol} not found on ${destChain.name}`
      };
    }

    // 3. Get Li.Fi quote for cross-chain transfer
    const fromAmount = ethers.utils.parseUnits(amount, sourceTokenDecimals).toString();

    Logger.info(
      'executeCrossChainTransfer',
      logKey,
      `Getting Li.Fi quote: ${sourceTokenSymbol} (Scroll) → ${destSymbol} (${destChain.name})`
    );

    const quote = await getLifiQuote(
      {
        fromChain: networkConfig.chainId, // Scroll
        toChain: destChain.id,
        fromToken: sourceTokenAddress,
        toToken: destToken.address,
        fromAmount,
        fromAddress: proxyAddress,
        toAddress // Destination address on other chain
      },
      logKey
    );

    // 4. Get ChatterPay ABI dynamically
    const chatterpayABI = await getChatterpayABI();

    // 5. Check if approval is needed and execute
    const erc20ABI = ['function allowance(address,address) view returns (uint256)'];
    const tokenContract = new ethers.Contract(sourceTokenAddress, erc20ABI, provider);
    const currentAllowance = await tokenContract.allowance(
      proxyAddress,
      quote.estimate.approvalAddress
    );

    let approveTransactionHash = '';

    if (currentAllowance.lt(fromAmount)) {
      Logger.info(
        'executeCrossChainTransfer',
        logKey,
        `Approving ${quote.estimate.approvalAddress} to spend tokens`
      );

      const approveABI = ['function approve(address,uint256) returns (bool)'];
      const approveInterface = new ethers.utils.Interface(approveABI);
      const approveData = approveInterface.encodeFunctionData('approve', [
        quote.estimate.approvalAddress,
        ethers.constants.MaxUint256
      ]);

      const chatterPayContract = new ethers.Contract(proxyAddress, chatterpayABI, backendSigner);

      const approveTx = await chatterPayContract.execute(sourceTokenAddress, 0, approveData, {
        gasLimit: 100000
      });

      const approveReceipt = await approveTx.wait();
      approveTransactionHash = approveReceipt.transactionHash;
      Logger.info('executeCrossChainTransfer', logKey, `Approval tx: ${approveTransactionHash}`);
    }

    // 6. Execute the cross-chain transfer
    Logger.info(
      'executeCrossChainTransfer',
      logKey,
      `Executing cross-chain transfer via ${quote.tool}`
    );

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.utils.parseUnits('0.001', 'gwei');

    const chatterPayContract = new ethers.Contract(proxyAddress, chatterpayABI, backendSigner);

    const bridgeTx = await chatterPayContract.execute(
      quote.transactionRequest.to,
      quote.transactionRequest.value || 0,
      quote.transactionRequest.data,
      {
        gasLimit: 800000,
        gasPrice
      }
    );

    const bridgeReceipt = await bridgeTx.wait();

    if (bridgeReceipt.status !== 1) {
      return {
        success: false,
        error: 'Cross-chain transfer transaction failed'
      };
    }

    Logger.info(
      'executeCrossChainTransfer',
      logKey,
      `Cross-chain transfer initiated. Tx: ${bridgeReceipt.transactionHash}`
    );

    return {
      success: true,
      transactionHash: bridgeReceipt.transactionHash,
      bridgeDetails: {
        tool: quote.tool,
        estimatedToAmount: quote.estimate.toAmount,
        destToken
      }
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error('executeCrossChainTransfer', logKey, `Failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage
    };
  }
}

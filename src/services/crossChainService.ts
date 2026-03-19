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

    // 4. Get ChatterPay ABI and Gas Price
    const chatterpayABI = await getChatterpayABI();
    // NOTE: Use getGasPrice() instead of getFeeData().gasPrice because ethers.js v5
    // hardcodes maxPriorityFeePerGas=1.5 gwei in getFeeData(), which massively overpays on L2s.
    const gasPrice = await provider.getGasPrice();

    let approveTransactionHash = '';
    let approvalDone = false;

    // Retry with increasing slippage: 1% → 2% → 5%
    const SLIPPAGE_LEVELS = [0.01, 0.02, 0.05];

    for (let attempt = 0; attempt < SLIPPAGE_LEVELS.length; attempt++) {
      const slippage = SLIPPAGE_LEVELS[attempt];

      Logger.info(
        'executeCrossChainTransfer',
        logKey,
        `Attempt ${attempt + 1}/${SLIPPAGE_LEVELS.length}, slippage: ${(slippage * 100).toFixed(1)}%`
      );

      let quote;
      try {
        quote = await getLifiQuote(
          {
            fromChain: networkConfig.chainId, // Scroll
            toChain: destChain.id,
            fromToken: sourceTokenAddress,
            toToken: destToken.address,
            fromAmount,
            fromAddress: proxyAddress,
            toAddress, // Destination address on other chain
            slippage
          },
          logKey
        );
      } catch (quoteError) {
        const quoteMsg = quoteError instanceof Error ? quoteError.message : String(quoteError);
        Logger.warn(
          'executeCrossChainTransfer',
          logKey,
          `Quote failed (attempt ${attempt + 1}, slippage ${(slippage * 100).toFixed(1)}%): ${quoteMsg}`
        );

        if (attempt < SLIPPAGE_LEVELS.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return {
          success: false,
          error: `Cross-chain quote failed after ${SLIPPAGE_LEVELS.length} attempts: ${quoteMsg}`
        };
      }

      // 5. Check if approval is needed (only on first attempt)
      if (!approvalDone) {
        const erc20ABI = ['function allowance(address,address) view returns (uint256)'];
        const tokenContract = new ethers.Contract(sourceTokenAddress, erc20ABI, provider);
        const currentAllowance = await tokenContract.allowance(
          proxyAddress,
          quote.estimate.approvalAddress
        );

        if (currentAllowance.lt(fromAmount)) {
          Logger.info(
            'executeCrossChainTransfer',
            logKey,
            `Approving ${quote.estimate.approvalAddress} to spend tokens`
          );

          // NOTE: Use getGasPrice() instead of getFeeData().gasPrice because ethers.js v5
          // hardcodes maxPriorityFeePerGas=1.5 gwei in getFeeData(), which massively overpays on L2s.
          const gasPrice = await provider.getGasPrice();

          const approveABI = ['function approve(address,uint256) returns (bool)'];
          const approveInterface = new ethers.utils.Interface(approveABI);
          const approveData = approveInterface.encodeFunctionData('approve', [
            quote.estimate.approvalAddress,
            ethers.constants.MaxUint256
          ]);

          const chatterPayApprove = new ethers.Contract(proxyAddress, chatterpayABI, backendSigner);
          const approveTx = await chatterPayApprove.execute(sourceTokenAddress, 0, approveData, {
            gasLimit: 100000,
            gasPrice
          });

          const approveReceipt = await approveTx.wait();
          approveTransactionHash = approveReceipt.transactionHash;

          if (approveReceipt.status !== 1) {
            return {
              success: false,
              error: 'Token approval transaction failed'
            };
          }

          Logger.info(
            'executeCrossChainTransfer',
            logKey,
            `Approval tx: ${approveTransactionHash}`
          );
        }
        approvalDone = true;
      }

      // 6. Execute the cross-chain transfer
      // Use LiFi's gas estimate + 20% buffer for the execute() wrapper overhead
      const lifiGasLimit = quote.transactionRequest.gasLimit
        ? Math.ceil(Number(quote.transactionRequest.gasLimit) * 1.2)
        : 800000;

      const chatterPayContract = new ethers.Contract(proxyAddress, chatterpayABI, backendSigner);

      // Simulate first to avoid burning gas on reverts
      const callData = chatterPayContract.interface.encodeFunctionData('execute', [
        quote.transactionRequest.to,
        quote.transactionRequest.value || 0,
        quote.transactionRequest.data
      ]);

      try {
        await provider.call({
          to: proxyAddress,
          data: callData,
          from: backendSigner.address,
          gasLimit: lifiGasLimit
        });
      } catch (simError) {
        const simMsg = simError instanceof Error ? simError.message : String(simError);
        Logger.warn(
          'executeCrossChainTransfer',
          logKey,
          `Simulation failed (attempt ${attempt + 1}, slippage ${(slippage * 100).toFixed(1)}%): ${simMsg}`
        );

        // If more slippage levels to try, continue; otherwise throw
        if (attempt < SLIPPAGE_LEVELS.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return {
          success: false,
          error: `Cross-chain simulation failed after ${SLIPPAGE_LEVELS.length} attempts: ${simMsg}`
        };
      }

      Logger.info(
        'executeCrossChainTransfer',
        logKey,
        `Executing cross-chain transfer via ${quote.tool}, gasLimit: ${lifiGasLimit}, slippage: ${(slippage * 100).toFixed(1)}%`
      );

      const bridgeTx = await chatterPayContract.execute(
        quote.transactionRequest.to,
        quote.transactionRequest.value || 0,
        quote.transactionRequest.data,
        {
          gasLimit: lifiGasLimit,
          gasPrice
        }
      );

      const bridgeReceipt = await bridgeTx.wait();

      if (bridgeReceipt.status !== 1) {
        Logger.warn(
          'executeCrossChainTransfer',
          logKey,
          `Bridge tx reverted (attempt ${attempt + 1}). Tx: ${bridgeReceipt.transactionHash}`
        );

        if (attempt < SLIPPAGE_LEVELS.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return {
          success: false,
          error: 'Cross-chain transfer transaction failed after all attempts'
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
    }

    // Should not reach here, but just in case
    return {
      success: false,
      error: 'Cross-chain transfer failed: exhausted all slippage attempts'
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

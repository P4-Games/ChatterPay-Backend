/**
 * Polymarket Bridge Service
 *
 * Bridges USDC from Scroll to Polygon for Polymarket trading.
 * Reuses the existing LiFi service for cross-chain swaps.
 *
 * @see https://docs.li.fi/api-reference
 */

import { ethers } from 'ethers';

import { POLYMARKET_CHAIN_ID } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import type { IUser } from '../../models/userModel';
import { getLifiQuote, pollLifiStatus, validateLifiQuote } from '../lifi/lifiService';
import type { LifiQuoteResponse, LifiStatusResponse } from '../lifi/lifiTypes';
import { mongoBlockchainService } from '../mongo/mongoBlockchainService';
import { getChatterpayABI, getERC20ABI } from '../web3/abiService';
import { setupContracts } from '../web3/contractSetupService';

const LOG_PREFIX = 'polymarketBridgeService';

// Polygon USDC address
const POLYGON_USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

// Default scroll chain ID (will be user's current chain in practice)
const SCROLL_CHAIN_ID = 534352; // Scroll Mainnet

// ============================================================================
// Bridge Operations
// ============================================================================

/**
 * Get a bridge quote for transferring USDC from Scroll to Polygon.
 *
 * @param fromAddress - Sender address on Scroll
 * @param amount - Amount in smallest unit (wei/6 decimals for USDC)
 * @param logKey - Logging identifier
 * @returns LiFi quote response
 */
export async function getBridgeQuote(
  fromAddress: string,
  amount: string,
  logKey: string
): Promise<LifiQuoteResponse> {
  const fnLog = `[${LOG_PREFIX}:getBridgeQuote]`;

  try {
    Logger.log('info', fnLog, `${logKey} Getting bridge quote: ${amount} USDC Scroll→Polygon`);

    const quote = await getLifiQuote(
      {
        fromChain: SCROLL_CHAIN_ID,
        toChain: POLYMARKET_CHAIN_ID,
        fromToken: 'USDC',
        toToken: POLYGON_USDC_ADDRESS,
        fromAmount: amount,
        fromAddress
      },
      logKey
    );

    return quote;
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to get bridge quote: ${String(error)}`);
  }
}

/**
 * Validate a bridge quote before execution.
 */
export function validateBridgeQuote(
  quote: LifiQuoteResponse,
  expectedMinOutput?: string
): { valid: boolean; reason?: string } {
  return validateLifiQuote(quote, expectedMinOutput);
}

/**
 * Poll the status of a bridge transaction.
 *
 * @param txHash - Source chain transaction hash
 * @param logKey - Logging identifier
 * @returns Final status response
 */
export async function checkBridgeStatus(
  txHash: string,
  logKey: string
): Promise<LifiStatusResponse> {
  const fnLog = `[${LOG_PREFIX}:checkBridgeStatus]`;

  try {
    Logger.log('info', fnLog, `${logKey} Checking bridge status for tx: ${txHash}`);

    const status = await pollLifiStatus(
      {
        txHash,
        fromChain: SCROLL_CHAIN_ID,
        toChain: POLYMARKET_CHAIN_ID
      },
      logKey
    );

    return status;
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to check bridge status: ${String(error)}`);
  }
}

// ============================================================================
// Bridge Execution (server-side)
// ============================================================================

export interface ExecuteBridgeResult {
  success: boolean;
  txHash: string;
  approveTransactionHash?: string;
}

/**
 * Execute a bridge transaction server-side (approve + send + poll).
 *
 * Follows the same pattern as executeSwapLiFi in swapService.ts:
 * 1. Get a LiFi bridge quote
 * 2. Approve the LiFi router to spend USDC from the user's proxy wallet
 * 3. Forward the bridge tx through the proxy wallet via execute()
 * 4. Poll LiFi for bridge completion
 *
 * @param user - User with wallet info
 * @param amount - USDC amount in smallest unit (6 decimals)
 * @param logKey - Logging identifier
 * @returns Bridge execution result with tx hash
 */
export async function executeBridge(
  user: IUser,
  amount: string,
  logKey: string
): Promise<ExecuteBridgeResult> {
  const fnLog = `[${LOG_PREFIX}:executeBridge]`;

  try {
    Logger.log('info', fnLog, `${logKey} Executing bridge: ${amount} USDC Scroll→Polygon`);

    // 1. Setup contracts to get proxy wallet and signer
    const blockchain = await mongoBlockchainService.getNetworkConfig();
    const contracts = await setupContracts(blockchain, user);
    const proxyAddress = contracts.proxy.proxyAddress;
    const backendSigner = contracts.backPrincipal;

    // 2. Get bridge quote using proxy address as source
    const quote = await getLifiQuote(
      {
        fromChain: SCROLL_CHAIN_ID,
        toChain: POLYMARKET_CHAIN_ID,
        fromToken: 'USDC',
        toToken: POLYGON_USDC_ADDRESS,
        fromAmount: amount,
        fromAddress: proxyAddress
      },
      logKey
    );

    const validation = validateLifiQuote(quote);
    if (!validation.valid) {
      throw new Error(`Invalid bridge quote: ${validation.reason}`);
    }

    Logger.log('info', fnLog, `${logKey} Bridge quote received: tool=${quote.tool}`);

    // 3. Setup ChatterPay contract on proxy for execute() calls
    const chatterpayABI = await getChatterpayABI();
    const erc20ABI = await getERC20ABI();
    const chatterPayContract = new ethers.Contract(proxyAddress, chatterpayABI, backendSigner);

    const provider = contracts.provider;
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.utils.parseUnits('0.001', 'gwei');

    // 4. Approve LiFi router to spend USDC if needed
    let approveTransactionHash = '';
    const approvalAddress = quote.estimate.approvalAddress;

    if (approvalAddress && approvalAddress !== ethers.constants.AddressZero) {
      // Resolve the actual USDC token address on Scroll from the quote
      const fromTokenAddress = quote.action.fromToken.address;
      const tokenContract = new ethers.Contract(fromTokenAddress, erc20ABI, provider);
      const amountBN = ethers.BigNumber.from(amount);
      const currentAllowance = await tokenContract.allowance(proxyAddress, approvalAddress);

      if (currentAllowance.lt(amountBN)) {
        Logger.log('info', fnLog, `${logKey} Approving LiFi router for bridge`);

        const approveCallData = tokenContract.interface.encodeFunctionData('approve', [
          approvalAddress,
          ethers.constants.MaxUint256
        ]);

        const approveTx = await chatterPayContract.execute(fromTokenAddress, 0, approveCallData, {
          gasLimit: 150000,
          gasPrice
        });

        const approveReceipt = await approveTx.wait();
        if (approveReceipt.status !== 1) {
          throw new Error('Bridge approval transaction failed');
        }

        approveTransactionHash = approveReceipt.transactionHash;
        Logger.log('info', fnLog, `${logKey} Approval tx: ${approveTransactionHash}`);
      } else {
        Logger.log('info', fnLog, `${logKey} Sufficient allowance for bridge, skipping approval`);
      }
    }

    // 5. Execute the bridge transaction through the proxy wallet
    Logger.log('info', fnLog, `${logKey} Sending bridge transaction`);

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
      throw new Error('Bridge transaction reverted');
    }

    const txHash = bridgeReceipt.transactionHash;
    Logger.log('info', fnLog, `${logKey} Bridge tx sent: ${txHash}`);

    // 6. Poll for bridge completion
    Logger.log('info', fnLog, `${logKey} Polling bridge status`);
    const status = await pollLifiStatus(
      {
        txHash,
        fromChain: SCROLL_CHAIN_ID,
        toChain: POLYMARKET_CHAIN_ID
      },
      logKey
    );

    if (status.status === 'FAILED') {
      throw new Error(`Bridge failed: ${status.substatusMessage || 'Unknown reason'}`);
    }

    Logger.log('info', fnLog, `${logKey} Bridge completed successfully`);

    return {
      success: true,
      txHash,
      approveTransactionHash: approveTransactionHash || undefined
    };
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Bridge execution failed: ${String(error)}`);
    throw new Error(`Bridge execution failed: ${String(error)}`);
  }
}

/**
 * Polymarket Bridge Service
 *
 * Bridges USDC from Scroll to Polygon for Polymarket trading.
 * Reuses the existing LiFi service for cross-chain swaps.
 *
 * @see https://docs.li.fi/api-reference
 */

import { POLYMARKET_CHAIN_ID } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import { getLifiQuote, pollLifiStatus, validateLifiQuote } from '../lifi/lifiService';
import type { LifiQuoteResponse, LifiStatusResponse } from '../lifi/lifiTypes';

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

/**
 * Li.Fi Service
 *
 * Handles interactions with the Li.Fi aggregator API for optimal swap routing.
 * Provides quote fetching, status tracking, and error handling with retries.
 *
 * @see https://docs.li.fi/api-reference
 */

import axios, { type AxiosError, type AxiosResponse } from 'axios';

import {
  LIFI_API_BASE_URL,
  LIFI_DEFAULT_SLIPPAGE,
  LIFI_INTEGRATOR_FEE,
  LIFI_INTEGRATOR_KEY
} from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';

import type {
  LifiApiError,
  LifiChain,
  LifiParsedError,
  LifiQuoteRequest,
  LifiQuoteResponse,
  LifiStatusRequest,
  LifiStatusResponse,
  LifiToken
} from './lifiTypes';

// ============================================================================
// Constants
// ============================================================================

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const STATUS_POLL_INTERVAL_MS = 10000; // 10 seconds
const STATUS_POLL_TIMEOUT_MS = 300000; // 5 minutes

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
function getBackoffDelay(attempt: number, baseDelay: number = INITIAL_RETRY_DELAY_MS): number {
  return baseDelay * 2 ** attempt;
}

/**
 * Parse Li.Fi API error response
 */
export function parseLifiError(error: unknown): LifiParsedError {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<LifiApiError>;
    const status = axiosError.response?.status;
    const data = axiosError.response?.data;

    // Rate limited - should retry
    if (status === 429) {
      return {
        isRecoverable: true,
        shouldRetry: true,
        errorCode: 'RATE_LIMITED',
        message: 'Rate limited by Li.Fi API'
      };
    }

    // Server error - may be transient
    if (status && status >= 500) {
      return {
        isRecoverable: true,
        shouldRetry: true,
        errorCode: `SERVER_ERROR_${status}`,
        message: data?.message || 'Li.Fi server error'
      };
    }

    // Parse structured error response
    if (data?.errors && data.errors.length > 0) {
      const firstError = data.errors[0];
      const errorCode = firstError.code;
      const isRecoverable = isRecoverableErrorCode(errorCode);

      return {
        isRecoverable,
        shouldRetry: isRecoverable,
        errorCode,
        message: firstError.message || data.message || 'Li.Fi API error',
        failedTool: firstError.tool ? String(Object.keys(firstError.tool)[0]) : undefined
      };
    }

    // Generic client error
    return {
      isRecoverable: false,
      shouldRetry: false,
      errorCode: `CLIENT_ERROR_${status}`,
      message: data?.message || axiosError.message || 'Li.Fi API request failed'
    };
  }

  // Non-Axios error
  return {
    isRecoverable: false,
    shouldRetry: false,
    message: error instanceof Error ? error.message : 'Unknown error'
  };
}

/**
 * Check if an error code is recoverable
 */
function isRecoverableErrorCode(code: string): boolean {
  const recoverableCodes: readonly string[] = [
    'SLIPPAGE_ERROR',
    'INSUFFICIENT_LIQUIDITY',
    'TIMEOUT',
    'BRIDGE_ERROR',
    'NO_POSSIBLE_ROUTE'
  ];
  return recoverableCodes.includes(code);
}

// ============================================================================
// Main API Functions
// ============================================================================

/**
 * Fetch a swap quote from Li.Fi API
 *
 * @param params - Quote request parameters
 * @param logKey - Unique identifier for logging
 * @returns Quote response with transaction data
 *
 * @example
 * const quote = await getLifiQuote({
 *   fromChain: 137,
 *   toChain: 137,
 *   fromToken: 'USDC',
 *   toToken: 'WETH',
 *   fromAmount: '1000000000', // 1000 USDC (6 decimals)
 *   fromAddress: '0x...'
 * }, 'swap-123');
 */
export async function getLifiQuote(
  params: LifiQuoteRequest,
  logKey: string
): Promise<LifiQuoteResponse> {
  const {
    fromChain,
    toChain,
    fromToken,
    toToken,
    fromAmount,
    fromAddress,
    toAddress,
    slippage = LIFI_DEFAULT_SLIPPAGE,
    denyExchanges,
    allowExchanges
  } = params;

  Logger.info(
    'getLifiQuote',
    logKey,
    `Requesting quote: ${fromToken} → ${toToken}, amount: ${fromAmount}, chain: ${fromChain} → ${toChain}`
  );

  const queryParams = new URLSearchParams({
    fromChain: String(fromChain),
    toChain: String(toChain),
    fromToken,
    toToken,
    fromAmount,
    fromAddress,
    toAddress: toAddress || fromAddress,
    slippage: String(slippage),
    integrator: LIFI_INTEGRATOR_KEY,
    fee: String(LIFI_INTEGRATOR_FEE)
  });

  if (denyExchanges?.length) {
    queryParams.set('denyExchanges', denyExchanges.join(','));
  }
  if (allowExchanges?.length) {
    queryParams.set('allowExchanges', allowExchanges.join(','));
  }

  const url = `${LIFI_API_BASE_URL}/quote?${queryParams.toString()}`;

  let lastError: LifiParsedError | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response: AxiosResponse<LifiQuoteResponse> = await axios.get(url, {
        timeout: 30000,
        headers: {
          Accept: 'application/json'
        }
      });

      const quote = response.data;

      Logger.info(
        'getLifiQuote',
        logKey,
        `Quote received: tool=${quote.tool}, toAmount=${quote.estimate.toAmount}, ` +
          `toAmountMin=${quote.estimate.toAmountMin}, approvalAddress=${quote.estimate.approvalAddress}`
      );

      return quote;
    } catch (error) {
      lastError = parseLifiError(error);

      Logger.warn(
        'getLifiQuote',
        logKey,
        `Attempt ${attempt + 1}/${MAX_RETRIES} failed: ${lastError.message} (code: ${lastError.errorCode})`
      );

      if (!lastError.shouldRetry || attempt === MAX_RETRIES - 1) {
        break;
      }

      const delay = getBackoffDelay(attempt);
      Logger.debug('getLifiQuote', logKey, `Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw new Error(`Li.Fi quote failed: ${lastError?.message || 'Unknown error'}`);
}

/**
 * Check the status of a cross-chain transfer
 *
 * @param params - Status request parameters
 * @param logKey - Unique identifier for logging
 * @returns Status response with transfer details
 */
export async function getLifiStatus(
  params: LifiStatusRequest,
  logKey: string
): Promise<LifiStatusResponse> {
  const { txHash, fromChain, toChain, bridge } = params;

  const queryParams = new URLSearchParams({ txHash });

  if (fromChain) queryParams.set('fromChain', String(fromChain));
  if (toChain) queryParams.set('toChain', String(toChain));
  if (bridge) queryParams.set('bridge', bridge);

  const url = `${LIFI_API_BASE_URL}/status?${queryParams.toString()}`;

  try {
    const response: AxiosResponse<LifiStatusResponse> = await axios.get(url, {
      timeout: 15000,
      headers: {
        Accept: 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    const parsedError = parseLifiError(error);
    Logger.warn('getLifiStatus', logKey, `Status check failed: ${parsedError.message}`);
    throw new Error(`Li.Fi status check failed: ${parsedError.message}`);
  }
}

/**
 * Poll for transfer completion status
 *
 * Continuously checks the transfer status until it reaches a terminal state
 * (DONE or FAILED) or the timeout is exceeded.
 *
 * @param params - Status request parameters
 * @param logKey - Unique identifier for logging
 * @param timeoutMs - Maximum time to poll (default: 5 minutes)
 * @returns Final status response
 */
export async function pollLifiStatus(
  params: LifiStatusRequest,
  logKey: string,
  timeoutMs: number = STATUS_POLL_TIMEOUT_MS
): Promise<LifiStatusResponse> {
  const startTime = Date.now();

  Logger.info('pollLifiStatus', logKey, `Starting status polling for tx: ${params.txHash}`);

  while (Date.now() - startTime < timeoutMs) {
    try {
      const status = await getLifiStatus(params, logKey);

      Logger.debug(
        'pollLifiStatus',
        logKey,
        `Status: ${status.status}, substatus: ${status.substatus || 'N/A'}`
      );

      // Terminal states
      if (status.status === 'DONE') {
        Logger.info('pollLifiStatus', logKey, `Transfer completed: substatus=${status.substatus}`);
        return status;
      }

      if (status.status === 'FAILED') {
        Logger.error(
          'pollLifiStatus',
          logKey,
          `Transfer failed: ${status.substatusMessage || 'No details'}`
        );
        return status;
      }

      // Continue polling for PENDING and NOT_FOUND
      await sleep(STATUS_POLL_INTERVAL_MS);
    } catch (error) {
      // Log but continue polling on transient errors
      Logger.warn(
        'pollLifiStatus',
        logKey,
        `Poll error (will retry): ${error instanceof Error ? error.message : 'Unknown'}`
      );
      await sleep(STATUS_POLL_INTERVAL_MS);
    }
  }

  throw new Error(`Status polling timed out after ${timeoutMs}ms`);
}

/**
 * Validate a quote against expected parameters
 *
 * @param quote - Quote response to validate
 * @param expectedMinOutput - Minimum expected output amount (optional)
 * @returns Validation result
 */
export function validateLifiQuote(
  quote: LifiQuoteResponse,
  expectedMinOutput?: string
): { valid: boolean; reason?: string } {
  // Check transaction request is present
  if (!quote.transactionRequest) {
    return { valid: false, reason: 'Missing transaction request' };
  }

  // Check required transaction fields
  const { to, data, gasLimit } = quote.transactionRequest;
  if (!to || !data || !gasLimit) {
    return { valid: false, reason: 'Incomplete transaction request' };
  }

  // Check estimate is present
  if (!quote.estimate || !quote.estimate.toAmountMin) {
    return { valid: false, reason: 'Missing estimate data' };
  }

  // Validate against expected minimum if provided
  if (expectedMinOutput) {
    const toAmountMin = BigInt(quote.estimate.toAmountMin);
    const expected = BigInt(expectedMinOutput);

    if (toAmountMin < expected) {
      return {
        valid: false,
        reason: `Quote output ${toAmountMin} is below expected minimum ${expected}`
      };
    }
  }

  return { valid: true };
}

// Re-export types from lifiTypes for convenience
export type { LifiChain, LifiToken } from './lifiTypes';

// ============================================================================
// Chain & Token Lookup Functions
// ============================================================================

/**
 * Fetch all supported chains from Li.Fi API
 */
export async function getLifiChains(logKey: string): Promise<LifiChain[]> {
  const url = `${LIFI_API_BASE_URL}/chains`;

  try {
    const response: AxiosResponse<{ chains: LifiChain[] }> = await axios.get(url, {
      timeout: 15000,
      headers: { Accept: 'application/json' }
    });

    const chains = response.data.chains.filter((c: LifiChain) => c.mainnet);
    Logger.info('getLifiChains', logKey, `Fetched ${chains.length} mainnet chains from Li.Fi`);
    return chains;
  } catch (error) {
    const parsedError = parseLifiError(error);
    Logger.error('getLifiChains', logKey, `Failed to fetch chains: ${parsedError.message}`);
    throw new Error(`Li.Fi chains fetch failed: ${parsedError.message}`);
  }
}

/**
 * Lookup token by symbol on a specific chain
 * Includes fallback for common symbol aliases (e.g., USDT/USDT0)
 */
export async function getLifiToken(
  chainKey: string,
  tokenSymbol: string,
  logKey: string
): Promise<LifiToken | null> {
  const url = `${LIFI_API_BASE_URL}/token`;

  // Token symbol aliases for fallback lookup
  const TOKEN_ALIASES: Record<string, string[]> = {
    USDT: ['USDT0'],
    USDT0: ['USDT'],
    WETH: ['ETH'],
    ETH: ['WETH'],
    WBTC: ['BTC'],
    BTC: ['WBTC'],
    WSOL: ['SOL'],
    SOL: ['WSOL']
  };

  const symbolsToTry = [tokenSymbol, ...(TOKEN_ALIASES[tokenSymbol.toUpperCase()] || [])];

  for (const symbol of symbolsToTry) {
    try {
      const response: AxiosResponse<LifiToken> = await axios.get(url, {
        timeout: 10000,
        headers: { Accept: 'application/json' },
        params: { chain: chainKey, token: symbol }
      });

      Logger.info(
        'getLifiToken',
        logKey,
        `Found token ${symbol} on ${chainKey}: ${response.data.address}`
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        Logger.debug(
          'getLifiToken',
          logKey,
          `Token ${symbol} not found on ${chainKey}, trying next alias...`
        );
        continue;
      }
      const parsedError = parseLifiError(error);
      Logger.error('getLifiToken', logKey, `Failed to lookup token: ${parsedError.message}`);
      throw new Error(`Li.Fi token lookup failed: ${parsedError.message}`);
    }
  }

  Logger.warn(
    'getLifiToken',
    logKey,
    `Token ${tokenSymbol} (and aliases) not found on chain ${chainKey}`
  );
  return null;
}

/**
 * Validate address format for a given chain type
 */
export function validateAddressForChainType(address: string, chainType: string): boolean {
  switch (chainType) {
    case 'EVM':
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    case 'SVM':
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    case 'UTXO':
      return (
        /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address) || /^bc1[a-z0-9]{39,59}$/i.test(address)
      );
    default:
      return false;
  }
}

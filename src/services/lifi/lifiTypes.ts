/**
 * Li.Fi API Types
 *
 * Type definitions for interacting with the Li.Fi aggregator API.
 * Based on: https://docs.li.fi/api-reference
 */

// ============================================================================
// Request Types
// ============================================================================

/**
 * Parameters for requesting a swap quote from Li.Fi
 */
export interface LifiQuoteRequest {
  /** Source chain ID (e.g., 137 for Polygon) */
  fromChain: number;
  /** Destination chain ID (same as fromChain for same-chain swaps) */
  toChain: number;
  /** Source token address or symbol */
  fromToken: string;
  /** Destination token address or symbol */
  toToken: string;
  /** Amount in smallest unit (wei) */
  fromAmount: string;
  /** Sender wallet address */
  fromAddress: string;
  /** Recipient wallet address (defaults to fromAddress) */
  toAddress?: string;
  /** Slippage tolerance (0.005 = 0.5%) */
  slippage?: number;
  /** Integrator identifier for analytics */
  integrator?: string;
  /** DEXs/bridges to exclude */
  denyExchanges?: string[];
  /** DEXs/bridges to prefer */
  allowExchanges?: string[];
}

/**
 * Parameters for checking transfer status
 */
export interface LifiStatusRequest {
  /** Transaction hash from source chain */
  txHash: string;
  /** Source chain ID (optional but recommended) */
  fromChain?: number;
  /** Destination chain ID (optional) */
  toChain?: number;
  /** Bridge name from quote (optional) */
  bridge?: string;
}

// ============================================================================
// Response Types
// ============================================================================

/**
 * Token information in Li.Fi responses
 */
export interface LifiToken {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
  name: string;
  coinKey?: string;
  priceUSD?: string;
  logoURI?: string;
}

/**
 * Chain information from Li.Fi /chains endpoint
 */
export interface LifiChain {
  /** Short key used in API calls (e.g., "eth", "arb", "sol") */
  key: string;
  /** Chain type: "EVM", "SVM" (Solana), "UTXO" (Bitcoin) */
  chainType: string;
  /** Display name (e.g., "Ethereum", "Arbitrum") */
  name: string;
  /** Chain ID (for EVM chains) */
  id: number;
  /** Whether it's a mainnet */
  mainnet: boolean;
  /** Native token info */
  coin: string;
  /** Logo URL */
  logoURI?: string;
}

/**
 * Gas cost breakdown

 */
export interface LifiGasCost {
  type: 'SEND' | 'APPROVE' | 'BRIDGE';
  price: string;
  estimate: string;
  limit: string;
  amount: string;
  amountUSD: string;
  token: LifiToken;
}

/**
 * Fee cost breakdown
 */
export interface LifiFeeCost {
  name: string;
  description: string;
  percentage: string;
  token: LifiToken;
  amount: string;
  amountUSD: string;
  included: boolean;
}

/**
 * Swap action details
 */
export interface LifiAction {
  fromChainId: number;
  toChainId: number;
  fromToken: LifiToken;
  toToken: LifiToken;
  fromAmount: string;
  slippage: number;
  fromAddress: string;
  toAddress: string;
}

/**
 * Estimate details from quote
 */
export interface LifiEstimate {
  fromAmount: string;
  toAmount: string;
  toAmountMin: string;
  approvalAddress: string;
  feeCosts: LifiFeeCost[];
  gasCosts: LifiGasCost[];
  executionDuration?: number;
  data?: {
    fromToken: LifiToken;
    toToken: LifiToken;
    toTokenAmount: string;
    fromTokenAmount: string;
    protocols?: Array<Array<Array<{ name: string; part: number }>>>;
    estimatedGas: number;
  };
}

/**
 * Tool/DEX details
 */
export interface LifiToolDetails {
  key: string;
  name: string;
  logoURI: string;
}

/**
 * Transaction request ready to be signed
 */
export interface LifiTransactionRequest {
  from: string;
  to: string;
  chainId: number;
  data: string;
  value: string;
  gasPrice?: string;
  gasLimit: string;
}

/**
 * Quote response from Li.Fi /quote endpoint
 */
export interface LifiQuoteResponse {
  id: string;
  type: 'lifi';
  tool: string;
  toolDetails: LifiToolDetails;
  action: LifiAction;
  estimate: LifiEstimate;
  transactionRequest: LifiTransactionRequest;
  integrator?: string;
  includedSteps?: LifiStep[];
}

/**
 * Individual step in a multi-step swap
 */
export interface LifiStep {
  id: string;
  type: 'swap' | 'cross' | 'lifi';
  tool: string;
  toolDetails: LifiToolDetails;
  action: LifiAction;
  estimate: LifiEstimate;
}

/**
 * Transfer status values
 */
export type LifiTransferStatus = 'NOT_FOUND' | 'PENDING' | 'DONE' | 'FAILED';

/**
 * Substatus values for completed transfers
 */
export type LifiSubstatus = 'COMPLETED' | 'PARTIAL' | 'REFUNDED' | 'NOT_PROCESSABLE_REFUND_NEEDED';

/**
 * Status response from Li.Fi /status endpoint
 */
export interface LifiStatusResponse {
  status: LifiTransferStatus;
  substatus?: LifiSubstatus;
  substatusMessage?: string;
  transactionId?: string;
  sending?: {
    txHash: string;
    txLink: string;
    amount: string;
    token: LifiToken;
    chainId: number;
    gasPrice: string;
    gasUsed: string;
    gasToken: LifiToken;
    gasAmount: string;
    gasAmountUSD: string;
    amountUSD: string;
    value: string;
    timestamp: number;
  };
  receiving?: {
    txHash: string;
    txLink: string;
    amount: string;
    token: LifiToken;
    chainId: number;
    gasPrice: string;
    gasUsed: string;
    gasToken: LifiToken;
    gasAmount: string;
    gasAmountUSD: string;
    amountUSD: string;
    value: string;
    timestamp: number;
  };
  fromAddress?: string;
  toAddress?: string;
  tool?: string;
  bridgeExplorerLink?: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Li.Fi API error response structure
 */
export interface LifiApiError {
  message: string;
  code?: string | number;
  errors?: Array<{
    errorType: string;
    code: string;
    action?: { [key: string]: unknown };
    tool?: { [key: string]: unknown };
    message: string;
  }>;
}

/**
 * Error codes that may be recoverable with retry
 */
export const LIFI_RECOVERABLE_ERRORS = [
  'SLIPPAGE_ERROR',
  'INSUFFICIENT_LIQUIDITY',
  'TIMEOUT',
  'BRIDGE_ERROR'
] as const;

export type LifiRecoverableError = (typeof LIFI_RECOVERABLE_ERRORS)[number];

/**
 * Parsed error result from Li.Fi
 */
export interface LifiParsedError {
  isRecoverable: boolean;
  shouldRetry: boolean;
  errorCode?: string;
  message: string;
  failedTool?: string;
}

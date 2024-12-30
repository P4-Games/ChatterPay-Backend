/**
 * Basic token information including price
 */
export interface TokenInfo {
  symbol: string;
  address: string;
  rateUSD: number;
}

/**
 * Supported fiat currencies for conversion
 */
export type Currency = 'USD' | 'UYU' | 'ARS' | 'BRL';

/**
 * Fiat currency quote information
 */
export interface FiatQuote {
  currency: Currency;
  rate: number;
}

/**
 * Token information including balance
 */
export interface TokenBalance extends TokenInfo {
  balance: string;
}

/**
 * Detailed balance information for a token including conversions
 */
export interface BalanceInfo {
  network: string;
  token: string;
  balance: number;
  balance_conv: Record<Currency, number>;
}

export interface walletBalanceInfo {
  walletBalance: string;
  amountToCheck: string;
  enoughBalance: boolean;
}

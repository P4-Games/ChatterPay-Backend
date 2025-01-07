/**
 * Basic token information including price
 */
export interface TokenInfoType {
  symbol: string;
  address: string;
  rateUSD: number;
}

/**
 * Supported fiat currencies for conversion
 */
export type CurrencyType = 'USD' | 'UYU' | 'ARS' | 'BRL';

/**
 * Fiat currency quote information
 */
export interface FiatQuoteType {
  currency: CurrencyType;
  rate: number;
}

/**
 * Token information including balance
 */
export interface TokenBalanceType extends TokenInfoType {
  balance: string;
}

/**
 * Detailed balance information for a token including conversions
 */
export interface BalanceInfoType {
  network: string;
  token: string;
  balance: number;
  balance_conv: Record<CurrencyType, number>;
}

export interface walletBalanceInfoType {
  walletBalance: string;
  amountToCheck: string;
  enoughBalance: boolean;
}

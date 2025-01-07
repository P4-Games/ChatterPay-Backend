import { ethers } from 'ethers';

import { setupContractReturnType } from '../services/contractSetupService';

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

export interface CheckBalanceConditionsResultType {
  success: boolean;
  setupContractsResult: setupContractReturnType | null;
  entryPointContract: ethers.Contract | null;
}

export interface TokenAddressesType {
  tokenAddressInput: string;
  tokenAddressOutput: string;
}

export interface ExecuteSwapResultType {
  success: boolean;
  approveTransactionHash: string;
  swapTransactionHash: string;
}

export interface ExecueTransactionResultType {
  success: boolean;
  transactionHash: string;
}

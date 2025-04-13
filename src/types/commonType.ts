import { ethers } from 'ethers';

import { ComputedAddress } from '../services/predictWalletService';

/**
 * Basic token information including price
 */
export interface TokenInfo {
  symbol: string;
  address: string;
  type: string;
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

export interface WalletBalanceInfo {
  walletBalance: string;
  amountToCheck: string;
  enoughBalance: boolean;
}

export interface CheckBalanceConditionsResult {
  success: boolean;
  setupContractsResult: SetupContractReturn | null;
  entryPointContract: ethers.Contract | null;
}

export interface TokenAddresses {
  tokenAddressInput: string;
  tokenAddressOutput: string;
}

export interface ExecuteSwapResult {
  success: boolean;
  approveTransactionHash: string;
  swapTransactionHash: string;
}

export interface ExecueTransactionResult {
  success: boolean;
  transactionHash: string;
  error: string;
}

export interface SetupContractReturn {
  provider: ethers.providers.JsonRpcProvider;
  signer: ethers.Wallet;
  backendSigner: ethers.Wallet;
  chatterPay: ethers.Contract;
  proxy: ComputedAddress;
  accountExists: boolean;
}

export enum ConcurrentOperationsEnum {
  Transfer = 'transfer',
  Swap = 'swap',
  MintNft = 'mint_nft',
  MintNftCopy = 'mint_nft_copy',
  WithdrawAll = 'withdraw_all'
}

export interface TransactionData {
  tx: string;
  walletFrom: string;
  walletTo: string;
  amount: number;
  token: string;
  type: string;
  status: string;
  chain_id: number;
}

export interface ConversionRates {
  [token: string]: {
    [currency: string]: number;
  };
}

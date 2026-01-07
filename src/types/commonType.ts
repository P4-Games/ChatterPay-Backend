import type { ethers } from 'ethers';

/**
 * Basic token information including price
 */
export interface TokenInfo {
  symbol: string;
  address: string;
  type: string;
  rateUSD: number;
  display_decimals: number;
  display_symbol: string;
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
  tokenAddress?: string;
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

export interface swapTokensData {
  tokenInputAddress: string;
  tokenInputSymbol: string;
  tokenInputDisplaySymbol: string;
  tokenInputDisplayDecimals: number;
  tokenOutputAddress: string;
  tokenOutputSymbol: string;
  tokenOutputDisplaySymbol: string;
  tokenOutputDisplayDecimals: number;
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
  userPrincipal: ethers.Wallet;
  backPrincipal: ethers.Wallet;
  chatterPay: ethers.Contract;
  proxy: ComputedAddress;
  accountExists: boolean;
}

export enum ConcurrentOperationsEnum {
  Transfer = 'transfer',
  Swap = 'swap',
  MintNft = 'mint_nft',
  MintNftCopy = 'mint_nft_copy'
}

export interface TransactionData {
  tx: string;
  walletFrom: string;
  walletTo: string;
  amount: number;
  fee: number;
  token: string;
  type: string;
  status: string;
  chain_id: number;
  date?: Date;
  user_notes?: string;
}

export interface ConversionRates {
  [token: string]: {
    [currency: string]: number;
  };
}

export interface MintResult {
  tokenAddress: string;
  txHash: string;
}

export interface UserPrincipal {
  data: string;
  EOAAddress: string;
}

export interface ComputedAddress extends UserPrincipal {
  proxyAddress: string;
}

export const rpcProviders = {
  ALCHEMY: 'alchemy',
  PIMLICO: 'pimlico'
} as const;

export type RpcProvider = (typeof rpcProviders)[keyof typeof rpcProviders];

export enum CacheNames {
  OPENSEA = 'openSea',
  PRICE = 'priceCache',
  ABI = 'abiCache',
  NOTIFICATION = 'notificationTemplateCache',
  TOR = 'torCache',
  COINGECKO = 'coingeckoCache',
  ERC20 = 'erc20',
  CHATTERPOINTS_WORDS = 'chatterpoints_words'
}

const systemLanguages = ['en', 'es', 'pt'] as const;

export const notificationLanguages = systemLanguages;
export type NotificationLanguage = (typeof notificationLanguages)[number];

export const gamesLanguages = systemLanguages;
export type gamesLanguage = (typeof gamesLanguages)[number];

export type AddressBalanceWithNfts = {
  balances: BalanceInfo[];
  totals: Record<Currency, number>;
  certificates: unknown[];
  wallets: string[];
};

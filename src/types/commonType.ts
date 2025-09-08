import { ethers } from 'ethers';

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
  tokenOutputAddress: string;
  tokenOutputSymbol: string;
  tokenOutputDisplaySymbol: string;
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

export interface PhoneNumberToAddress {
  hashedPrivateKey: string;
  privateKey: string;
  publicKey: string;
}

export interface ComputedAddress {
  proxyAddress: string;
  EOAAddress: string;
  privateKey: string;
  privateKeyNotHashed: string;
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
  ERC20 = 'erc20'
}

export const notificationLanguages = ['en', 'es', 'pt'] as const;
export type NotificationLanguage = (typeof notificationLanguages)[number];

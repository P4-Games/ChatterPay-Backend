import { ethers } from 'ethers';
import NodeCache from 'node-cache';

import { IToken } from '../models/token';
import { Logger } from '../helpers/loggerHelper';
import { SIGNING_KEY } from '../config/constants';
import { IBlockchain } from '../models/blockchain';
import { setupERC20 } from './contractSetupService';
import { getTokenAddress } from './blockchainService';
import {
  CurrencyType,
  FiatQuoteType,
  TokenInfoType,
  BalanceInfoType,
  TokenBalanceType,
  walletBalanceInfoType
} from '../types/common';

// Initialize the cache with a 5-minute TTL (Time To Live)
const priceCache = new NodeCache({ stdTTL: 300, checkperiod: 320 });

/**
 * API endpoints for fiat currency conversion rates
 */
const API_URLs: [CurrencyType, string][] = [
  ['UYU', 'https://criptoya.com/api/ripio/USDT/UYU'],
  ['ARS', 'https://criptoya.com/api/ripio/USDT/ARS'],
  ['BRL', 'https://criptoya.com/api/ripio/USDT/BRL']
];

/**
 * Fetches the balance of a specific token for a given address
 * @param {string} contractAddress - Token contract address
 * @param {ethers.Wallet} signer - Ethereum wallet signer
 * @param {string} address - Address to check balance for
 * @returns {Promise<string>} Token balance as a string
 */
export async function getContractBalance(
  contractAddress: string,
  signer: ethers.Wallet,
  address: string
): Promise<string> {
  try {
    const erc20Contract = new ethers.Contract(
      contractAddress,
      ['function balanceOf(address owner) view returns (uint256)'],
      signer
    );
    const balance = await erc20Contract.balanceOf(address);
    return ethers.utils.formatUnits(balance, 18);
  } catch (error) {
    Logger.error(
      'getContractBalance',
      `Error getting balance: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return '0';
  }
}

/**
 * Fetches fiat quotes from external APIs
 * @returns {Promise<FiatQuoteType[]>} Array of fiat currency quotes
 */
export async function getFiatQuotes(): Promise<FiatQuoteType[]> {
  return Promise.all(
    API_URLs.map(async ([currency, url]) => {
      try {
        const response = await fetch(url);
        const data = await response.json();
        return { currency, rate: data.bid };
      } catch (error) {
        Logger.error('getFiatQuotes', `Error fetching ${currency} quote:`, error);
        return { currency, rate: 1 }; // Fallback to 1:1 rate
      }
    })
  );
}

/**
 * Fetches token prices from Binance API using USDT pairs
 * @param {string[]} symbols - Array of token symbols to fetch prices for
 * @returns {Promise<Map<string, number>>} Map of token symbols to their USD prices
 */
export async function getTokenPrices(symbols: string[]): Promise<Map<string, number>> {
  try {
    const priceMap = new Map<string, number>();

    // USDT is always 1 USD
    priceMap.set('USDT', 1);

    // Filter out USDT as we already set its price
    const symbolsToFetch = symbols.filter((s) => s !== 'USDT');

    if (symbolsToFetch.length === 0) return priceMap;

    try {
      // Check cache for existing prices
      const cachedPrices = priceCache.mget(symbolsToFetch);
      const symbolsToFetchFromApi = symbolsToFetch.filter((symbol) => !cachedPrices[symbol]);

      // Set cached prices to the priceMap
      Object.entries(cachedPrices).forEach(([symbol, price]) => {
        priceMap.set(symbol, price as number);
      });

      if (symbolsToFetchFromApi.length === 0) {
        Logger.log('getTokenPrices', 'getting prices from cache!');
        return priceMap;
      }
    } catch (error) {
      // Avoid throwing error
      Logger.error(
        'getTokenPrices',
        `Error getting prices from cache: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    // Get prices for all symbols against USDT
    const promises = symbolsToFetch.map(async (symbol) => {
      try {
        const symbolReplaced = symbol.replace('WETH', 'ETH');
        const response = await fetch(
          `https://api.binance.us/api/v3/ticker/price?symbol=${symbolReplaced}USDT`
        );
        const data = await response.json();
        if (data.price) {
          Logger.log('getTokenPrices', `Price for ${symbolReplaced}: ${data.price} USDT`);
          const price = parseFloat(data.price);
          priceMap.set(symbolReplaced.replace('ETH', 'WETH'), price);
          // Cache the price for 5 minutes
          priceCache.set(symbolReplaced.replace('ETH', 'WETH'), price);
        } else {
          Logger.warn('getTokenPrices', `No price found for ${symbolReplaced}USDT`);
          priceMap.set(symbolReplaced.replace('ETH', 'WETH'), 0);
        }
      } catch (error) {
        Logger.error('getTokenPrices', `Error fetching price for ${symbol}:`, error);
        priceMap.set(symbol, 0);
      }
    });

    await Promise.all(promises);
    return priceMap;
  } catch (error) {
    Logger.error('getTokenPrices', 'Error fetching token prices from Binance:', error);
    // Return a map with 0 prices in case of error, except USDT which is always 1
    return new Map(symbols.map((symbol) => [symbol, symbol === 'USDT' ? 1 : 0]));
  }
}

/**
 * Gets token information from the global state and current prices
 * @param {IToken[]} tokens - Array of token objects
 * @param {number} chanId - Chain ID to filter tokens
 * @returns {Promise<TokenInfoType[]>} Array of tokens with current price information
 */
export async function getTokenInfo(tokens: IToken[], chanId: number): Promise<TokenInfoType[]> {
  const chainTokens = tokens.filter((token) => token.chain_id === chanId);
  const symbols = [...new Set(chainTokens.map((token) => token.symbol))];

  const prices = await getTokenPrices(symbols);

  return chainTokens.map((token) => ({
    symbol: token.symbol,
    address: token.address,
    rateUSD: prices.get(token.symbol) || 0
  }));
}

/**
 * Fetches token balances for a given address
 * @param {string} address - Address to check balances for
 * @param {IToken[]} tokens - Array of token objects
 * @param {IBlockchain} networkConfig - Blockchain network configuration
 * @returns {Promise<TokenBalanceType[]>} Array of token balances
 */
export async function getTokenBalances(
  address: string,
  tokens: IToken[],
  networkConfig: IBlockchain
): Promise<TokenBalanceType[]> {
  const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
  const signer = new ethers.Wallet(SIGNING_KEY!, provider);
  const tokenInfo = await getTokenInfo(tokens, networkConfig.chain_id);

  return Promise.all(
    tokenInfo.map(async (token) => {
      const balance = await getContractBalance(token.address, signer, address);
      return { ...token, balance };
    })
  );
}

/**
 * Calculates balance information for all tokens including fiat conversions
 * @param {TokenBalanceType[]} tokenBalances - Array of token balances
 * @param {FiatQuoteType[]} fiatQuotes - Array of fiat currency quotes
 * @param {string} networkName - Name of the blockchain network
 * @returns {BalanceInfoType[]} Array of detailed balance information
 */
export function calculateBalances(
  tokenBalances: TokenBalanceType[],
  fiatQuotes: FiatQuoteType[],
  networkName: string
): BalanceInfoType[] {
  return tokenBalances.map(({ symbol, balance, rateUSD }) => {
    const balanceUSD = parseFloat(balance) * rateUSD;
    return {
      network: networkName,
      token: symbol,
      balance: parseFloat(balance),
      balance_conv: {
        USD: balanceUSD,
        UYU: balanceUSD * (fiatQuotes.find((q) => q.currency === 'UYU')?.rate ?? 1),
        ARS: balanceUSD * (fiatQuotes.find((q) => q.currency === 'ARS')?.rate ?? 1),
        BRL: balanceUSD * (fiatQuotes.find((q) => q.currency === 'BRL')?.rate ?? 1)
      }
    };
  });
}

/**
 * Calculates total balances across all currencies
 * @param {BalanceInfoType[]} balances - Array of balance information
 * @returns {Record<CurrencyType, number>} Record of currency totals
 */
export function calculateBalancesTotals(balances: BalanceInfoType[]): Record<CurrencyType, number> {
  return balances.reduce(
    (acc, balance) => {
      (Object.keys(balance.balance_conv) as CurrencyType[]).forEach((currency) => {
        acc[currency] = (acc[currency] || 0) + balance.balance_conv[currency];
      });
      return acc;
    },
    {} as Record<CurrencyType, number>
  );
}

/**
 * Helper function to verify balance in wallet
 * @param {ethers.Contract} tokenContract - Token contract instance
 * @param {string} walletAddress - Wallet address to check
 * @param {string} amountToCheck - Amount to check in wallet
 * @returns {Promise<walletBalanceInfoType>} Wallet balance information
 */
export async function verifyWalletBalance(
  tokenContract: ethers.Contract,
  walletAddress: string,
  amountToCheck: string
): Promise<walletBalanceInfoType> {
  const symbol: string = await tokenContract.symbol();
  Logger.log(
    'verifyWalletBalance',
    `Checking balance for ${walletAddress} and token ${tokenContract.address}, to spend: ${amountToCheck} ${symbol}`
  );
  const walletBalance = await tokenContract.balanceOf(walletAddress);
  const decimals = await tokenContract.decimals();
  const amountToCheckFormatted = ethers.utils.parseUnits(amountToCheck, decimals);
  const walletBalanceFormatted = ethers.utils.formatEther(walletBalance);

  Logger.log(
    'verifyWalletBalance',
    `Balance of wallet ${walletAddress}: ${walletBalanceFormatted} ${symbol}`
  );

  const result: walletBalanceInfoType = {
    walletBalance: walletBalanceFormatted,
    amountToCheck,
    enoughBalance: walletBalance.gte(amountToCheckFormatted)
  };

  return result;
}

/**
 * Helper function to verify balance in wallet by token address
 * @param {IBlockchain} blockchainConfig - Blockchain configuration object
 * @param {string} tokenContractAddress - Token contract address
 * @param {string} walletAddress - Wallet address to check
 * @param {string} amountToCheck - Amount to check in wallet
 * @returns {Promise<walletBalanceInfoType>} Wallet balance information
 */
export async function verifyWalletBalanceByTokenAddress(
  blockchainConfig: IBlockchain,
  tokenContractAddress: string,
  walletAddress: string,
  amountToCheck: string
): Promise<walletBalanceInfoType> {
  const provider = new ethers.providers.JsonRpcProvider(blockchainConfig.rpc);
  const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);
  const tokenContract: ethers.Contract = await setupERC20(tokenContractAddress, backendSigner);
  return verifyWalletBalance(tokenContract, walletAddress, amountToCheck);
}

/**
 * Helper function to verify balance in wallet by token symbol
 * @param {IBlockchain} blockchainConfig - Blockchain configuration object
 * @param {IToken[]} blockchainTokens - Array of blockchain tokens
 * @param {string} tokenSymbol - Symbol of the token
 * @param {string} walletAddress - Wallet address to check
 * @param {string} amountToCheck - Amount to check in wallet
 * @returns {Promise<walletBalanceInfoType>} Wallet balance information
 */
export async function verifyWalletBalanceByTokenSymbol(
  blockchainConfig: IBlockchain,
  blockchainTokens: IToken[],
  tokenSymbol: string,
  walletAddress: string,
  amountToCheck: string
): Promise<walletBalanceInfoType> {
  const provider = new ethers.providers.JsonRpcProvider(blockchainConfig.rpc);
  const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);
  const tokenContractAddress = getTokenAddress(blockchainConfig, blockchainTokens, tokenSymbol);
  const tokenContract: ethers.Contract = await setupERC20(tokenContractAddress, backendSigner);
  return verifyWalletBalance(tokenContract, walletAddress, amountToCheck);
}

/**
 * Helper to check token wallet balance in specific RPC
 * @param {string} rpcUrl - RPC URL of the blockchain network
 * @param {string} tokenAddress - Token contract address
 * @param {string} walletAddress - Wallet address to check
 * @param {string} amountToCheck - Amount to check in wallet
 * @returns {Promise<walletBalanceInfoType>} Wallet balance information
 */
export async function verifyWalletBalanceInRpc(
  rpcUrl: string,
  tokenAddress: string,
  walletAddress: string,
  amountToCheck: string
): Promise<walletBalanceInfoType> {
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const erc20Abi = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)'
  ];

  const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);
  return verifyWalletBalance(tokenContract, walletAddress, amountToCheck);
}

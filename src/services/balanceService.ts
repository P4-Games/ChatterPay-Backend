import { ethers } from 'ethers';
import NodeCache from 'node-cache';

import { IToken } from '../models/tokenModel';
import { getERC20ABI } from './web3/abiService';
import { Logger } from '../helpers/loggerHelper';
import { getTokenAddress } from './blockchainService';
import { IBlockchain } from '../models/blockchainModel';
import { setupERC20 } from './web3/contractSetupService';
import { SIGNING_KEY, BINANCE_API_URL } from '../config/constants';
import {
  Currency,
  FiatQuote,
  TokenInfo,
  BalanceInfo,
  TokenBalance,
  WalletBalanceInfo
} from '../types/commonType';

// Initialize the cache with a 5-minute TTL (Time To Live)
const priceCache = new NodeCache({ stdTTL: 300, checkperiod: 320 });

/**
 * Fetches the balance of a specific token for a given address
 * @param {string} contractAddress - Token contract address
 * @param {ethers.Wallet} signer - Ethereum wallet signer
 * @param {string} address - Address to check balance for
 * @returns {Promise<string>} Token balance as a string
 */
async function getContractBalance(
  contractAddress: string,
  signer: ethers.Wallet,
  address: string
): Promise<string> {
  try {
    const ERC20ABI: ethers.ContractInterface = await getERC20ABI();

    const erc20Contract = new ethers.Contract(contractAddress, ERC20ABI, signer);

    const balance = await erc20Contract.balanceOf(address);
    const decimals = await erc20Contract.decimals();
    return ethers.utils.formatUnits(balance, decimals);
  } catch (error) {
    Logger.error(
      'getContractBalance',
      `Error getting balance: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return '0';
  }
}

/**
 * Fetches token prices from Binance API using USDT pairs
 * @param {string[]} symbols - Array of token symbols to fetch prices for
 * @returns {Promise<Map<string, number>>} Map of token symbols to their USD prices
 */
async function getTokenPrices(symbols: string[]): Promise<Map<string, number>> {
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
          `${BINANCE_API_URL}/ticker/price?symbol=${symbolReplaced}USDT`
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
 * @returns {Promise<TokenInfo[]>} Array of tokens with current price information
 */
async function getTokenInfo(tokens: IToken[], chanId: number): Promise<TokenInfo[]> {
  const chainTokens = tokens.filter((token) => token.chain_id === chanId);
  const symbols = [...new Set(chainTokens.map((token) => token.symbol))];

  const prices = await getTokenPrices(symbols);

  return chainTokens.map((token) => ({
    symbol: token.symbol,
    address: token.address,
    type: token.type,
    rateUSD: prices.get(token.symbol) || 0
  }));
}

/**
 * Fetches token balances for a given address
 * @param {string} address - Address to check balances for
 * @param {IToken[]} tokens - Array of token objects
 * @param {IBlockchain} networkConfig - Blockchain network configuration
 * @returns {Promise<TokenBalance[]>} Array of token balances
 */
export async function getTokenBalances(
  address: string,
  tokens: IToken[],
  networkConfig: IBlockchain
): Promise<TokenBalance[]> {
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
 * @param {TokenBalance[]} tokenBalances - Array of token balances
 * @param {FiatQuote[]} fiatQuotes - Array of fiat currency quotes
 * @param {string} networkName - Name of the blockchain network
 * @returns {BalanceInfo[]} Array of detailed balance information
 */
export function calculateBalances(
  tokenBalances: TokenBalance[],
  fiatQuotes: FiatQuote[],
  networkName: string
): BalanceInfo[] {
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
 * @param {BalanceInfo[]} balances - Array of balance information
 * @returns {Record<Currency, number>} Record of currency totals
 */
export function calculateBalancesTotals(balances: BalanceInfo[]): Record<Currency, number> {
  return balances.reduce(
    (acc, balance) => {
      (Object.keys(balance.balance_conv) as Currency[]).forEach((currency) => {
        acc[currency] = (acc[currency] || 0) + balance.balance_conv[currency];
      });
      return acc;
    },
    {} as Record<Currency, number>
  );
}

/**
 * Helper function to verify balance in wallet
 * @param {ethers.Contract} tokenContract - Token contract instance
 * @param {string} walletAddress - Wallet address to check
 * @param {string} amountToCheck - Amount to check in wallet
 * @returns {Promise<WalletBalanceInfo>} Wallet balance information
 */
export async function verifyWalletBalance(
  tokenContract: ethers.Contract,
  walletAddress: string,
  amountToCheck: string
): Promise<WalletBalanceInfo> {
  const symbol: string = await tokenContract.symbol();
  const decimals = await tokenContract.decimals();

  Logger.log(
    'verifyWalletBalance',
    `Checking balance for ${walletAddress} and token ${tokenContract.address}, to spend: ${amountToCheck} ${symbol}`
  );
  const walletBalance = await tokenContract.balanceOf(walletAddress);
  const amountToCheckFormatted = ethers.utils.parseUnits(amountToCheck, decimals);
  const walletBalanceFormatted = ethers.utils.formatEther(walletBalance);

  Logger.log(
    'verifyWalletBalance',
    `Balance of wallet ${walletAddress}: ${walletBalanceFormatted} ${symbol}`
  );

  const result: WalletBalanceInfo = {
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
 * @returns {Promise<WalletBalanceInfo>} Wallet balance information
 */
export async function verifyWalletBalanceByTokenAddress(
  blockchainConfig: IBlockchain,
  tokenContractAddress: string,
  walletAddress: string,
  amountToCheck: string
): Promise<WalletBalanceInfo> {
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
 * @returns {Promise<WalletBalanceInfo>} Wallet balance information
 */
export async function verifyWalletBalanceByTokenSymbol(
  blockchainConfig: IBlockchain,
  blockchainTokens: IToken[],
  tokenSymbol: string,
  walletAddress: string,
  amountToCheck: string
): Promise<WalletBalanceInfo> {
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
 * @returns {Promise<WalletBalanceInfo>} Wallet balance information
 */
export async function verifyWalletBalanceInRpc(
  rpcUrl: string,
  tokenAddress: string,
  walletAddress: string,
  amountToCheck: string
): Promise<WalletBalanceInfo> {
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

  const ERC20ABI = await getERC20ABI();

  const tokenContract = new ethers.Contract(tokenAddress, ERC20ABI, provider);

  return verifyWalletBalance(tokenContract, walletAddress, amountToCheck);
}

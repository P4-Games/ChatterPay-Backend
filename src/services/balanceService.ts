import { ethers } from 'ethers';

import { secService } from './secService';
import { IToken } from '../models/tokenModel';
import { getERC20ABI } from './web3/abiService';
import { Logger } from '../helpers/loggerHelper';
import { cacheService } from './cache/cacheService';
import { BINANCE_API_URL } from '../config/constants';
import { IBlockchain } from '../models/blockchainModel';
import {
  Currency,
  FiatQuote,
  TokenInfo,
  CacheNames,
  BalanceInfo,
  TokenBalance,
  WalletBalanceInfo
} from '../types/commonType';

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
export async function getTokenPrices(symbols: string[]): Promise<Map<string, number>> {
  const norm = (s: string) => String(s).trim().toUpperCase();
  const priceMap = new Map<string, number>();

  const STABLES: Set<string> = new Set(['USDT', 'USDC', 'DAI', 'AUSDC', 'AUSDT']);
  STABLES.forEach((s) => priceMap.set(s, 1));

  const symbolsToFetch = Array.from(new Set(symbols.map(norm))).filter((s) => !STABLES.has(s));
  if (symbolsToFetch.length === 0) return priceMap;

  try {
    const cachedPrices = Object.fromEntries(
      symbolsToFetch.map((symbol) => [symbol, cacheService.get(CacheNames.PRICE, symbol)])
    );
    const symbolsToFetchFromApi = symbolsToFetch.filter((symbol) => !cachedPrices[symbol]);

    Object.entries(cachedPrices).forEach(([symbol, price]) => {
      if (typeof price === 'number') priceMap.set(symbol, price);
    });

    if (symbolsToFetchFromApi.length === 0) {
      Logger.log('getTokenPrices', 'getting prices from cache!');
      return priceMap;
    }

    // Wrap/unwrap helpers
    const unwrapToken = (symbol: string): string =>
      symbol.replace(/^WETH$/, 'ETH').replace(/^WBTC$/, 'BTC');
    const wrapToken = (symbol: string): string =>
      symbol.replace(/^ETH$/, 'WETH').replace(/^BTC$/, 'WBTC');

    // Fetch to Binance
    await Promise.all(
      symbolsToFetchFromApi.map(async (symbol) => {
        try {
          const unwrapped = unwrapToken(symbol);
          const res = await fetch(`${BINANCE_API_URL}/ticker/price?symbol=${unwrapped}USDT`);
          const data = await res.json();
          const wrapped = wrapToken(unwrapped);

          if (data?.price) {
            const price = parseFloat(data.price);
            Logger.log('getTokenPrices', `Price for ${symbol}: ${price} USDT`);
            priceMap.set(wrapped, price);
            cacheService.set(CacheNames.PRICE, wrapped, price);
          } else {
            Logger.warn('getTokenPrices', `No price found for ${unwrapped}USDT`);
            priceMap.set(wrapped, 0);
          }
        } catch (err) {
          Logger.error('getTokenPrices', `Error fetching price for ${symbol}:`, err);
          priceMap.set(symbol, 0);
        }
      })
    );

    return priceMap;
  } catch (error) {
    Logger.error('getTokenPrices', 'Error fetching token prices from Binance:', error);
    // Consistent fallback: keep stables = 1, the rest = 0, everything normalized
    const out = new Map<string, number>();
    const all = Array.from(new Set(symbols.map(norm)));
    all.forEach((s) => out.set(s, STABLES.has(s) ? 1 : 0));
    return out;
  }
}

/**
 * Gets token information from the global state and current prices
 * @param {IToken[]} tokens - Array of token objects
 * @param {number} chanId - Chain ID to filter tokens
 * @returns {Promise<TokenInfo[]>} Array of tokens with current price information
 */
async function getTokenInfo(tokens: IToken[], chanId: number): Promise<TokenInfo[]> {
  const norm = (s: string) => String(s).trim().toUpperCase();
  const chainTokens = tokens.filter((token) => token.chain_id === chanId);
  const symbols = [...new Set(chainTokens.map((token) => norm(token.symbol)))];
  const prices = await getTokenPrices(symbols);

  return chainTokens.map((token) => ({
    symbol: token.symbol,
    address: token.address,
    type: token.type,
    rateUSD: prices.get(norm(token.symbol)) ?? 0,
    display_decimals: token.display_decimals,
    display_symbol: token.display_symbol,
    operations_limits: token.operations_limits
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
  const bs = secService.get_bs(provider);
  const tokenInfo = await getTokenInfo(tokens, networkConfig.chainId);

  return Promise.all(
    tokenInfo.map(async (token) => {
      const rawBalance = await getContractBalance(token.address, bs, address);

      // Apply display_decimals here, keep as string
      const formattedBalance = parseFloat(rawBalance).toFixed(token.display_decimals);

      return { ...token, balance: formattedBalance };
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
  return tokenBalances.map(({ symbol, address, balance, rateUSD, display_decimals }) => {
    // Cast once for math
    const balanceNum = parseFloat(balance);

    // Round again explicitly with display_decimals before returning
    const roundedBalance = parseFloat(balanceNum.toFixed(display_decimals));
    Logger.debug('calculateBalances', symbol, balance, display_decimals, roundedBalance);

    const balanceUSD = roundedBalance * rateUSD;

    return {
      network: networkName,
      token: symbol,
      tokenAddress: address,
      balance: roundedBalance,
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
 * Merge balances that represent the same asset (on the same network).
 * Uses tokenAddress when present; otherwise falls back to token+network.
 * Sums both the raw balance and each fiat conversion key.
 *
 * @param items List of BalanceInfo entries (potentially with duplicates)
 * @returns Deduplicated list with summed balances
 */
export function mergeSameTokenBalances(items: TokenBalance[]): TokenBalance[] {
  const agg = items.reduce<Record<string, TokenBalance>>((acc, it) => {
    const key = `${it.symbol.toLowerCase()}::${it.address.toLowerCase()}`;
    const prev = acc[key];

    if (!prev) {
      acc[key] = { ...it };
      return acc;
    }

    // sum balances (string → number → string otra vez)
    const nextBalance = (parseFloat(prev.balance) + parseFloat(it.balance)).toFixed(
      it.display_decimals
    );

    acc[key] = { ...prev, balance: nextBalance };
    return acc;
  }, {});

  return Object.values(agg);
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

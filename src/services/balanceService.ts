import { ethers } from 'ethers';
import { BINANCE_API_URL, DEFILLAMA_API_URL } from '../config/constants';
import { getPhoneNFTs } from '../controllers/nftController';
import { Logger } from '../helpers/loggerHelper';
import type { IBlockchain } from '../models/blockchainModel';
import type { IToken } from '../models/tokenModel';
import {
  type AddressBalanceWithNfts,
  type BalanceInfo,
  CacheNames,
  type Currency,
  type FiatQuote,
  type TokenBalance,
  type TokenInfo,
  type WalletBalanceInfo
} from '../types/commonType';
import { cacheService } from './cache/cacheService';
import { getFiatQuotes } from './criptoya/criptoYaService';
import { secService } from './secService';
import { getERC20ABI } from './web3/abiService';
import { getDecimalsCache, getTokenBalancesMulticall } from './web3/multicallService';

const INVALID_TOKEN_ADDRESS_THRESHOLD = ethers.BigNumber.from(1);

function isSkippableTokenContractAddress(address: string): boolean {
  if (!ethers.utils.isAddress(address)) return true;

  try {
    return ethers.BigNumber.from(address).lte(INVALID_TOKEN_ADDRESS_THRESHOLD);
  } catch {
    return true;
  }
}

/**
 * Maps chain IDs to DefiLlama chain prefixes
 * @param {number} chainId - Chain ID
 * @returns {string} DefiLlama chain prefix
 */
function getDefiLlamaChainPrefix(chainId: number): string {
  const chainMap: Record<number, string> = {
    1: 'ethereum',
    56: 'bsc',
    137: 'polygon',
    42161: 'arbitrum',
    10: 'optimism',
    534352: 'scroll',
    8453: 'base'
  };
  return chainMap[chainId] || 'scroll';
}

/**
 * Fetches token prices from DefiLlama API using contract addresses
 * @param {Map<string, string>} tokenAddresses - Map of token symbols to contract addresses
 * @param {number} chainId - Chain ID for the blockchain network
 * @returns {Promise<Map<string, number>>} Map of token symbols to their USD prices
 */
async function getPricesFromDefiLlama(
  tokenAddresses: Map<string, string>,
  chainId: number
): Promise<Map<string, number>> {
  const priceMap = new Map<string, number>();

  if (tokenAddresses.size === 0) return priceMap;

  try {
    const chainPrefix = getDefiLlamaChainPrefix(chainId);
    const coins = Array.from(tokenAddresses.entries())
      .map(([_, address]) => `${chainPrefix}:${address}`)
      .join(',');

    const url = `${DEFILLAMA_API_URL}/${coins}`;
    Logger.log('getPricesFromDefiLlama', `Fetching prices from DefiLlama: ${url}`);

    const res = await fetch(url);
    const data = await res.json();

    if (data?.coins) {
      tokenAddresses.forEach((address, symbol) => {
        const key = `${chainPrefix}:${address}`;
        const coinData = data.coins[key];
        if (coinData?.price) {
          const price = parseFloat(coinData.price);
          Logger.log('getPricesFromDefiLlama', `Price for ${symbol}: ${price} USD (DefiLlama)`);
          priceMap.set(symbol, price);
        }
      });
    }

    return priceMap;
  } catch (error) {
    Logger.error('getPricesFromDefiLlama', 'Error fetching prices from DefiLlama:', error);
    return priceMap;
  }
}

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
 * Fetches token prices from Binance API using USDT pairs, with DefiLlama fallback
 * @param {string[]} symbols - Array of token symbols to fetch prices for
 * @param {Map<string, string>} tokenAddresses - Map of token symbols to contract addresses
 * @param {number} chainId - Chain ID for DefiLlama fallback
 * @returns {Promise<Map<string, number>>} Map of token symbols to their USD prices
 */
export async function getTokenPrices(
  symbols: string[],
  tokenAddresses: Map<string, string> = new Map(),
  chainId: number = 1
): Promise<Map<string, number>> {
  const norm = (s: string) => String(s).trim().toUpperCase();
  const priceMap = new Map<string, number>();

  const STABLES: Set<string> = new Set([
    'AUSDC',
    'AUSDT',
    'DAI',
    'SUSX',
    'USDC',
    'USDQ',
    'USDT',
    'USX'
  ]);
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

    // DefiLlama fallback for tokens that failed to fetch from Binance
    const failedTokens = new Map<string, string>();
    symbolsToFetchFromApi.forEach((symbol) => {
      if (!priceMap.has(symbol) || priceMap.get(symbol) === 0) {
        const address = tokenAddresses.get(symbol);
        if (address) {
          failedTokens.set(symbol, address);
        }
      }
    });

    if (failedTokens.size > 0) {
      Logger.log('getTokenPrices', `Attempting DefiLlama fallback for ${failedTokens.size} tokens`);
      const defiLlamaPrices = await getPricesFromDefiLlama(failedTokens, chainId);
      defiLlamaPrices.forEach((price, symbol) => {
        priceMap.set(symbol, price);
        cacheService.set(CacheNames.PRICE, symbol, price);
      });
    }

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
  const priceEligibleTokens = chainTokens.filter(
    (token) => !isSkippableTokenContractAddress(token.address)
  );
  const symbols = [...new Set(priceEligibleTokens.map((token) => norm(token.symbol)))];

  // Build address map for DefiLlama fallback
  const tokenAddresses = new Map<string, string>();
  priceEligibleTokens.forEach((token) => {
    tokenAddresses.set(norm(token.symbol), token.address);
  });

  const prices = await getTokenPrices(symbols, tokenAddresses, chanId);

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
 * Fetches token balances for a given address using Multicall for efficiency
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
  const tokenInfo = await getTokenInfo(tokens, networkConfig.chainId);
  const validTokenInfo = tokenInfo.filter(
    (token) => !isSkippableTokenContractAddress(token.address)
  );
  const invalidTokenInfo = tokenInfo.filter((token) =>
    isSkippableTokenContractAddress(token.address)
  );

  if (invalidTokenInfo.length > 0) {
    Logger.warn(
      'getTokenBalances',
      `Skipping ${invalidTokenInfo.length} token(s) with invalid/non-contract addresses: ${invalidTokenInfo
        .map((token) => `${token.symbol} (${token.address})`)
        .join(', ')}`
    );
  }

  try {
    const tokenAddresses = validTokenInfo.map((t) => t.address);

    if (tokenAddresses.length === 0) {
      return invalidTokenInfo.map((token) => ({
        ...token,
        balance: parseFloat('0').toFixed(token.display_decimals)
      }));
    }

    // Preload decimals cache from token metadata (if available)
    const cachedDecimals = getDecimalsCache();
    validTokenInfo.forEach((token) => {
      // Try to use decimals from token metadata if available
      const key = token.address.toLowerCase();
      if (!cachedDecimals.has(key)) {
        // We'll let multicall fetch it, but we could also infer from display_decimals
        // For now, multicall will handle it
      }
    });

    const startTime = Date.now();
    const multicallResults = await getTokenBalancesMulticall(
      provider,
      address,
      tokenAddresses,
      cachedDecimals
    );
    const elapsed = Date.now() - startTime;

    Logger.log(
      'getTokenBalances',
      `Multicall completed in ${elapsed}ms for ${tokenAddresses.length} tokens`
    );

    const resultByAddress = new Map(
      multicallResults.map((result) => [result.tokenAddress.toLowerCase(), result])
    );

    // Map multicall results back to original token order
    return tokenInfo.map((token) => {
      if (isSkippableTokenContractAddress(token.address)) {
        return {
          ...token,
          balance: parseFloat('0').toFixed(token.display_decimals)
        };
      }

      const result = resultByAddress.get(token.address.toLowerCase());
      if (!result || !result.success) {
        Logger.warn(
          'getTokenBalances',
          `Failed to get balance for ${token.symbol} (${token.address}): ${result?.error || 'Unknown error'}`
        );
        return {
          ...token,
          balance: parseFloat('0').toFixed(token.display_decimals)
        };
      }

      const formattedBalance = parseFloat(result.balance).toFixed(token.display_decimals);
      return { ...token, balance: formattedBalance };
    });
  } catch (error) {
    // Fallback to individual calls if multicall fails
    Logger.error('getTokenBalances', 'Multicall failed, falling back to individual calls:', error);

    const bs = secService.get_bs(provider);
    return Promise.all(
      tokenInfo.map(async (token) => {
        if (isSkippableTokenContractAddress(token.address)) {
          return { ...token, balance: parseFloat('0').toFixed(token.display_decimals) };
        }

        const rawBalance = await getContractBalance(token.address, bs, address);
        const formattedBalance = parseFloat(rawBalance).toFixed(token.display_decimals);
        return { ...token, balance: formattedBalance };
      })
    );
  }
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

/**
 * Fetches and calculates balance information for a given address.
 * @param phoneNumber - Optional phone number used to fetch user-bound NFTs
 * @param proxyAddress - Address to get balance for
 * @param eoaAddress - Externally Owned Account address
 * @param reply - Fastify reply object
 * @param networkConfig - Fastify blockchain network configuration
 * @param tokens - Token metadata list for the target network
 * @returns Plain data object with balances, totals, certificates and wallets
 */

export async function getAddressBalanceWithNfts(
  phoneNumber: string | null,
  proxyAddress: string,
  eoaAddress: string,
  networkConfig: IBlockchain,
  tokens: IToken[]
): Promise<AddressBalanceWithNfts> {
  const eoaProvided =
    !!eoaAddress &&
    eoaAddress.trim().length > 0 &&
    eoaAddress.toLowerCase() !== proxyAddress.toLowerCase();

  Logger.log(
    'getAddressBalanceWithNfts',
    `Fetching balances for proxy ${proxyAddress}${eoaProvided ? ` + eoa ${eoaAddress}` : ''} on network ${networkConfig.name}`
  );

  try {
    const [fiatQuotes, proxyTokenBalances, eoaTokenBalances, NFTs] = await Promise.all([
      getFiatQuotes(),
      getTokenBalances(proxyAddress, tokens, networkConfig),
      eoaProvided ? getTokenBalances(eoaAddress, tokens, networkConfig) : Promise.resolve([]),
      phoneNumber ? getPhoneNFTs(phoneNumber) : Promise.resolve({ nfts: [] })
    ]);

    //  Combine raw token balances
    const combinedTokenBalances = eoaProvided
      ? [...proxyTokenBalances, ...eoaTokenBalances]
      : proxyTokenBalances;

    //  Merge duplicates BEFORE calculating balances
    const mergedTokenBalances = mergeSameTokenBalances(combinedTokenBalances);

    //  Now calculate balances with fiat conversions
    const balancesWithZero: BalanceInfo[] = calculateBalances(
      mergedTokenBalances,
      fiatQuotes,
      networkConfig.name
    );
    const balances = balancesWithZero.filter((balance) => balance.balance > 0);

    // Totals
    const totals: Record<Currency, number> = calculateBalancesTotals(balances);

    const response: AddressBalanceWithNfts = {
      balances,
      totals,
      certificates: NFTs.nfts,
      wallets: eoaProvided ? [proxyAddress, eoaAddress] : [proxyAddress]
    };

    return response;
  } catch (error) {
    Logger.error('getAddressBalanceWithNfts', `Error: ${(error as Error).message}`);
    const emptyTotals: Record<Currency, number> = {} as Record<Currency, number>;
    return {
      balances: [],
      totals: emptyTotals,
      certificates: [],
      wallets: eoaProvided ? [proxyAddress, eoaAddress] : [proxyAddress]
    };
  }
}

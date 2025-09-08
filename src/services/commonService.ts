import { ethers, BigNumber, ContractInterface } from 'ethers';

import { Logger } from '../helpers/loggerHelper';
import { CacheNames } from '../types/commonType';
import { cacheService } from './cache/cacheService';
import { getERC20ABI, getChatterpayABI } from './web3/abiService';

const norm = (addr: string) => addr.toLowerCase();

/**
 * Retrieves the fee amount for a given token from the ChatterPay contract.
 *
 * @param ChatterpayContractAddress - The address of the ChatterPay contract.
 * @param provider - An ethers.js provider to interact with the blockchain.
 * @param tokenAddress - The address of the token to calculate the fee for.
 * @returns A Promise resolving to the fee amount in human-readable token units (e.g. 0.0002 WETH).
 *          If an error occurs, it logs the error and returns 0.
 */
export async function getChatterpayTokenFee(
  ChatterpayContractAddress: string,
  provider: ethers.providers.JsonRpcProvider,
  tokenAddress: string
): Promise<number> {
  try {
    const abi = await getChatterpayABI();
    const chatterPayContract = new ethers.Contract(ChatterpayContractAddress, abi, provider);

    // Call the smart contract to get the raw fee in token units
    const chatterpayFee: BigNumber = await chatterPayContract.getTokenFee(tokenAddress);

    // Get the token's decimals to convert from raw units to human-readable format
    const ERC20ABI: ethers.ContractInterface = await getERC20ABI();
    const tokenContract = new ethers.Contract(tokenAddress, ERC20ABI, provider);
    const decimals: number = await tokenContract.decimals();

    // Convert the fee from raw units (wei, etc.) to whole units (e.g., 0.0002)
    const feeInWholeUnits: number = parseFloat(ethers.utils.formatUnits(chatterpayFee, decimals));
    Logger.debug(
      'getChatterpayTokenFee',
      `chatterpay token ${tokenAddress}, calculated fee ${feeInWholeUnits}`
    );
    return feeInWholeUnits;
  } catch (error) {
    // Avoid interruption due to error
    Logger.error('getChatterpayTokenFee', 'Error getting ChatterPay fee:', error);
    return 0;
  }
}

export async function getTokenDecimals(
  tokenAddress: string,
  erc20ABI: ContractInterface,
  provider: ethers.providers.Provider,
  logKey: string
): Promise<number> {
  const cacheKey = `ERC20:decimals:${norm(tokenAddress)}`;
  const fromCache = cacheService.get<number>(CacheNames.ERC20, cacheKey);

  if (fromCache) {
    Logger.debug('getTokenDecimals', logKey, `cache hit: ${tokenAddress} -> ${fromCache}`);
    return fromCache;
  }

  Logger.debug('getTokenDecimals', logKey, `cache miss: ${tokenAddress}, fetching on-chain`);
  const token = new ethers.Contract(tokenAddress, erc20ABI, provider);
  const decimals: number = await token.decimals();

  cacheService.set<number>(CacheNames.ERC20, cacheKey, decimals);
  Logger.debug('getTokenDecimals', logKey, `fetched & cached: ${tokenAddress} -> ${decimals}`);
  return decimals;
}

export async function getTokenSymbol(
  tokenAddress: string,
  erc20ABI: ContractInterface,
  provider: ethers.providers.Provider,
  logKey: string
): Promise<string> {
  const cacheKey = `ERC20:symbol:${norm(tokenAddress)}`;
  const fromCache = cacheService.get<string>(CacheNames.ERC20, cacheKey);

  if (fromCache) {
    Logger.debug('getTokenSymbol', logKey, `cache hit: ${tokenAddress} -> ${fromCache}`);
    return fromCache;
  }

  Logger.debug('getTokenSymbol', logKey, `cache miss: ${tokenAddress}, fetching on-chain`);
  const token = new ethers.Contract(tokenAddress, erc20ABI, provider);
  const symbol: string = await token.symbol();

  cacheService.set<string>(CacheNames.ERC20, cacheKey, symbol);
  Logger.debug('getTokenSymbol', logKey, `fetched & cached: ${tokenAddress} -> ${symbol}`);
  return symbol;
}

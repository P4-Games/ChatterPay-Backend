import type { ethers } from 'ethers';
import * as fs from 'fs-extra';
import path from 'path';
import { ABIS_READ_FROM, GCP_ABIs, LOCAL_ABIs } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import { CacheNames } from '../../types/commonType';
import { cacheService } from '../cache/cacheService';
import { getGcpFile } from '../gcp/gcpService';

export type ABI = ethers.ContractInterface;

const abisReadFromLocal = ABIS_READ_FROM === 'local';

/**
 * Retrieves a local ABI file.
 *
 * @param {string} urlFile - The name of the ABI file to retrieve.
 * @returns {Promise<ABI>} The ABI object obtained from the local file system.
 * @throws Throws an error if the local file cannot be retrieved.
 */
export const getLocalABIFile = async (urlFile: string): Promise<ABI> => {
  try {
    const filePath = path.resolve(__dirname, 'abis', urlFile);
    Logger.log('getLocalABIFile', 'Looking for file in:', filePath);

    if (!fs.existsSync(filePath)) {
      throw new Error(`The file does not exist at path: ${filePath}`);
    }

    const { abi } = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return abi;
  } catch (error) {
    Logger.error('getLocalABIFile', urlFile, (error as Error).message);
    throw new Error('Error retrieving local ABI file');
  }
};

/**
 * Retrieves an ABI file from cache or fetches it (from local or GCP).
 *
 * @param {string} contractKeyName - The name of the ABI file to retrieve.
 * @returns {Promise<ABI>} The retrieved ABI object.
 */
export const getFile = async (contractKeyName: string): Promise<ABI> => {
  const source = abisReadFromLocal ? 'LOCAL' : 'GCP';
  const filePath = abisReadFromLocal ? LOCAL_ABIs[contractKeyName] : GCP_ABIs[contractKeyName];

  if (!filePath) {
    throw new Error(`ABI path not found for key "${contractKeyName}" in ${source}_ABIs`);
  }

  const cacheKey = filePath;

  // First try a direct cache HIT (short log). If it's a MISS, getOrLoad will log the MISS itself.
  const hit = cacheService.get<ABI>(CacheNames.ABI, cacheKey);
  if (hit) {
    Logger.log('ABI:getFile', `CACHE HIT key=${cacheKey}`);
    return hit;
  }

  const abi = await cacheService.getOrLoad<ABI>(CacheNames.ABI, cacheKey, async () => {
    Logger.log('ABI:getFile', `CACHE MISS key=${cacheKey} — loading from ${source}...`);
    if (abisReadFromLocal) {
      return getLocalABIFile(filePath);
    }

    const remote = (await getGcpFile(filePath)) as { abi: ABI };
    if (!remote || !remote.abi) {
      throw new Error(`Invalid ABI file format at ${filePath}`);
    }
    return remote.abi;
  });

  return abi;
};

/**
 * Retrieves the ERC20 ABI.
 *
 * @returns {Promise<ABI>} The ERC20 ABI object.
 */
export const getERC20ABI = async (): Promise<ABI> => getFile('ERC20');

/**
 * Retrieves the ChatterPay NFT ABI.
 *
 * @returns {Promise<ABI>} The ChatterPay NFT ABI object.
 */
export const getChatterPayNFTABI = async (): Promise<ABI> => getFile('ChatterPayNFT');

/**
 * Retrieves the ChatterPay Wallet ABI.
 *
 * @returns {Promise<ABI>} The ChatterPay Wallet ABI object.
 */
export const getChatterPayWalletProxyABI = async (): Promise<ABI> =>
  getFile('ChatterPayWalletProxy');

/**
 * Retrieves the ChatterPay Wallet Factory ABI.
 *
 * @returns {Promise<ABI>} The ChatterPay Wallet Factory ABI object.
 */
export const getChatterPayWalletFactoryABI = async (): Promise<ABI> =>
  getFile('ChatterPayWalletFactory');

/**
 * Retrieves the EntryPoint ABI.
 *
 * @returns {Promise<ABI>} The EntryPoint ABI object.
 */
export const getEntryPointABI = async (): Promise<ABI> => getFile('EntryPoint');

/**
 * Retrieves the ChatterPay ABI.
 *
 * @returns {Promise<ABI>} The ChatterPay ABI object.
 */
export const getChatterpayABI = async (): Promise<ABI> => getFile('ChatterPay');

/**
 * Retrieves the Chailink Price Feed ABI.
 *
 * @returns {Promise<ABI>} The Chailink Price Feed ABI object.
 */
export const getChainlinkPriceFeedABI = async (): Promise<ABI> => getFile('ChainlinkPriceFeed');

/**
 * Retrieves the Uniswap Quoter V2 ABI.
 *
 * @returns {Promise<ABI>} The Uniswap Quoter V2 ABI object.
 */
export const getUniswapQuoterV2ABI = async (): Promise<ABI> => getFile('UniswapQuoterV2');

/**
 * Retrieves the Uniswap Router 02 ABI.
 *
 * @returns {Promise<ABI>} The Uniswap Router 02 ABI object.
 */
export const getUniswapRouter02ABI = async (): Promise<ABI> => getFile('UniswapRouter02');

import path from 'path';
import * as fs from 'fs-extra';
import { ethers } from 'ethers';
import NodeCache from 'node-cache';

import { getGcpFile } from '../gcp/gcpService';
import { Logger } from '../../helpers/loggerHelper';
import { GCP_ABIs, LOCAL_ABIs, ABIS_READ_FROM } from '../../config/constants';

export type ABI = ethers.ContractInterface;

const cache = new NodeCache({ stdTTL: 86400 });
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
  const filePath = abisReadFromLocal ? LOCAL_ABIs[contractKeyName] : GCP_ABIs[contractKeyName];
  let abi = cache.get<ABI>(filePath);

  if (!abi) {
    // Select the appropriate function based on the source (local or GCP)
    abi = abisReadFromLocal
      ? await getLocalABIFile(filePath)
      : ((await getGcpFile(filePath)) as ethers.ContractInterface);
    cache.set(filePath, abi);
  }

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

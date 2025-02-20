import axios from 'axios';
import { ethers } from 'ethers';
import NodeCache from 'node-cache';

import { GCP_ABIs } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';

export type ABI = ethers.ContractInterface;

// Initialize the cache
const cache = new NodeCache({ stdTTL: 3600 });

/**
 * Retrieves a file from the GCP bucket.
 *
 * @param {string} urlFile - The URL of the file in the GCP bucket.
 * @returns {Promise<ABI>} The ABI object retrieved from the GCP bucket.
 * @throws Will throw an error if the file cannot be retrieved.
 */
export const getGcpFile = async (urlFile: string): Promise<ABI> => {
  try {
    const response = await axios.get(urlFile);
    return response.data;
  } catch (error) {
    Logger.error('getGcpFile', error);
    throw new Error('Error al obtener el archivo desde GCP');
  }
};

/**
 * Retrieves an ABI file from the cache or fetches it from the GCP bucket if not cached.
 *
 * @param {string} fileName - The name of the ABI file to retrieve.
 * @returns {Promise<ABI>} The ABI object retrieved from the cache or GCP bucket.
 */
export const getFile = async (fileName: string): Promise<ABI> => {
  let abi = cache.get<ABI>(fileName);

  if (!abi) {
    abi = await getGcpFile(fileName);
    cache.set(fileName, abi);
  }

  return abi;
};

/**
 * Retrieves the ERC20 ABI from the GCP bucket.
 *
 * @returns {Promise<ABI>} The ERC20 ABI object.
 */
export const getERC20ABI = async (): Promise<ABI> => getFile(GCP_ABIs.ERC20);

/**
 * Retrieves the ChatterPay NFT ABI from the GCP bucket.
 *
 * @returns {Promise<ABI>} The ChatterPay NFT ABI object.
 */
export const getChatterPayNFTABI = async (): Promise<ABI> => getFile(GCP_ABIs.ChatterPayNFT);

/**
 * Retrieves the ChatterPay Wallet ABI from the GCP bucket.
 *
 * @returns {Promise<ABI>} The ChatterPay Wallet ABI object.
 */
export const getChatterPayWalletABI = async (): Promise<ABI> => getFile(GCP_ABIs.ChatterPayWallet);

/**
 * Retrieves the ChatterPay Wallet Factory ABI from the GCP bucket.
 *
 * @returns {Promise<ABI>} The ChatterPay Wallet Factory ABI object.
 */
export const getChatterPayWalletFactoryABI = async (): Promise<ABI> =>
  getFile(GCP_ABIs.ChatterPayWalletFactory);

/**
 * Retrieves the EntryPoint ABI from the GCP bucket.
 *
 * @returns {Promise<ABI>} The EntryPoint ABI object.
 */
export const getEntryPointABI = async (): Promise<ABI> => getFile(GCP_ABIs.EntryPoint);

/**
 * Retrieves the ChatterPay ABI from the GCP bucket.
 *
 * @returns {Promise<ABI>} The ChatterPay ABI object.
 */
export const getChatterpayABI = async (): Promise<ABI> => getFile(GCP_ABIs.ChatterPay);

/**
 * Retrieves the Chainlink ABI from the GCP bucket.
 *
 * @returns {Promise<ABI>} The ChatterPay ABI object.
 */
export const getPriceFeedABI = async (): Promise<ABI> => getFile(GCP_ABIs.ChainlinkPriceFeed);

import * as fs from "fs-extra"
import { ethers } from 'ethers';
import NodeCache from 'node-cache';

import { LOCAL_ABIs } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import path from "path";

export type ABI = ethers.ContractInterface;

// Initialize the cache
const cache = new NodeCache({ stdTTL: 1 });

/**
 * Retrieves a file from the GCP bucket.
 *
 * @param {string} urlFile - The URL of the file in the GCP bucket.
 * @returns {Promise<ABI>} The ABI object retrieved from the GCP bucket.
 * @throws Will throw an error if the file cannot be retrieved.
 */
export const getLocalABIFile = async (urlFile: string): Promise<ABI> => {
  try {
    const filePath = path.resolve(__dirname, "out", urlFile);

    Logger.log("getLocalABIFile", "Buscando archivo en:", filePath);

    if (!fs.existsSync(filePath)) {
      throw new Error(`El archivo no existe en la ruta: ${filePath}`);
    }

    const { abi } = JSON.parse(fs.readFileSync(filePath, "utf8"));

    return abi
  } catch (error) {
    Logger.error('getLocalABIFile', urlFile, (error as Error).message);
    throw new Error('Error getting local ABI file');
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
    abi = await getLocalABIFile(fileName);
    cache.set(fileName, abi);
  }

  return abi;
};

/**
 * Retrieves the ERC20 ABI from the GCP bucket.
 *
 * @returns {Promise<ABI>} The ERC20 ABI object.
 */
export const getERC20ABI = async (): Promise<ABI> => getFile(LOCAL_ABIs.ERC20);

/**
 * Retrieves the ChatterPay NFT ABI from the GCP bucket.
 *
 * @returns {Promise<ABI>} The ChatterPay NFT ABI object.
 */
export const getChatterPayNFTABI = async (): Promise<ABI> => getFile(LOCAL_ABIs.ChatterPayNFT);

/**
 * Retrieves the ChatterPay Wallet ABI from the GCP bucket.
 *
 * @returns {Promise<ABI>} The ChatterPay Wallet ABI object.
 */
export const getChatterPayWalletABI = async (): Promise<ABI> => getFile(LOCAL_ABIs.ChatterPayWallet);

/**
 * Retrieves the ChatterPay Wallet Factory ABI from the GCP bucket.
 *
 * @returns {Promise<ABI>} The ChatterPay Wallet Factory ABI object.
 */
export const getChatterPayWalletFactoryABI = async (): Promise<ABI> =>
  getFile(LOCAL_ABIs.ChatterPayWalletFactory);

/**
 * Retrieves the EntryPoint ABI from the GCP bucket.
 *
 * @returns {Promise<ABI>} The EntryPoint ABI object.
 */
export const getEntryPointABI = async (): Promise<ABI> => getFile(LOCAL_ABIs.EntryPoint);

/**
 * Retrieves the ChatterPay ABI from the GCP bucket.
 *
 * @returns {Promise<ABI>} The ChatterPay ABI object.
 */
export const getChatterpayABI = async (): Promise<ABI> => getFile(LOCAL_ABIs.ChatterPay);

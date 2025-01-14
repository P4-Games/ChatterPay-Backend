import axios from 'axios';
import { ethers } from 'ethers';
import NodeCache from 'node-cache';

import { GCP_ABIs } from '../config/constants';
import { Logger } from '../helpers/loggerHelper';

export type ABI = ethers.ContractInterface;

// Initialize the cache
const cache = new NodeCache({ stdTTL: 3600 });

// Function to get file from the GCP bucket
export const getGcpFile = async (urlFile: string): Promise<ABI> => {
  try {
    const response = await axios.get(urlFile);
    return response.data;
  } catch (error) {
    Logger.error('getGcpFile', error);
    throw new Error('Error al obtener el archivo desde GCP');
  }
};

// Function to read the ABI file from cache
export const getFile = async (fileName: string): Promise<ABI> => {
  let abi = cache.get<ABI>(fileName);

  if (!abi) {
    abi = await getGcpFile(fileName);
    cache.set(fileName, abi);
  }

  return abi;
};

// Function to get ERC20 ABI from the GCP bucket
export const getERC20ABI = async (): Promise<ABI> => getFile(GCP_ABIs.ERC20);

// Function to get ChatterPay NFT ABI from the GCP bucket
export const getChatterPayNFTABI = async (): Promise<ABI> => getFile(GCP_ABIs.ChatterPayNFT);

// Function to get ChatterPay Wallet ABI from the GCP bucket
export const getChatterPayWalletABI = async (): Promise<ABI> => getFile(GCP_ABIs.ChatterPayWallet);

// Function to get ChatterPay Wallet Factory ABI from the GCP bucket
export const getChatterPayWalletFactoryABI = async (): Promise<ABI> =>
  getFile(GCP_ABIs.ChatterPayWalletFactory);

// Function to get EntryPoint ABI from the GCP bucket
export const getEntryPointABI = async (): Promise<ABI> => getFile(GCP_ABIs.EntryPoint);

// Function to get chatterpay ABI from the GCP bucket
export const getChatterpayABI = async (): Promise<ABI> => getFile(GCP_ABIs.ChatterPay);

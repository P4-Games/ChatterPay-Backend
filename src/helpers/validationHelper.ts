import { ethers } from 'ethers';

/**
 * Function that validates if a given input is a phone number
 *
 * @param input
 * @returns
 */
export function isValidPhoneNumber(number: string): boolean {
  return /^\d{8,15}$/.test(number);
}

/**
 * VAlidate if an strin is valid url
 * @param url
 * @returns
 */
export const isValidUrl = (url: string): boolean => {
  const urlPattern = /^(https?:\/\/)?([\w-]+\.)+[\w-]+(\/[\w- ./?%&=]*)?$/;
  return urlPattern.test(url);
};

export const isValidEthereumWallet = (address: string): boolean => ethers.utils.isAddress(address);

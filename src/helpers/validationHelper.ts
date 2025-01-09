import { ethers } from 'ethers';

/**
 * Function that validates if a given input is a phone number
 *
 * @param input
 * @returns
 */
export function isValidPhoneNumber(number: string): boolean {
  // Keep only numeric characters
  const cleanedNumber = number.replace(/\D/g, '');

  // Validate the cleaned number
  return /^\d{8,15}$/.test(cleanedNumber);
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

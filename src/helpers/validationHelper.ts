import { ethers } from 'ethers';

import { short_urls_domains } from '../config/shortUrlsDomains.json';

/**
 * Function that validates if a given input is a valid phone number.
 *
 * This function cleans the input by removing all non-numeric characters
 * and then checks if the remaining string has between 8 and 15 digits.
 *
 * @param number - The phone number string to be validated.
 * @returns `true` if the input is a valid phone number, `false` otherwise.
 */
export function isValidPhoneNumber(number: string): boolean {
  // Keep only numeric characters
  const cleanedNumber = number.replace(/\D/g, '');

  // Validate the cleaned number
  return /^\d{8,15}$/.test(cleanedNumber);
}

/**
 * Validates if a given string is a valid URL.
 *
 * This function uses a regular expression to check if the provided string
 * matches the typical structure of a valid URL, including the optional
 * "http" or "https" scheme and domain name.
 *
 * @param url - The URL string to be validated.
 * @returns `true` if the string is a valid URL, `false` otherwise.
 */
export const isValidUrl = (url: string): boolean => {
  const urlPattern = /^(https?:\/\/)?([\w-]+\.)+[\w-]+(\/[\w- ./?%&=]*)?$/;
  return urlPattern.test(url);
};

/**
 * Checks if a given URL is a short URL by comparing it with a predefined list.
 *
 * This function takes a URL string as input and checks whether it exists in the
 * `SHORT_URLS` array. If the URL is found in the array, it is considered a short URL.
 *
 * @param url - The URL string to be checked.
 * @returns `true` if the URL is a short URL, `false` otherwise.
 */
export const isShortUrl = (url: string): boolean =>
  short_urls_domains.some((domain) => new URL(url).hostname.includes(domain));

/**
 * Validates if a given string is a valid Ethereum wallet address.
 *
 * This function uses the `ethers.utils.isAddress` method to check whether
 * the provided string is a valid Ethereum address.
 *
 * @param address - The Ethereum wallet address string to be validated.
 * @returns `true` if the string is a valid Ethereum address, `false` otherwise.
 */
export const isValidEthereumWallet = (address: string): boolean => ethers.utils.isAddress(address);

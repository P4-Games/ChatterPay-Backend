import axios, { type AxiosResponse } from 'axios';
import { ethers } from 'ethers';

import { short_urls_domains } from '../config/shortUrlsDomains.json';

/**
 * Function that validates if a given input is a valid phone number.
 *
 * This function cleans the input by removing all non-numeric characters
 * and then checks if the remaining string has between 8 and 15 digits.
 *
 * @param number - The phone number to be validated. Anything not a string is invalid.
 * @returns `true` if the input is a valid phone number, `false` otherwise.
 */
export function isValidPhoneNumber(number: unknown): boolean {
  if (typeof number !== 'string') {
    return false;
  }

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

const normalizeUrlForParsing = (url: string): string => {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `https://${url}`;
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
export const isShortUrl = (url: string): boolean => {
  let hostname = '';
  try {
    hostname = new URL(normalizeUrlForParsing(url)).hostname.toLowerCase();
  } catch {
    return false;
  }

  const cleanHost = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  return short_urls_domains.some(
    (domain) => cleanHost === domain || cleanHost.endsWith(`.${domain}`)
  );
};

const getRedirectInfo = (response: unknown): { finalUrl: string; redirectCount: number } => {
  const anyResponse = response as {
    request?: {
      _redirectable?: { _redirectCount?: number };
      res?: { responseUrl?: string };
    };
  };

  return {
    finalUrl: anyResponse.request?.res?.responseUrl ?? '',
    redirectCount: anyResponse.request?._redirectable?._redirectCount ?? 0
  };
};

const isNonImageContentType = (contentType?: string | string[]): boolean => {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  if (!value) {
    return false;
  }
  return !value.toLowerCase().startsWith('image/');
};

/**
 * Reason why an image URL cannot be used.
 *
 * - `short_url`: the URL belongs to a known shortener, or resolves to a different host.
 * - `not_accessible`: the URL does not answer with a downloadable image.
 */
export type ImageUrlRejection = 'short_url' | 'not_accessible';

/**
 * Checks whether an image URL can be used, resolving redirects to catch
 * shorteners that are not present in the static list.
 *
 * A redirect landing on a different host is treated as a shortener. Anything
 * else that prevents downloading the image (4xx/5xx, or a response that is not
 * an image) is reported separately, so the caller can tell the user what really
 * happened instead of blaming a shortener.
 *
 * @param url - The URL string to be checked.
 * @returns The rejection reason, or `null` if the URL looks usable.
 */
export const checkImageUrl = async (url: string): Promise<ImageUrlRejection | null> => {
  if (isShortUrl(url)) {
    return 'short_url';
  }

  let originalHost = '';
  const normalizedUrl = normalizeUrlForParsing(url);
  try {
    originalHost = new URL(normalizedUrl).hostname.toLowerCase();
  } catch {
    return null;
  }

  const checkResponse = async (response: AxiosResponse): Promise<ImageUrlRejection | null> => {
    const { finalUrl, redirectCount } = getRedirectInfo(response);
    if (finalUrl) {
      try {
        const finalHost = new URL(finalUrl).hostname.toLowerCase();
        if (redirectCount > 0 && finalHost !== originalHost) {
          return 'short_url';
        }
      } catch {
        return 'not_accessible';
      }
    }

    const contentTypeHeader = response.headers?.['content-type'] as string | string[] | undefined;
    if (isNonImageContentType(contentTypeHeader)) {
      return 'not_accessible';
    }

    if (response.status >= 400) {
      return 'not_accessible';
    }
    return null;
  };

  try {
    const headResponse = await axios.head(normalizedUrl, {
      maxRedirects: 5,
      timeout: 4000,
      validateStatus: () => true
    });
    if (headResponse.status !== 405) {
      return await checkResponse(headResponse);
    }
  } catch {
    // Fall through to GET check
  }

  try {
    const getResponse = await axios.get(normalizedUrl, {
      maxRedirects: 5,
      timeout: 4000,
      responseType: 'stream',
      validateStatus: () => true
    });
    if (getResponse.data?.destroy) {
      getResponse.data.destroy();
    }
    return await checkResponse(getResponse);
  } catch {
    return null;
  }
};

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

/**
 * Normalizes an Ethereum address to lowercase with 0x prefix
 * @param addr - The address to normalize
 * @returns The normalized address
 */
export const normalizeWalletAddress = (addr: string): string => {
  const clean = addr.trim().toLowerCase();
  if (!ethers.utils.isAddress(clean)) {
    throw new Error(`Invalid Ethereum address: ${addr}`);
  }
  return ethers.utils.getAddress(clean);
};

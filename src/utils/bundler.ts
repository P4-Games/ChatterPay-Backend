import { ethers } from 'ethers';

import { Logger } from './logger';

/**
 * Validate Bundle Url
 * @param url
 * @returns
 */
export async function validateBundlerUrl(url: string): Promise<boolean> {
  try {
    const provider = new ethers.providers.JsonRpcProvider(url);
    await provider.getNetwork();
    return true;
  } catch (error) {
    Logger.error(`Failed to validate bundler URL ${url}:`, error);
    return false;
  }
}

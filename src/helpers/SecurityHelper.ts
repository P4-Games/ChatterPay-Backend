import * as crypto from 'crypto';

import { BUN_ENV, PRIVATE_KEY } from '../config/constants';
import { getPhoneNumberFormatted } from './formatHelper';

/**
 * Generates a private key based on a seed private key, a phone number, and a chain ID.
 *
 * This function combines the environment-defined seed private key, the provided phone number,
 * and the chain ID to generate a unique and secure private key.
 *
 * @param phoneNumber - The phone number to incorporate into the key generation.
 * @param chanId - The chain ID to include in the seed.
 * @returns A string representing the generated private key, prefixed with '0x'.
 *
 * @throws Error if the seed private key is not found in the environment variables.
 */
export function generateWalletSeed(phoneNumber: string, chanId: string): string {
  if (!PRIVATE_KEY) {
    throw new Error('Seed private key not found in environment variables');
  }

  const seed = `${PRIVATE_KEY}${chanId}${BUN_ENV}${getPhoneNumberFormatted(phoneNumber)}`;
  return `0x${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

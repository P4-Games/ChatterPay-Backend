import * as crypto from 'crypto';

import { getPhoneNumberFormatted } from './formatHelper';
import { BUN_ENV, SEED_INTERNAL_SALT } from '../config/constants';

/**
 * Generates a wallet seed based on a phone number and a chain ID.
 *
 * This function combines the environment-defined seed (`SEED_INTERNAL_SALT`), the formatted phone number,
 * and the chain ID to derive a deterministic and secure wallet seed.
 *
 * @param phoneNumber - The phone number to be used in the seed generation.
 * @param chanId - The chain ID to be included in the seed.
 * @returns A string representing the generated private key, prefixed with '0x'.
 *
 * @throws Error if the seed private key is not defined in the environment variables.
 */
export function generateWalletSeed(phoneNumber: string, chanId: string): string {
  if (!SEED_INTERNAL_SALT) {
    throw new Error('Internal salt not found in environment variables');
  }

  const seed = `${SEED_INTERNAL_SALT}${chanId}${BUN_ENV}${getPhoneNumberFormatted(phoneNumber)}`;
  return `0x${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

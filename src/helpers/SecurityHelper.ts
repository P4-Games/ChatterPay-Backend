import * as crypto from 'crypto';

import { PRIVATE_KEY } from '../config/constants';
import { getPhoneNumberFormatted } from './formatHelper';

/**
 * Generates a private key based on a seed private key and a phone number.
 *
 * @param fromNumber - The phone number to incorporate into the key generation.
 * @returns A string representing the generated private key, prefixed with '0x'.
 */
export function generatePrivateKey(phoneNumber: string): string {
  if (!PRIVATE_KEY) {
    throw new Error('Seed private key not found in environment variables');
  }

  const seed = PRIVATE_KEY + getPhoneNumberFormatted(phoneNumber);
  return `0x${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

import * as crypto from 'crypto';

/**
 * Generates a private key based on a seed private key and a phone number.
 *
 * @param seedPrivateKey - The seed private key to use as a base.
 * @param fromNumber - The phone number to incorporate into the key generation.
 * @returns A string representing the generated private key, prefixed with '0x'.
 */
export function generatePrivateKey(seedPrivateKey: string, fromNumber: string): string {
    const seed = seedPrivateKey + fromNumber;
    return `0x${crypto.createHash('sha256').update(seed).digest('hex')}`;
}
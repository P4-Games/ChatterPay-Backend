import crypto from 'crypto';

import { ALCHEMY_SIGNING_KEY } from '../config/constants';

/**
 * Converts an Ethereum address to a 32-byte topic format (left-padded with zeros)
 * @param addr - The Ethereum address (with or without 0x prefix)
 * @returns The 32-byte topic string
 */
export const toTopicAddress = (addr: string): string => {
  const cleanAddr = addr.toLowerCase().replace(/^0x/, '');
  return `0x${'0'.repeat(24)}${cleanAddr}`;
};

/**
 * Extracts an Ethereum address from a 32-byte topic (removes left padding)
 * @param topic - The 32-byte topic string
 * @returns The Ethereum address with 0x prefix
 */
export const fromTopicAddress = (topic: string): string => {
  const cleanTopic = topic.replace(/^0x/, '');
  return `0x${cleanTopic.slice(-40)}`;
};

/**
 * Verifies the integrity of an Alchemy webhook payload using HMAC-SHA256.
 *
 * @param rawBody - The raw JSON body string received from Alchemy.
 * @param signature - The hex-encoded signature from the "x-alchemy-signature" header.
 * @returns True if the signature is valid, false otherwise.
 */
export const verifyAlchemySignature = (rawBody: string, signature: string): boolean => {
  if (!ALCHEMY_SIGNING_KEY) return false;

  try {
    const computed = crypto
      .createHmac('sha256', ALCHEMY_SIGNING_KEY)
      .update(rawBody, 'utf8')
      .digest('hex');

    const expected = Buffer.from(computed, 'hex');
    const received = Buffer.from(signature, 'hex');

    if (expected.length !== received.length) return false;

    return crypto.timingSafeEqual(expected, received);
  } catch {
    return false;
  }
};

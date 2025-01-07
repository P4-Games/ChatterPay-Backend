/**
 * Utility functions to generate tokens locally:
 *
 * bun run scripts/generateTokens.ts
 *
 */
import crypto from 'crypto';

import { Logger } from '../src/utils/logger';

/**
 * Generate Secure Token
 * @param length
 * @returns
 */
function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

const chatizaloToken = generateSecureToken();
const frontendToken = generateSecureToken();

Logger.log(chatizaloToken);
Logger.log(frontendToken);

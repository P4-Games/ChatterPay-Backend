/**
 * Utility functions to generate tokens locally:
 *
 * bun run src/utils/generateTokens.ts
 *
 */
import crypto from 'crypto';

import { Logger } from './logger';

function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

const chatizaloToken = generateSecureToken();
const frontendToken = generateSecureToken();

Logger.log('Chatizalo Token:', chatizaloToken);
Logger.log('Frontend Token:', frontendToken);

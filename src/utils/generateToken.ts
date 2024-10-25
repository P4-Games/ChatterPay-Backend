/** 
 * Utility functions to generate tokens locally:
 * 
 * bun run src/utils/generateTokens.ts
 * 
 */
import crypto from 'crypto';

function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

const chatizaloToken = generateSecureToken();
const frontendToken = generateSecureToken();

console.log('Chatizalo Token:', chatizaloToken);
console.log('Frontend Token:', frontendToken);
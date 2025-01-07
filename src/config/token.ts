import { FRONTEND_TOKEN, CHATIZALO_TOKEN } from '../constants/environment';

/**
 * Represents the possible token types that can be verified
 */
export type TokenResponse = 'frontend' | 'chatizalo' | null;

/**
 * Verifies the provided token against known tokens
 * @param {string} providedToken - The token to verify
 * @returns {Promise<TokenResponse>} The type of token if verified, or null if not
 */
export async function verifyToken(providedToken: string): Promise<TokenResponse> {
  let res: TokenResponse = null;

  if (providedToken === FRONTEND_TOKEN) res = 'frontend';
  if (providedToken === CHATIZALO_TOKEN) res = 'chatizalo';

  return res;
}

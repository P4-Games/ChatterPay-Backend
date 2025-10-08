import { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../../helpers/loggerHelper';
import { returnErrorResponse } from '../../helpers/requestHelper';
import { verifyAlchemySignature } from '../../helpers/alchemyHelper';
import {
  FRONTEND_TOKEN,
  CHATIZALO_TOKEN,
  TELEGRAM_BOT_API_KEY,
  TELEGRAM_WEBHOOK_PATH,
  ALCHEMY_WEBHOOKS_PATH,
  ALCHEMY_WEBHOOK_HEADER_API_KEY,
  ALCHEMY_VALIDATE_WEBHOOK_HEADER_API_KEY
} from '../constants';

/**
 * Represents the possible token types that can be verified.
 *
 * This type is used to indicate the type of token that is verified:
 * either 'frontend', 'chatizalo', or null (if the token is invalid).
 */
type TokenResponse = 'frontend' | 'chatizalo' | null;

/**
 * Verifies the provided token against known tokens.
 *
 * This function compares the provided token with predefined tokens (e.g., FRONTEND_TOKEN, CHATIZALO_TOKEN),
 * and returns the type of token if it matches or null if not.
 *
 * @param {string} providedToken - The token to verify.
 * @returns {Promise<TokenResponse>} The type of token if verified, or null if not.
 */
async function verifyToken(providedToken: string): Promise<TokenResponse> {
  let res: TokenResponse = null;

  if (providedToken === FRONTEND_TOKEN) res = 'frontend';
  if (providedToken === CHATIZALO_TOKEN) res = 'chatizalo';

  return res;
}

/**
 * Public routes constants.
 *
 * This constant array defines the list of routes that are publicly accessible without authentication.
 */
const PUBLIC_ROUTES = [
  '/favicon.ico',
  '/ping',
  '/docs',
  '/docs/*',
  '/nft/metadata/opensea/*',
  '/nfts*',
  '/nft/<id>',
  '/last_nft*',
  '/nft_info*',
  '/balance/*'
];

/**
 * Function that checks if the current route is public or not.
 *
 * This function checks if the requested route is listed as a public route. If a route contains wildcards,
 * it will match all routes that follow the pattern.
 *
 * @param route - The route to check.
 * @returns `true` if the route is public, `false` otherwise.
 */
const isPublicRoute = (route: string): boolean => {
  const cleanRoute = route.replace(/\/+$/, ''); // remove trailing slash if present

  return PUBLIC_ROUTES.some((publicRoute) => {
    const cleanPublic = publicRoute.replace(/\/+$/, '');

    if (cleanPublic.includes('*')) {
      const base = cleanPublic.replace(/\*/g, '');
      return (
        cleanRoute === base.replace(/\/$/, '') || // exact match without trailing slash
        cleanRoute.startsWith(base) // match subpaths
      );
    }

    if (cleanPublic.includes('<id>')) {
      const nftIdMatch = cleanRoute.match(/^\/nft\/(\d+)$/);
      if (!nftIdMatch) return false;

      const id = nftIdMatch[1];
      return /^\d+$/.test(id);
    }

    return cleanPublic === cleanRoute;
  });
};

/**
 * Checks whether the incoming request targets the Telegram webhook route.
 *
 * @param {string} route - The request URL.
 * @returns {boolean} True if the route is the Telegram webhook.
 */
const isTelegramWebhookRoute = (route: string): boolean =>
  route === TELEGRAM_WEBHOOK_PATH || route === TELEGRAM_WEBHOOK_PATH.replace(/\/$/, '');

/**
 * Checks whether the incoming request targets any Alchemy webhook route.
 *
 * Matches both the base path (/webhooks/alchemy) and subpaths
 * like /webhooks/alchemy/deposits, /webhooks/alchemy/factory, etc.
 *
 * @param route - The request URL.
 * @returns {boolean} True if the route starts with the Alchemy webhook base path.
 */
const isAlchemyWebhookRoute = (route: string): boolean => {
  const cleanRoute = route.replace(/\/+$/, ''); // remove trailing slashes
  const cleanBase = ALCHEMY_WEBHOOKS_PATH.replace(/\/+$/, '');
  return cleanRoute === cleanBase || cleanRoute.startsWith(`${cleanBase}/`);
};

/**
 * Fastify auth middleware.
 *
 * Behavior:
 * - For the Telegram webhook route:
 *   - If `TELEGRAM_SECRET_TOKEN` is set, validates `X-Telegram-Bot-Api-Secret-Token`.
 *   - If not set, allows the request (useful for local dev without secret).
 * - For any other route:
 *   - Skips auth if the route is public.
 *   - Requires `Authorization: Bearer <token>` and validates it against known tokens.
 *
 * @param {FastifyRequest} request - Fastify request.
 * @param {FastifyReply} reply - Fastify reply.
 * @returns {Promise<void>} Resolves when the request can proceed or after replying with an error.
 */
export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { url } = request;

  // Telegram webhook: validate optional secret header, skip Bearer.
  if (isTelegramWebhookRoute(url)) {
    const expected = TELEGRAM_BOT_API_KEY;

    const got = request.headers['x-telegram-bot-api-secret-token'];
    if (typeof got !== 'string' || got !== expected) {
      await returnErrorResponse(
        'authMiddleware',
        '',
        reply,
        401,
        'Unauthorized Telegram webhook request'
      );
      return;
    }
    return;
  }

  /**
   * Alchemy webhook authentication and signature verification
   */
  if (isAlchemyWebhookRoute(url)) {
    const alchemyHeaderSignature = request.headers['x-alchemy-signature'] as string | undefined;
    const alchemyHeaderApiKey = request.headers['x-api-key'] as string | undefined;

    // Verify that at least the signature header exists
    if (!alchemyHeaderSignature) {
      await returnErrorResponse(
        'authMiddleware',
        '',
        reply,
        401,
        'Missing Alchemy signature header'
      );
      return;
    }

    // Conditionally validate the x-api-key header based on environment flag
    if (ALCHEMY_VALIDATE_WEBHOOK_HEADER_API_KEY) {
      if (!alchemyHeaderApiKey) {
        await returnErrorResponse(
          'authMiddleware',
          '',
          reply,
          401,
          'Missing Alchemy API key header'
        );
        return;
      }

      // Always compare, even if ALCHEMY_WEBHOOK_HEADER_API_KEY is empty
      const expected = ALCHEMY_WEBHOOK_HEADER_API_KEY || '';
      const received = alchemyHeaderApiKey || '';

      if (received !== expected) {
        Logger.warn('authMiddleware', 'Alchemy API key mismatch', {
          expected: expected ? `${expected.slice(0, 8)}***` : '(empty)',
          received: received ? `${received.slice(0, 8)}***` : '(empty)'
        });
        await returnErrorResponse('authMiddleware', '', reply, 401, 'Invalid Alchemy API key');
        return;
      }
    } else {
      Logger.debug('authMiddleware', 'Skipping Alchemy API key validation (disabled by env flag)');
    }

    // Extract raw request body
    const rawBody = (request.rawBody as string | undefined) ?? '';

    // Skip signature validation if body is empty (e.g. /webhooks/alchemy/health pings)
    if (rawBody.length === 0) {
      Logger.debug('authMiddleware', 'Skipping Alchemy signature verification (empty body)');
      return;
    }

    // Verify the HMAC signature using the private signing key
    const isValid = verifyAlchemySignature(rawBody, alchemyHeaderSignature);
    if (!isValid) {
      Logger.warn('authMiddleware', 'Alchemy signature verification failed', {
        rawBodyLength: rawBody.length,
        rawBodyPreview: rawBody.slice(0, 120),
        receivedSignature: `${alchemyHeaderSignature.slice(0, 12)}***`
      });
      await returnErrorResponse('authMiddleware', '', reply, 401, 'Invalid Alchemy signature');
      return;
    }

    Logger.debug('authMiddleware', 'Valid Alchemy webhook verified successfully');
    return;
  }

  // 2) Public routes: skip auth
  if (isPublicRoute(url)) {
    Logger.debug(
      'authMiddleware',
      `Public route accessed: ${url}, headers: ${JSON.stringify(request.headers, null, 2)}`
    );
    return;
  }

  // 3) Bearer auth for the rest
  const authHeader: string | undefined = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    await returnErrorResponse(
      'authMiddleware',
      '',
      reply,
      401,
      'Authentication token was not provided'
    );
    return;
  }

  const token: string = authHeader.split(' ')[1];
  const tokenType: TokenResponse = await verifyToken(token);

  if (!tokenType) {
    await returnErrorResponse('authMiddleware', '', reply, 401, 'Invalid Authorization Token');
    return;
  }

  // If you need to pass tokenType downstream, prefer attaching it to request (typed) rather than headers.
  // Minimal change: keep behavior but avoid mutating headers shape.
  (request as FastifyRequest & { tokenType?: TokenResponse }).tokenType = tokenType;
}

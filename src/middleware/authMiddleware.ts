import { FastifyReply, FastifyRequest } from 'fastify';

import { isPublicRoute } from '../config/publicRoutes';
import { verifyToken, TokenResponse } from '../config/token';
import { returnErrorResponse } from '../utils/responseFormatter';

/**
 * Middleware function to authenticate requests using a Bearer token.
 *
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<void>}
 *
 * @throws {FastifyReply} Sends a 401 response if authentication fails.
 *
 * @description
 * This middleware function performs the following steps:
 * 1. Extracts the authorization header from the request.
 * 2. Checks if the header exists and starts with 'Bearer '.
 * 3. Verifies the token using the `verifyToken` function.
 * 4. If the token is valid, adds the token type to the request headers.
 * 5. If any step fails, it sends a 401 response with an error message.
 */
export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Skip authentication for public routes (ping, opensea metadata, etc.)
  if (isPublicRoute(request.url)) {
    return;
  }

  const authHeader: string | undefined = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    returnErrorResponse(reply, 401, 'Authentication token was not provided');
    return;
  }

  const token: string = authHeader.split(' ')[1];

  const tokenType: TokenResponse = await verifyToken(token);

  if (!tokenType) {
    returnErrorResponse(reply, 401, 'Invalid Authorization Token');
    return;
  }

  request.headers.tokenType = tokenType;
}

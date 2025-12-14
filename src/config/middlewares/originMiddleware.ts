import type { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../../helpers/loggerHelper';
import { returnErrorResponse } from '../../helpers/requestHelper';
import {
  CORS_ORIGINS,
  CORS_ORIGINS_CHECK_POSTMAN,
  CORS_ORIGINS_EXCEPTIONS,
  IS_DEVELOPMENT
} from '../constants';

// Get the list of allowed CORS origins from environment variables or default to an empty string
const corsAllowedDomains = CORS_ORIGINS.split(',').map((domain) => domain.trim());
const corsExceptions = CORS_ORIGINS_EXCEPTIONS.split(',').map((path: string) => path.trim());

/**
 * Middleware function to handle Cross-Origin Resource Sharing (CORS).
 * It checks the `Origin` header of incoming requests and validates them against a list of allowed domains.
 *
 * Validations performed:
 * - Requests matching an exception path (CORS_ORIGINS_EXCEPTIONS) are skipped.
 * - The protocol (http:// or https://) is stripped from the origin before processing.
 * - If no `origin` header is present, a 403 error is returned.
 * - Requests from Postman are blocked if CORS_ORIGINS_CHECK_POSTMAN is enabled.
 * - If wildcard `*` is present in allowed origins, the request is allowed.
 * - The origin is validated against a list of allowed domains using regex patterns.
 * - If the origin is not explicitly allowed, a 403 error is returned.
 *
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object to send responses.
 * @returns {Promise<void>} - A promise that resolves when the CORS check is complete.
 */
export async function originMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const { origin, 'user-agent': userAgent } = request.headers;
  Logger.log('originMiddleware', `'${origin}'`);

  // Check if the request URL contains any exception paths
  const requestPath = request.url.split('?')[0]; // Extract only the path without query parameters
  if (
    corsExceptions.some((exception) => {
      const cleanReq = requestPath.replace(/\/+$/, ''); // remove trailing slash
      const cleanExc = exception.replace(/\/+$/, '');
      return cleanReq === cleanExc || cleanReq.startsWith(`${cleanExc}/`);
    })
  ) {
    return;
  }

  // If there is no `origin` in the request headers, return a 403 error
  if (!origin) {
    returnErrorResponse(
      'originMiddleware',
      '',
      reply,
      403,
      `Origin '${origin}' is not allowed by CORS.`
    );
    return;
  }

  // Block requests from Postman by checking the User-Agent header
  if (userAgent && userAgent.includes('PostmanRuntime') && CORS_ORIGINS_CHECK_POSTMAN) {
    returnErrorResponse(
      'originMiddleware',
      '',
      reply,
      403,
      `Access forbidden by CORS. Postman requests are not allowed.`
    );
    return;
  }

  // If in development mode and wildcard '*' is allowed, continue without errors
  if (IS_DEVELOPMENT && corsAllowedDomains.includes('*')) {
    return; // If it's allowed to use a wildcard in development, proceed without blocking
  }

  // Create a list of regular expressions from the allowed domains (ignoring the wildcard '*')
  // Remove protocol (http:// or https://)
  const cleanOrigin = origin.replace(/^https?:\/\//, '');
  const regexPatterns = corsAllowedDomains
    .filter((entry) => entry !== '*') // Ignore the wildcard for other domains
    .map((entry) => {
      if (entry.includes('*')) {
        // Convert the wildcard into a regular expression
        return new RegExp(`^${entry.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
      }
      // Match exact domain or IP
      return new RegExp(`^${entry}$`);
    });

  // Check if the origin is allowed by comparing it against the regex patterns
  const isAllowed = regexPatterns.some((regex) => regex.test(cleanOrigin));

  // If the origin is not allowed, return a 403 error
  if (!isAllowed) {
    returnErrorResponse(
      'originMiddleware',
      '',
      reply,
      403,
      `Origin '${cleanOrigin}' is not allowed by CORS.`
    );
  }
}

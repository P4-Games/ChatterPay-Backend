import type { FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../../helpers/loggerHelper';
import { returnErrorResponse } from '../../helpers/requestHelper';
import { BLACKLIST_IPS } from '../constants';

const blacklistedIps = (BLACKLIST_IPS || '').split(',').map((ip) => ip.trim());

/**
 * Middleware to block blacklisted IPs.
 * @param request - The Fastify request object.
 * @param reply - The Fastify reply object.
 * @param done - Callback to continue request handling.
 */
export function ipBlacklistMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void
): void {
  // Extract client IP, considering potential proxies
  const clientIp =
    request.headers['x-forwarded-for']?.toString().split(',')[0].trim() || request.ip;
  Logger.log('ipBlacklistMiddleware', `url: ${request.url}, Detected IP: ${clientIp}`);

  if (blacklistedIps.includes(clientIp)) {
    returnErrorResponse(
      'ipBlacklistMiddleware',
      '',
      reply,
      403,
      `Access forbidden: your IP ${clientIp} is blacklisted`
    );
    return;
  }

  done();
}

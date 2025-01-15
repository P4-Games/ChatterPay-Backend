import { FastifyReply, FastifyRequest } from 'fastify';

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
  const clientIp = request.ip;

  if (blacklistedIps.includes(clientIp)) {
    reply.status(403).send({ error: 'Access forbidden: your IP is blacklisted' });
    return;
  }

  done();
}

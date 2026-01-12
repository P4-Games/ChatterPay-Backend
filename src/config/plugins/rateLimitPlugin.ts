import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

import { MAX_REQUESTS_PER_MINUTE } from '../constants';

/**
 * Configures rate limiting for the Fastify server.
 * @param server - The Fastify server instance.
 */
export async function setupRateLimit(server: FastifyInstance): Promise<void> {
  await server.register(rateLimit, {
    max: MAX_REQUESTS_PER_MINUTE,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      code: 429,
      error: 'Too Many Requests',
      message: 'Too many requests, please try again later.'
    })
  });
}

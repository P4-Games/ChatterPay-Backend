import { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

/**
 * Configures rate limiting for the Fastify server.
 * @param server - The Fastify server instance.
 */
export async function setupRateLimit(server: FastifyInstance): Promise<void> {
  await server.register(rateLimit, {
    max: 50,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      code: 429,
      error: 'Too Many Requests',
      message: 'Too many requests, please try again later.'
    })
  });
}

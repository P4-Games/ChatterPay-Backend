import rateLimit from '@fastify/rate-limit';
import Fastify, { FastifyInstance } from 'fastify';

import { setupSwagger } from './swagger';
import { setupRoutes } from '../api/routes';
import { Logger } from '../helpers/loggerHelper';
import { setupMiddleware } from '../middleware/bodyParser';
import networkConfigPlugin from '../plugins/networkConfig';
import { authMiddleware } from '../middleware/authMiddleware';
import { PORT, CURRENT_LOG_LEVEL } from '../constants/environment';

/**
 * Starts the Fastify server with all necessary configurations.
 * @returns {Promise<FastifyInstance>} A promise that resolves to the configured Fastify server instance
 */
export async function startServer(): Promise<FastifyInstance> {
  const server: FastifyInstance = Fastify({
    ignoreDuplicateSlashes: true,
    ignoreTrailingSlash: true,
    logger: {
      redact: ['req.headers.authorization'],
      level: CURRENT_LOG_LEVEL
    }
  });

  await server.register(rateLimit, {
    max: 50,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      code: 429,
      error: 'Too Many Requests',
      message: 'Too many requests, please try again later.'
    })
  });

  server.addHook('onRequest', authMiddleware);

  await server.register(networkConfigPlugin);
  await setupMiddleware(server);
  await setupRoutes(server);
  await setupSwagger(server);

  await server.listen({ port: PORT, host: '0.0.0.0' });

  const address = server.server.address();
  const port: string | number | undefined = typeof address === 'string' ? address : address?.port;
  const host: string | undefined = typeof address === 'string' ? address : address?.address;
  Logger.info(`Server is listening on http://${host}:${port}`);

  return server;
}

import rateLimit from '@fastify/rate-limit';
import Fastify, { FastifyInstance } from 'fastify';

import { setupSwagger } from './swagger';
import { setupRoutes } from '../api/routes';
import { Logger } from '../helpers/loggerHelper';
import { setupMiddleware } from '../middleware/bodyParser';
import networkConfigPlugin from '../plugins/networkConfig';
import { authMiddleware } from '../middleware/authMiddleware';
import { traceMiddleware } from '../middleware/traceMiddleware';
import { setupRateLimit } from './plugins/rateLimitPlugin';
import { PORT, CURRENT_LOG_LEVEL, GCP_CLOUD_TRACE_ENABLED } from './constants';

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

  server.addHook('onRequest', authMiddleware);

  // Middleware para trazas de Cloud Trace
  if (GCP_CLOUD_TRACE_ENABLED) {
    server.addHook('onRequest', traceMiddleware);
  }

  await setupRateLimit(server);
  await server.register(networkConfigPlugin);
  await setupBodyParserMiddleware(server);
  await setupRoutes(server);
  await setupSwagger(server);

  await server.listen({ port: PORT, host: '0.0.0.0' });

  const address = server.server.address();
  const port: string | number | undefined = typeof address === 'string' ? address : address?.port;
  const host: string | undefined = typeof address === 'string' ? address : address?.address;
  Logger.info('startServer', `Server is listening on http://${host}:${port}`);

  return server;
}

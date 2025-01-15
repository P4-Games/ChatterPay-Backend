import Fastify, { FastifyInstance } from 'fastify';

import { setupRoutes } from '../api/routes';
import { Logger } from '../helpers/loggerHelper';
import { setupSwagger } from './plugins/swaggerPlugin';
import { setupRateLimit } from './plugins/rateLimitPlugin';
import { authMiddleware } from './middlewares/authMiddleware';
import { traceMiddleware } from './middlewares/traceMiddleware';
import { setupCorsMiddleware } from './middlewares/corsMiddleware';
import { setupNetworkConfigPlugin } from './plugins/networkConfigPlugin';
import { ipBlacklistMiddleware } from './middlewares/ipsBlackListMiddleware';
import { PORT, CURRENT_LOG_LEVEL, GCP_CLOUD_TRACE_ENABLED } from './constants';
import { setupBodyParserMiddleware } from './middlewares/bodyParserMiddleware';

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
  server.addHook('onRequest', ipBlacklistMiddleware);
  if (GCP_CLOUD_TRACE_ENABLED) {
    server.addHook('onRequest', traceMiddleware);
  }

  await setupCorsMiddleware(server);
  await setupRateLimit(server);
  await setupNetworkConfigPlugin(server);
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

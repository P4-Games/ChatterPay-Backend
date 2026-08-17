import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import path from 'path';

import { setupRoutes } from '../api/routes';
import { Logger } from '../helpers/loggerHelper';
import { CURRENT_LOG_LEVEL, GCP_CLOUD_TRACE_ENABLED, PORT } from './constants';
import { authMiddleware } from './middlewares/authMiddleware';
import { setupBodyParserMiddleware } from './middlewares/bodyParserMiddleware';
import { ipBlacklistMiddleware } from './middlewares/ipsBlackListMiddleware';
import { originMiddleware } from './middlewares/originMiddleware';
import { traceMiddleware } from './middlewares/traceMiddleware';
import { setupNetworkConfigPlugin } from './plugins/networkConfigPlugin';
import { setupRateLimit } from './plugins/rateLimitPlugin';
import { setupSwagger } from './plugins/swaggerPlugin';

/**
 * Builds the Fastify server with every plugin, hook and route registered — and does not listen.
 *
 * Split out from {@link startServer} so the application can be exercised through
 * `server.inject()` without binding a port. Until this existed there was no way to test a request
 * end to end, which is why the repository has route handlers with no tests at all.
 *
 * @returns The configured server, ready to inject into or to listen with.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const server: FastifyInstance = Fastify({
    ignoreDuplicateSlashes: true,
    ignoreTrailingSlash: true,
    // Fastify's default is 100 characters, and a Cardano base address is 103 on mainnet and 108 on
    // Preprod. Over the limit the router does not error, it answers **404** — so `GET /balance/:wallet`
    // silently stopped existing for every Cardano wallet. An EVM address is 42 and the enterprise
    // addresses this deployment used to issue were 59, which is why nothing noticed until now.
    //
    // 256 is the same ceiling `cardanoAddressService` passes to bech32, for the same reason: it is
    // above any address either family can produce.
    maxParamLength: 256,
    logger: {
      redact: ['req.headers.authorization'],
      level: CURRENT_LOG_LEVEL
    }
  });

  server.addHook('onRequest', originMiddleware);
  server.addHook('onRequest', ipBlacklistMiddleware);
  server.addHook('onRequest', authMiddleware);

  if (GCP_CLOUD_TRACE_ENABLED) {
    server.addHook('onRequest', traceMiddleware);
  }

  await setupRateLimit(server);
  await setupNetworkConfigPlugin(server);
  await setupBodyParserMiddleware(server);
  await setupRoutes(server);
  await setupSwagger(server);

  await server.register(fastifyStatic, {
    root: path.join(__dirname, '../../public'),
    prefix: '/'
  });

  return server;
}

/**
 * Builds the server and binds it to the configured port.
 *
 * @returns {Promise<FastifyInstance>} A promise that resolves to the listening Fastify instance.
 */
export async function startServer(): Promise<FastifyInstance> {
  const server = await buildServer();

  await server.listen({ port: PORT, host: '0.0.0.0' });

  const address = server.server.address();
  const port: string | number | undefined = typeof address === 'string' ? address : address?.port;
  const host: string | undefined = typeof address === 'string' ? address : address?.address;
  Logger.info('startServer', `Server is listening on http://${host}:${port}`);

  return server;
}

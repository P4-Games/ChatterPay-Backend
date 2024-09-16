import Fastify, { FastifyInstance } from 'fastify';

import { setupSwagger } from './swagger';
import { setupRoutes } from '../api/routes';
import { setupMiddleware } from '../middleware/bodyParser';

/**
 * Starts the Fastify server with all necessary configurations.
 * 
 * @returns {Promise<FastifyInstance>} A promise that resolves to the configured Fastify server instance
 */
export async function startServer(): Promise<FastifyInstance> {
    const server: FastifyInstance = Fastify({
        ignoreDuplicateSlashes: true,
        ignoreTrailingSlash: true,
        logger: true
    });

    const PORT: number = Number(process.env.PORT) || 3000;

    await setupMiddleware(server);
    await setupRoutes(server);
    await setupSwagger(server);

    await server.listen({ port: PORT, host: '0.0.0.0' });

    const address = server.server.address();
    const port: string | number | undefined = typeof address === 'string' ? address : address?.port;
    const host: string | undefined = typeof address === 'string' ? address : address?.address;
    server.log.info(`Server is listening on http://${host}:${port}`);

    return server;
}
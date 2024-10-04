import rateLimit from '@fastify/rate-limit';
import Fastify, { FastifyInstance } from 'fastify';

import { setupSwagger } from './swagger';
import { setupRoutes } from '../api/routes';
import { PORT } from '../constants/environment';
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
        logger: true,
    });

    await server.register(rateLimit, {
        max: 400,
        timeWindow: '1 minute',
        errorResponseBuilder: () => ({
            code: 429,
            error: 'Too Many Requests',
            message: 'Demasiadas solicitudes, por favor inténtelo de nuevo más tarde.',
        }),
    });

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

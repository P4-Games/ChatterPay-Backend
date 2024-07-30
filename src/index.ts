import Fastify, { FastifyInstance } from 'fastify';
import { pingRoute } from './routes/ping';
import { AddressInfo } from 'net';

/**
 * Creates and configures the Fastify server instance.
 * @type {FastifyInstance}
 */
const server: FastifyInstance = Fastify({
    logger: true
});

// Registrar rutas
server.register(pingRoute, { prefix: '/api' });

/**
 * Starts the Fastify server.
 * @async
 * @function start
 * @throws {Error} If the server fails to start
 * @returns {Promise<void>}
 */
const start = async (): Promise<void> => {
    try {
        await server.listen({ port: 3000 });
        console.log(`Server listening on ${(server.server.address() as AddressInfo)?.port}`);
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};

start();
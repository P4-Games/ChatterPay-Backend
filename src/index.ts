import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { pingRoute } from './routes/ping';
import { AddressInfo } from 'net';

/**
 * Creates and configures the Fastify server instance.
 * @type {FastifyInstance}
 */
const server: FastifyInstance = Fastify({
    logger: true
});

// Registrar el plugin para servir archivos estáticos
/**
 * Configures the static file serving from the 'public' directory.
 * Files in this directory will be accessible under the '/public' route.
 */
server.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/public/',
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
        console.log(`Static files are served from /public`);
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};

start();
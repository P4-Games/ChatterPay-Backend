import { FastifyInstance } from 'fastify';

/**
 * Registers the ping route with the Fastify instance.
 * @param {FastifyInstance} fastify - The Fastify instance
 * @returns {Promise<void>}
 */
export const pingRoute = async (fastify: FastifyInstance): Promise<void> => {
    /**
     * Route to check server status
     * @route GET /ping
     */
    fastify.get('/ping', () => ({ status: 'ok', message: 'pong' }));
};


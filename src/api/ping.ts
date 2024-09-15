import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Registers the ping route with the Fastify instance.
 * @async
 * @function pingRoute
 * @param {FastifyInstance} fastify - The Fastify instance
 * @returns {Promise<void>}
 */
export const pingRoute = async (fastify: FastifyInstance): Promise<void> => {
    fastify.get('/ping', async (request: FastifyRequest, reply: FastifyReply) => {
        return { status: 'ok', message: 'pong' };
    });
};
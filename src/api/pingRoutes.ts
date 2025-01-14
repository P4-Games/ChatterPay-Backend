import { FastifyInstance } from 'fastify';

/**
 * Registers the ping route with the Fastify instance.
 * @param {FastifyInstance} fastify - The Fastify instance
 * @returns {Promise<void>} Resolves once the route is registered
 */
export const pingRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to check server status
   * @route GET /ping
   * @returns {Object} An object containing the status and message of the server
   */
  fastify.get('/ping', () => ({ status: 'ok', message: 'pong' }));
};

import type { FastifyInstance } from 'fastify';

import { isDatabaseConnected } from '../config/database';

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

  /**
   * Route to check whether the server can serve traffic that needs the database.
   * Answers 200 only once MongoDB is connected, so it can back a readiness probe
   * without blocking startup the way the boot sequence used to.
   * @route GET /ready
   * @returns {Object} An object containing the readiness state and database status
   */
  fastify.get('/ready', (_request, reply) => {
    const dbConnected: boolean = isDatabaseConnected();
    return reply
      .code(dbConnected ? 200 : 503)
      .send({ status: dbConnected ? 'ready' : 'starting', database: dbConnected });
  });
};

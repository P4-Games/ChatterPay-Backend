import type { FastifyInstance } from 'fastify';

import { swap } from '../controllers/swapController';

/**
 * Configures routes related to swaps.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once the route is registered
 */
const swapRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to perform a swap
   * @route POST /swap
   * @returns {Object} The result of the swap operation
   */
  fastify.post('/swap', swap);
};

export default swapRoutes;

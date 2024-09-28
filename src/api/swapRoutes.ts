import { FastifyInstance } from 'fastify';

import { swap } from '../controllers/swapController';

/**
 * Configures routes related to swaps.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>}
 */
const swapRoutes = async (fastify: FastifyInstance): Promise<void> => {
    /**
     * Route to perform a swap
     * @route POST /swap
     */
    fastify.post('/swap', swap);
};

export default swapRoutes;

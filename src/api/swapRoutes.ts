import { FastifyInstance } from 'fastify';

import { swap } from '../controllers/swapController';

/**
 * Configures routes related to swaps.
 * @param fastify - Fastify instance
 */
const swapRoutes: (fastify: FastifyInstance) => Promise<void> = async (fastify) => {
    // Route to perform a swap
    fastify.post('/swap', swap);
};

export default swapRoutes;
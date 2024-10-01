import { FastifyInstance } from 'fastify';

import { walletBalance, balanceByPhoneNumber } from '../controllers/balanceController';

/**
 * Configures routes related to wallet balances.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>}
 */
export const balanceRoutes = async (fastify: FastifyInstance): Promise<void> => {
    /**
     * Route to get the balance of a wallet
     * @route GET /balance/:wallet
     */
    fastify.get('/balance/:wallet', walletBalance);

    /**
     * Route to get the balance by phone number
     * @route GET /balance_by_phone/
     */
    fastify.get('/balance_by_phone/', balanceByPhoneNumber);
};

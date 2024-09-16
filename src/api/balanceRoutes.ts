import { FastifyInstance } from 'fastify';

import { walletBalance, balanceByPhoneNumber } from '../controllers/balanceController';

/**
 * Configures routes related to wallet balances.
 * @param fastify - Fastify instance
 */
export const balanceRoutes: (fastify: FastifyInstance) => Promise<void> = async (fastify) => {
    // Route to get the balance of a wallet
    fastify.get('/balance/:wallet', walletBalance);
    // Route to get the balance by phone number
    fastify.get('/balance_by_phone/', balanceByPhoneNumber);
};
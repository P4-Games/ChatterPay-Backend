import { FastifyInstance } from 'fastify';

import { createWallet } from '../controllers/newWalletController';

/**
 * Configures routes related to wallets.
 * @param fastify - Fastify instance
 */
export const walletRouter: (fastify: FastifyInstance) => Promise<void> = async (fastify) => {
    // Route to create a new wallet
    fastify.post('/create_wallet/', createWallet);
};
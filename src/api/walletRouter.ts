import { FastifyInstance } from 'fastify';

import { createWallet } from '../controllers/newWalletController';

/**
 * Configures routes related to wallets.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>}
 */
export const walletRouter = async (fastify: FastifyInstance): Promise<void> => {
    /**
     * Route to create a new wallet
     * @route POST /create_wallet/
     */
    fastify.post('/create_wallet/', createWallet);

    /**
     * Route to withdraw funds from a wallet
     * @route POST /withdraw_funds/
     */
    fastify.post('/withdraw_funds/', withdrawFunds);
};

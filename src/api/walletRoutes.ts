import { FastifyInstance } from 'fastify';

import { createWallet } from '../controllers/walletController';
import { withdrawAllFunds } from '../controllers/withdrawController';

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
   * Route to withdraw all funds from the user's wallet to another wallet provided by the user
   * @route POST /withdraw_all/
   */
  fastify.post('/withdraw_all', withdrawAllFunds);
};

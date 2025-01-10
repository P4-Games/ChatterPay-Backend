import { FastifyInstance } from 'fastify';

import { createWallet } from '../controllers/walletController';
import { withdrawAllFunds } from '../controllers/withdrawController';

/**
 * Configures routes related to wallets.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
export const walletRouter = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to create a new wallet
   * @route POST /create_wallet/
   * @returns {Object} The details of the created wallet
   */
  fastify.post('/create_wallet/', createWallet);

  /**
   * Route to withdraw all funds from the user's wallet to another wallet provided by the user
   * @route POST /withdraw_all/
   * @returns {Object} The result of the withdrawal operation
   */
  fastify.post('/withdraw_all', withdrawAllFunds);
};

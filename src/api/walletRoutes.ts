import type { FastifyInstance } from 'fastify';

import {
  createWallet,
  createWalletSync,
  getRampWallet,
  withdrawAllFunds
} from '../controllers/walletController';

/**
 * Configures routes related to wallets.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
export const walletRouter = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to get just the wallet to use with ramp-prompts
   * @route POST /get_ramp_wallet/
   * @returns {Object} The details of the user wallet
   */
  fastify.post('/get_ramp_wallet/', getRampWallet);

  /**
   * Route to get or create a wallet
   * @route POST /get_wallet/
   * @returns {Object} The details of the created wallet
   */
  fastify.post('/get_wallet/', createWallet);

  /**
   * Route to get or create a wallet (sync mode)
   * @route POST /get_wallet/
   * @returns {Object} The details of the created wallet
   */
  fastify.post('/get_wallet_sync/', createWalletSync);

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

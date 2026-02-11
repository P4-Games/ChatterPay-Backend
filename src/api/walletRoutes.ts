import type { FastifyInstance } from 'fastify';

import {
  createWallet,
  createWalletSync,
  getDepositInfo,
  getMultichainDepositCta,
  getRampWallet,
  getWalletNextSteps
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
   * Route to send deposit information
   * @route POST /deposit_info/
   * @returns {Object} Confirmation that deposit info was sent
   */
  fastify.post('/deposit_info/', getDepositInfo);

  /**
   * Route to send only the multichain deposit CTA
   * @route POST /multichain_deposit_cta/
   * @returns {Object} Confirmation that the multichain deposit CTA was sent
   */
  fastify.post('/multichain_deposit_cta/', getMultichainDepositCta);

  /**
   * Route to send wallet next-steps with quick-reply buttons
   * @route POST /wallet_next_steps/
   * @returns {Object} Confirmation that the next steps message was sent
   */
  fastify.post('/wallet_next_steps/', getWalletNextSteps);
};

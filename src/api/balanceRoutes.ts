import { FastifyInstance } from 'fastify';

import {
  walletBalance,
  balanceByPhoneNumber,
  checkExternalDeposits
} from '../controllers/balanceController';

/**
 * Configures routes related to wallet balances.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
export const balanceRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to get the balance of a wallet by its unique identifier.
   * @route GET /balance/:wallet
   * @param {string} wallet - The wallet identifier (e.g., wallet address or ID)
   * @returns {Object} The balance of the specified wallet
   */
  fastify.get('/balance/:wallet', walletBalance);

  /**
   * Route to get the balance associated with a phone number.
   * @route GET /balance_by_phone/
   * @param {string} phoneNumber - The phone number to look up the balance for
   * @returns {Object} The balance linked to the specified phone number
   */
  fastify.get('/balance_by_phone/', balanceByPhoneNumber);

  /**
   * Route to check external deposits, typically used by Alchemy webhooks to notify of events.
   * @route GET /check_deposits
   * @returns {Object} Information on any deposits or events detected
   */
  fastify.get('/check_deposits', checkExternalDeposits);
};

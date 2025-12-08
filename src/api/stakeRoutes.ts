import { FastifyInstance } from 'fastify';

import { stakeHandler, unstakeHandler } from '../controllers/stakeController';

const stakeRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to stake tokens
   * @route POST /stake
   * @param {string} amount - Amount to stake
   * @param {number} [chain_id] - Chain ID (optional)
   * @param {string} [token] - Token symbol (optional, default: 'USX')
   * @returns {Object} Transaction result
   */
  fastify.post('/stake', stakeHandler);

  /**
   * Route to unstake tokens
   * @route POST /unstake
   * @param {string} amount - Amount to unstake
   * @param {number} [chain_id] - Chain ID (optional)
   * @param {string} [token] - Token symbol (optional, default: 'USX')
   * @returns {Object} Transaction result
   */
  fastify.post('/unstake', unstakeHandler);
};

export default stakeRoutes;

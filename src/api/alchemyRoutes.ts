import type { FastifyInstance } from 'fastify';

import { ALCHEMY_WEBHOOKS_PATH } from '../config/constants';
import {
  handleAlchemyDeposits,
  handleAlchemyFactory,
  handleAlchemyHealth
} from '../controllers/alchemyController';

/**
 * Configures routes for webhooks.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
export const alchemyRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to handle deposit events (ETH + ERC-20) from Alchemy webhooks.
   * @route POST /webhooks/alchemy/deposits
   * @param {AlchemyWebhookPayload} body - Payload containing deposit event details
   * @returns {Object} Result of the processed deposit events
   */
  fastify.post(`${ALCHEMY_WEBHOOKS_PATH}/deposits`, handleAlchemyDeposits);

  /**
   * Route to handle factory contract events for token whitelist synchronization.
   * @route POST /webhooks/alchemy/factory
   * @param {AlchemyWebhookPayload} body - Payload containing factory event details
   * @returns {Object} Result of the processed factory events
   */
  fastify.post(`${ALCHEMY_WEBHOOKS_PATH}/factory`, handleAlchemyFactory);

  /**
   * Route to check the health status of the Alchemy webhook system.
   * @route GET /webhooks/health
   * @returns {Object} Health status information
   */
  fastify.get(`${ALCHEMY_WEBHOOKS_PATH}/health`, handleAlchemyHealth);
};

export default alchemyRoutes;

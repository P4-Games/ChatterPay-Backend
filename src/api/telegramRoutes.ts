import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { TelegramUpdate } from '../controllers/telegramController';

import { handleTelegramUpdate } from '../controllers/telegramController';

/**
 * Configures routes related to Telegram webhook.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once the route is registered
 */
const telegramRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to receive Telegram updates.
   * @route POST /telegram/webhook
   * @returns {Object} Telegram-compatible response body
   */
  fastify.post<{ Body: TelegramUpdate }>(
    '/telegram/webhook',
    async (req: FastifyRequest<{ Body: TelegramUpdate }>, reply: FastifyReply) =>
      handleTelegramUpdate(req, reply)
  );
};

export default telegramRoutes;

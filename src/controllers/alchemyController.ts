import type { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { depositIngestorService } from '../services/alchemy/depositIngestorService';
import { tokenWhitelistSyncService } from '../services/alchemy/tokenWhitelistSyncService';
import type { AlchemyWebhookPayload } from '../types/alchemyTypes';

/**
 * Handles Alchemy deposit webhooks (ETH + ERC-20).
 */
export const handleAlchemyDeposits = async (
  req: FastifyRequest<{ Body: AlchemyWebhookPayload }>,
  reply: FastifyReply
): Promise<void> => {
  const requestId = req.body?.id ?? 'unknown';
  const ctx = { webhook: 'alchemy', type: 'deposits', requestId };

  try {
    Logger.info('alchemyController', 'Received deposits webhook', ctx);

    // Process deposits (auth + signature already validated by middleware)
    const persistedEvents = await depositIngestorService.ingestDeposits(req.body);

    Logger.info('alchemyController', 'Successfully processed deposits webhook', {
      ...ctx,
      processed: persistedEvents.length
    });

    await reply.status(200).send({ ok: true, processed: persistedEvents.length });
  } catch (error) {
    Logger.error('alchemyController', 'Error processing deposits webhook', { ...ctx, error });
    // Return 200 to prevent Alchemy retries
    await reply.status(200).send({ ok: true, processed: 0 });
  }
};

/**
 * Handles Alchemy factory webhooks (token whitelist updates).
 */
export const handleAlchemyFactory = async (
  req: FastifyRequest<{ Body: AlchemyWebhookPayload }>,
  reply: FastifyReply
): Promise<void> => {
  const requestId = req.body?.id ?? 'unknown';
  const ctx = { webhook: 'alchemy', type: 'factory', requestId };

  try {
    Logger.info('alchemyController', 'Received factory webhook', ctx);

    // Process factory events (auth + signature already validated)
    const processed = await tokenWhitelistSyncService.processFactoryWebhook(req.body);

    Logger.info('alchemyController', 'Successfully processed factory webhook', {
      ...ctx,
      processed
    });

    await reply.status(200).send({ ok: true, processed });
  } catch (error) {
    Logger.error('alchemyController', 'Error processing factory webhook', { ...ctx, error });
    await reply.status(200).send({ ok: true, processed: 0 });
  }
};

/**
 * Health check endpoint for the Alchemy webhook system.
 */
export const handleAlchemyHealth = async (
  _req: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  try {
    const alchemyHealthy = await tokenWhitelistSyncService
      .resyncAlchemyWhitelist()
      .then(() => true)
      .catch(() => false);

    await reply.status(200).send({
      status: 'healthy',
      alchemy: alchemyHealthy,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    Logger.error('alchemyController', 'Health check failed', error);
    await reply.status(503).send({
      status: 'unhealthy',
      alchemy: false,
      timestamp: new Date().toISOString()
    });
  }
};

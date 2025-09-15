import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Logger } from '../helpers/loggerHelper';
import { alchemyWebhookVerifier } from '../services/alchemy/alchemyWebhookVerifier';
import { depositIngestor } from '../services/alchemy/depositIngestor';
import { whitelistSyncService } from '../services/alchemy/whitelistSyncService';
import { AlchemyWebhookPayload } from '../services/alchemy/depositIngestor';
import { PUBLIC_BASE_URL } from '../config/constants';

interface WebhookRequest extends FastifyRequest {
  body: AlchemyWebhookPayload;
  rawBody?: string | Buffer;
  headers: {
    'x-alchemy-signature'?: string;
    [key: string]: string | string[] | undefined;
  };
}

/**
 * Webhook routes for Alchemy integration
 * @param server - Fastify server instance
 */
export default async function webhookRoutes(server: FastifyInstance): Promise<void> {
  // Log webhook URLs on startup
  if (PUBLIC_BASE_URL) {
    Logger.info('webhookRoutes', 'Alchemy Webhook URLs:');
    Logger.info('webhookRoutes', `Deposits Webhook URL: ${PUBLIC_BASE_URL}/webhooks/alchemy/deposits`);
    Logger.info('webhookRoutes', `Factory Webhook URL: ${PUBLIC_BASE_URL}/webhooks/alchemy/factory`);
  }

  /**
   * POST /webhooks/alchemy/deposits
   * Receives deposit events (ETH + ERC-20) for ChatterPay wallets
   */
  server.post<{ Body: AlchemyWebhookPayload }>('/webhooks/alchemy/deposits', {
    schema: {
      description: 'Alchemy deposits webhook endpoint',
      tags: ['webhooks'],
      body: {
        type: 'object',
        properties: {
          webhookId: { type: 'string' },
          id: { type: 'string' },
          createdAt: { type: 'string' },
          type: { type: 'string' },
          event: { type: 'object' }
        },
        required: ['webhookId', 'id', 'event']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            processed: { type: 'number' }
          }
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' }
          }
        }
      }
    }
  }, async (request: WebhookRequest, reply: FastifyReply) => {
    const requestId = request.body?.id || 'unknown';
    const ctx = { webhook: 'alchemy', type: 'deposits', requestId };

    try {
      Logger.info('webhookRoutes', 'Received deposits webhook', ctx);

      // Verify HMAC signature
      const signature = request.headers['x-alchemy-signature'];
      if (!signature || !request.rawBody) {
        Logger.warn('webhookRoutes', 'Missing signature or raw body', ctx);
        return reply.status(401).send({ error: 'Missing signature or body' });
      }

      if (!alchemyWebhookVerifier().verifySignature(request.rawBody, signature)) {
        Logger.warn('webhookRoutes', 'Invalid webhook signature', ctx);
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      // Process deposits
      const persistedEvents = await depositIngestor.ingestDeposits(request.body);

      Logger.info('webhookRoutes', `Successfully processed deposits webhook`, {
        ...ctx,
        processed: persistedEvents.length
      });

      return reply.status(200).send({ 
        ok: true, 
        processed: persistedEvents.length 
      });

    } catch (error) {
      Logger.error('webhookRoutes', 'Error processing deposits webhook', { ...ctx, error });
      
      // Always return 200 to avoid webhook retries storm
      return reply.status(200).send({ 
        ok: true, 
        processed: 0 
      });
    }
  });

  /**
   * POST /webhooks/alchemy/factory
   * Receives factory contract events for token whitelist management
   */
  server.post<{ Body: AlchemyWebhookPayload }>('/webhooks/alchemy/factory', {
    schema: {
      description: 'Alchemy factory webhook endpoint',
      tags: ['webhooks'],
      body: {
        type: 'object',
        properties: {
          webhookId: { type: 'string' },
          id: { type: 'string' },
          createdAt: { type: 'string' },
          type: { type: 'string' },
          event: { type: 'object' }
        },
        required: ['webhookId', 'id', 'event']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            processed: { type: 'number' }
          }
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' }
          }
        }
      }
    }
  }, async (request: WebhookRequest, reply: FastifyReply) => {
    const requestId = request.body?.id || 'unknown';
    const ctx = { webhook: 'alchemy', type: 'factory', requestId };

    try {
      Logger.info('webhookRoutes', 'Received factory webhook', ctx);

      // Verify HMAC signature
      const signature = request.headers['x-alchemy-signature'];
      if (!signature || !request.rawBody) {
        Logger.warn('webhookRoutes', 'Missing signature or raw body', ctx);
        return reply.status(401).send({ error: 'Missing signature or body' });
      }

      if (!alchemyWebhookVerifier().verifySignature(request.rawBody, signature)) {
        Logger.warn('webhookRoutes', 'Invalid webhook signature', ctx);
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      // Process factory events
      const processedEvents = await whitelistSyncService.processFactoryWebhook(request.body);

      Logger.info('webhookRoutes', `Successfully processed factory webhook`, {
        ...ctx,
        processed: processedEvents
      });

      return reply.status(200).send({ 
        ok: true, 
        processed: processedEvents 
      });

    } catch (error) {
      Logger.error('webhookRoutes', 'Error processing factory webhook', { ...ctx, error });
      
      // Always return 200 to avoid webhook retries storm
      return reply.status(200).send({ 
        ok: true, 
        processed: 0 
      });
    }
  });

  /**
   * GET /webhooks/health
   * Health check endpoint for webhook system
   */
  server.get('/webhooks/health', {
    schema: {
      description: 'Webhook system health check',
      tags: ['webhooks'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            alchemy: { type: 'boolean' },
            timestamp: { type: 'string' }
          }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Check Alchemy admin service health
      const alchemyHealthy = await whitelistSyncService.resyncAlchemyWhitelist()
        .then(() => true)
        .catch(() => false);

      return reply.status(200).send({
        status: 'healthy',
        alchemy: alchemyHealthy,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      Logger.error('webhookRoutes', 'Health check failed', error);
      return reply.status(503).send({
        status: 'unhealthy',
        alchemy: false,
        timestamp: new Date().toISOString()
      });
    }
  });
}

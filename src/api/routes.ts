import { FastifyInstance } from 'fastify';

import nftRoutes from './nftRoutes';
import swapRoutes from './swapRoutes';
import tokenRoutes from './tokenRoutes';
import transactionRoutes from './transactionRoutes';
import uploadRoutes from './uploadRoutes';
import userRoutes from './userRoutes';
import webhookRoutes from './webhookRoutes';
import { balanceRoutes } from './balanceRoutes';
import { pingRoutes } from './pingRoutes';
import { rampRoutes } from './rampRoutes';
import { walletRouter } from './walletRoutes';
import blockchainRoutes from './blockchainRoutes';
import supportRoutes from './supportRoutes';

/**
 * Sets up all routes for the Fastify server.
 * @param {FastifyInstance} server - Fastify server instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
export async function setupRoutes(server: FastifyInstance): Promise<void> {
  server.register(pingRoutes);
  server.register(transactionRoutes);
  server.register(userRoutes);
  server.register(tokenRoutes);
  server.register(walletRouter);
  server.register(blockchainRoutes);
  server.register(balanceRoutes);
  server.register(swapRoutes);
  server.register(nftRoutes);
  server.register(uploadRoutes);
  server.register(rampRoutes);
  server.register(supportRoutes);
  server.register(webhookRoutes);
}

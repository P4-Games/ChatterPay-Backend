import { FastifyInstance } from 'fastify';

import nftRoutes from './nftRoutes';
import swapRoutes from './swapRoutes';
import userRoutes from './userRoutes';
import aaveRoutes from './aaveRoutes';
import tokenRoutes from './tokenRoutes';
import stakeRoutes from './stakeRoutes';
import { pingRoutes } from './pingRoutes';
import { rampRoutes } from './rampRoutes';
import uploadRoutes from './uploadRoutes';
import supportRoutes from './supportRoutes';
import webhookRoutes from './alchemyRoutes';
import { walletRouter } from './walletRoutes';
import telegramRoutes from './telegramRoutes';
import { balanceRoutes } from './balanceRoutes';
import transactionRoutes from './transactionRoutes';
import { chatterpointsRoutes } from './chatterpointsRoutes';

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
  server.register(balanceRoutes);
  server.register(swapRoutes);
  server.register(nftRoutes);
  server.register(uploadRoutes);
  server.register(rampRoutes);
  server.register(supportRoutes);
  server.register(aaveRoutes);
  server.register(chatterpointsRoutes);
  server.register(telegramRoutes);
  server.register(webhookRoutes);
  server.register(stakeRoutes);
}

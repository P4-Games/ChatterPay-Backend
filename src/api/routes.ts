import type { FastifyInstance } from 'fastify';
import aaveRoutes from './aaveRoutes';
import webhookRoutes from './alchemyRoutes';
import { balanceRoutes } from './balanceRoutes';
import { chatterpointsRoutes } from './chatterpointsRoutes';
import nftRoutes from './nftRoutes';
import { pingRoutes } from './pingRoutes';
import { rampRoutes } from './rampRoutes';
import supportRoutes from './supportRoutes';
import swapRoutes from './swapRoutes';
import telegramRoutes from './telegramRoutes';
import tokenRoutes from './tokenRoutes';
import transactionRoutes from './transactionRoutes';
import uploadRoutes from './uploadRoutes';
import userRoutes from './userRoutes';
import { walletRouter } from './walletRoutes';

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
}

import { FastifyInstance } from 'fastify';

import nftRoutes from './nftRoutes';
import swapRoutes from './swapRoutes';
import userRoutes from './userRoutes';
import tokenRoutes from './tokenRoutes';
import { pingRoutes } from './pingRoutes';
import { rampRoutes } from './rampRoutes';
import uploadRoutes from './uploadRoutes';
import supportRoutes from './supportRoutes';
import { walletRouter } from './walletRoutes';
import { balanceRoutes } from './balanceRoutes';
import blockchainRoutes from './blockchainRoutes';
import transactionRoutes from './transactionRoutes';

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
}

import { FastifyInstance } from 'fastify';

import { pingRoute } from './ping';
import nftRoutes from './nftRoutes';
import swapRoutes from './swapRoutes';
import userRoutes from './userRoutes';
import tokenRoutes from './tokenRoutes';
import uploadRoutes from './uploadRoutes';
import { walletRouter } from './walletRouter';
import { balanceRoutes } from './balanceRoutes';
import blockchainRoutes from './blockchainRoutes';
import transactionRoutes from './transactionRoutes';

/**
 * Sets up all routes for the Fastify server.
 * @param {FastifyInstance} server - Fastify server instance
 * @returns {Promise<void>}
 */
export async function setupRoutes(server: FastifyInstance): Promise<void> {
    server.register(pingRoute);
    server.register(transactionRoutes);
    server.register(userRoutes);
    server.register(tokenRoutes);
    server.register(walletRouter);
    server.register(blockchainRoutes);
    server.register(balanceRoutes);
    server.register(swapRoutes);
    server.register(nftRoutes);
    server.register(uploadRoutes);
}

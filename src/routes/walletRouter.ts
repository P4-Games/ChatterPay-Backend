import { FastifyInstance } from 'fastify';
import { createWallet } from '../controllers/newWalletController';

export const walletRouter = async (fastify: FastifyInstance) => {
    fastify.post('/create_wallet/', createWallet);
};

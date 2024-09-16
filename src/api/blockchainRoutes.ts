import { FastifyInstance } from 'fastify';

import {
  createBlockchain,
  updateBlockchain,
  deleteBlockchain,
  getAllBlockchains,
  getBlockchainById,
} from '../controllers/blockchainController';

/**
 * Configures routes related to blockchains.
 * @param fastify - Fastify instance
 */
const blockchainRoutes: (fastify: FastifyInstance) => Promise<void> = async (fastify) => {
  // Route to create a new blockchain
  fastify.post('/blockchains', createBlockchain);
  // Route to get all blockchains
  fastify.get('/blockchains', getAllBlockchains);
  // Route to get a blockchain by its ID
  fastify.get('/blockchains/:id', getBlockchainById);
  // Route to update a blockchain
  fastify.put('/blockchains/:id', updateBlockchain);
  // Route to delete a blockchain
  fastify.delete('/blockchains/:id', deleteBlockchain);
};

export default blockchainRoutes;
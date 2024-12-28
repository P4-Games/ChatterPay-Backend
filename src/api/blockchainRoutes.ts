import { FastifyInstance } from 'fastify';

import {
  createBlockchain,
  updateBlockchain,
  deleteBlockchain,
  getAllBlockchains,
  getBlockchainById
} from '../controllers/blockchainController';

/**
 * Configures routes related to blockchains.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>}
 */
const blockchainRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to create a new blockchain
   * @route POST /blockchains
   */
  fastify.post('/blockchains', createBlockchain);

  /**
   * Route to get all blockchains
   * @route GET /blockchains
   */
  fastify.get('/blockchains', getAllBlockchains);

  /**
   * Route to get a blockchain by its ID
   * @route GET /blockchains/:id
   */
  fastify.get('/blockchains/:id', getBlockchainById);

  /**
   * Route to update a blockchain
   * @route PUT /blockchains/:id
   */
  fastify.put('/blockchains/:id', updateBlockchain);

  /**
   * Route to delete a blockchain
   * @route DELETE /blockchains/:id
   */
  fastify.delete('/blockchains/:id', deleteBlockchain);
};

export default blockchainRoutes;

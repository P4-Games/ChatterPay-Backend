import { FastifyInstance } from 'fastify';

import {
  createBlockchain,
  updateBlockchain,
  getAllBlockchains,
  getBlockchainById
} from '../controllers/blockchainController';

/**
 * Configures routes related to blockchains.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
const blockchainRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to create a new blockchain.
   * @route POST /blockchains
   * @returns {Object} The created blockchain details
   */
  fastify.post('/blockchains', createBlockchain);

  /**
   * Route to get all blockchains.
   * @route GET /blockchains
   * @returns {Array} List of all blockchains
   */
  fastify.get('/blockchains', getAllBlockchains);

  /**
   * Route to get a blockchain by its ID.
   * @route GET /blockchains/:id
   * @param {string} id - The unique identifier of the blockchain
   * @returns {Object} Details of the blockchain with the specified ID
   */
  fastify.get('/blockchains/:id', getBlockchainById);

  /**
   * Route to update a blockchain by its ID.
   * @route PUT /blockchains/:id
   * @param {string} id - The unique identifier of the blockchain to update
   * @returns {Object} Updated details of the blockchain
   */
  fastify.put('/blockchains/:id', updateBlockchain);
};

export default blockchainRoutes;

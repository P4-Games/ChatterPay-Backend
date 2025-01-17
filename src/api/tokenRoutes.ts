import { FastifyInstance } from 'fastify';

import {
  createToken,
  deleteToken,
  updateToken,
  getAllTokens,
  getTokenById,
  issueTokensHandler
} from '../controllers/tokenController';

/**
 * Configures routes related to tokens.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
const tokenRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to create a new token
   * @route POST /tokens
   * @returns {Object} The created token details
   */
  fastify.post('/tokens', createToken);

  /**
   * Route to get all tokens
   * @route GET /tokens
   * @returns {Array} List of all tokens
   */
  fastify.get('/tokens', getAllTokens);

  /**
   * Route to get a specific token by its ID
   * @route GET /tokens/:id
   * @param {string} id - The unique identifier of the token
   * @returns {Object} The details of the specified token
   */
  fastify.get('/tokens/:id', getTokenById);

  /**
   * Route to update a token
   * @route PUT /tokens/:id
   * @param {string} id - The unique identifier of the token to update
   * @returns {Object} The updated token details
   */
  fastify.put('/tokens/:id', updateToken);

  /**
   * Route to delete a token
   * @route DELETE /tokens/:id
   * @param {string} id - The unique identifier of the token to delete
   * @returns {Object} Confirmation of deletion
   */
  fastify.delete('/tokens/:id', deleteToken);

  /**
   * Route to issue demo tokens
   * @route POST /issue { "address": string }
   * @param {string} address - The address to issue tokens to
   * @returns {Object} Details of the issued tokens
   */
  fastify.post('/issue/', issueTokensHandler);
};

export default tokenRoutes;

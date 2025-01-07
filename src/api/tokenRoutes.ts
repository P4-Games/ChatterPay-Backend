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
 * @returns {Promise<void>}
 */
const tokenRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to create a new token
   * @route POST /tokens
   */
  fastify.post('/tokens', createToken);

  /**
   * Route to get all tokens
   * @route GET /tokens
   */
  fastify.get('/tokens', getAllTokens);

  /**
   * Route to get a specific token by its ID
   * @route GET /tokens/:id
   */
  fastify.get('/tokens/:id', getTokenById);

  /**
   * Route to update a token
   * @route PUT /tokens/:id
   */
  fastify.put('/tokens/:id', updateToken);

  /**
   * Route to delete a token
   * @route DELETE /tokens/:id
   */
  fastify.delete('/tokens/:id', deleteToken);

  /**
   * Route to issue demo tokens
   * @route POST /issue { "address": string }
   */
  fastify.post('/issue/', issueTokensHandler);
};

export default tokenRoutes;

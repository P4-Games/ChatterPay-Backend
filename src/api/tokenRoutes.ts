import { FastifyInstance } from 'fastify';

import {
  createToken,
  updateToken,
  deleteToken,
  getAllTokens,
  getTokenById,
} from '../controllers/tokenController';

/**
 * Configures routes related to tokens.
 * @param fastify - Fastify instance
 */
const tokenRoutes: (fastify: FastifyInstance) => Promise<void> = async (fastify) => {
  // Route to create a new token
  fastify.post('/tokens', createToken);
  // Route to get all tokens
  fastify.get('/tokens', getAllTokens);
  // Route to get a specific token by its ID
  fastify.get('/tokens/:id', getTokenById);
  // Route to update a token
  fastify.put('/tokens/:id', updateToken);
  // Route to delete a token
  fastify.delete('/tokens/:id', deleteToken);
};

export default tokenRoutes;
import { FastifyInstance } from 'fastify';
import {
  createToken,
  getAllTokens,
  getTokenById,
  updateToken,
  deleteToken,
} from '../controllers/tokenController';

const tokenRoutes = async (fastify: FastifyInstance) => {
  fastify.post('/tokens', createToken);
  fastify.get('/tokens', getAllTokens);
  fastify.get('/tokens/:id', getTokenById);
  fastify.put('/tokens/:id', updateToken);
  fastify.delete('/tokens/:id', deleteToken);
};

export default tokenRoutes;

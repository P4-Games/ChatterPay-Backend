import { FastifyInstance } from 'fastify';
import {
  createBlockchain,
  getAllBlockchains,
  getBlockchainById,
  updateBlockchain,
  deleteBlockchain,
} from '../controllers/blockchainController';

const blockchainRoutes = async (fastify: FastifyInstance) => {
  fastify.post('/blockchains', createBlockchain);
  fastify.get('/blockchains', getAllBlockchains);
  fastify.get('/blockchains/:id', getBlockchainById);
  fastify.put('/blockchains/:id', updateBlockchain);
  fastify.delete('/blockchains/:id', deleteBlockchain);
};

export default blockchainRoutes;

import { FastifyInstance } from 'fastify';
import { swap } from '../controllers/swapController';

const tokenRoutes = async (fastify: FastifyInstance) => {
    fastify.post('/nft/', swap);
};

export default tokenRoutes;

import { FastifyInstance } from 'fastify';
import { swap } from '../controllers/swapController';

const tokenRoutes = async (fastify: FastifyInstance) => {
    fastify.post('/swap', swap);
};

export default tokenRoutes;

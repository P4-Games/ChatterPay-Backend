import { FastifyInstance } from 'fastify';
import { swap } from '../controllers/swapController';

const swapRoutes = async (fastify: FastifyInstance) => {
    fastify.post('/swap/', swap);
    fastify.post('/swap', swap);
};

export default swapRoutes;

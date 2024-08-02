import { FastifyInstance } from 'fastify';
import { getAAVEYield } from '../services/aaveService';

const aaveRoutes = async (fastify: FastifyInstance) => {
    fastify.get('/yield/:address', getAAVEYield);
};

export default aaveRoutes;

import { FastifyInstance } from 'fastify';
import { getAAVEYield, supply } from '../services/aaveService';

const aaveRoutes = async (fastify: FastifyInstance) => {
    fastify.get('/yield/:address', getAAVEYield);
    fastify.post('/lend/:address', supply);
};

export default aaveRoutes;

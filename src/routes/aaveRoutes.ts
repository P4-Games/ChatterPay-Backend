import { FastifyInstance } from 'fastify';
import { getAAVEYield, supply, withdraw} from '../services/aaveService';

const aaveRoutes = async (fastify: FastifyInstance) => {
    fastify.get('/yield/:address', getAAVEYield);
    fastify.post('/lend', supply);
    fastify.post('/withdraw', withdraw)
};

export default aaveRoutes;

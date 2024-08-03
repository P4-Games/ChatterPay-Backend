import { FastifyInstance } from 'fastify';
import { getAAVEYield, withdraw} from '../services/aaveService';

const aaveRoutes = async (fastify: FastifyInstance) => {
    fastify.get('/yield/:address', getAAVEYield);
    fastify.post('/withdraw', withdraw)
};

export default aaveRoutes;

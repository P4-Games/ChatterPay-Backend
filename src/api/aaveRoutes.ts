import { FastifyInstance } from 'fastify';

import { aaveCreateSupply, aaveGetSupplyInfo } from '../controllers/aaveController';

const aaveRoutes = async (fastify: FastifyInstance): Promise<void> => {
  fastify.post('/aave/supply', aaveCreateSupply);
  fastify.get('/aave/supply', aaveGetSupplyInfo);
};

export default aaveRoutes;

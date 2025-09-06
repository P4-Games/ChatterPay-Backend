import { FastifyInstance } from 'fastify';

import {
  aaveCreateSupply,
  aaveRemoveSupply,
  aaveGetSupplyInfo
} from '../controllers/aaveController';

const aaveRoutes = async (fastify: FastifyInstance): Promise<void> => {
  fastify.post('/aave/supply', aaveCreateSupply);
  fastify.get('/aave/supply', aaveGetSupplyInfo);
  fastify.put('/aave/supply', aaveRemoveSupply);
};

export default aaveRoutes;

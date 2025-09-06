import { FastifyInstance } from 'fastify';

import {
  aaveCreateSupply,
  aaveRemoveSupply,
  aaveGetSupplyInfo
} from '../controllers/aaveController';

const aaveRoutes = async (fastify: FastifyInstance): Promise<void> => {
  fastify.post('/aave/create_supply', aaveCreateSupply);
  fastify.get('/aave/get_supply', aaveGetSupplyInfo);
  fastify.post('/aave/update_supply', aaveRemoveSupply);
};

export default aaveRoutes;

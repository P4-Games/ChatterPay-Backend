import { FastifyInstance } from 'fastify';

import {
  aaveCreateSupply,
  aaveRemoveSupply,
  aaveUpdateSupply,
  aaveGetSupplyInfo
} from '../controllers/aaveController';

const aaveRoutes = async (fastify: FastifyInstance): Promise<void> => {
  fastify.post('/aave/create_supply', aaveCreateSupply);
  fastify.post('/aave/get_supply', aaveGetSupplyInfo);
  fastify.post('/aave/update_supply', aaveUpdateSupply);
  fastify.post('/aave/remove_supply', aaveRemoveSupply);
};

export default aaveRoutes;

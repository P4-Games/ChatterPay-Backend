import { FastifyInstance } from 'fastify';

import {
  createRampUser,
  getCryptoPairPrices,
  getUserRampBalance,
  getUserRampLimits,
  getUserRampValidationStatus,
  rampOff,
  rampOn,
  uploadRampUserDocuments
} from '../controllers/rampController';

/**
 * Registers the ramp routes with the Fastify instance.
 * @param {FastifyInstance} fastify - The Fastify instance
 * @returns {Promise<void>} Resolves once the route is registered
 */
export const rampRoutes = async (fastify: FastifyInstance): Promise<void> => {
  fastify.post('/ramp/user', createRampUser);
  fastify.post('/ramp/user/:userId/compliance/documents', uploadRampUserDocuments);
  fastify.get('/ramp/user/:userId/compliance/status', getUserRampValidationStatus);
  fastify.get('/ramp/user/:userId/limits', getUserRampLimits);
  fastify.get('/ramp/user/:userId/balance', getUserRampBalance);
  fastify.get('/ramp/user/:userId/price', getCryptoPairPrices);
  fastify.post('/ramp/on', rampOn);
  fastify.post('/ramp/off', rampOff);
};

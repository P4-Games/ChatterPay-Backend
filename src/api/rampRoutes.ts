import { FastifyInstance } from 'fastify';

import {
  rampOn,
  rampOff,
  onBoarding,
  createRampUser,
  getRampUserLimits,
  getRampUserBalance,
  checkRampUsersStatus,
  addRampUserBankAccount,
  getRampCryptoPairPrices,
  uploadRampUserDocuments,
  removeRampUserBankAccount,
  getRampUserDocumentsStatus,
  getRampUserValidationStatus
} from '../controllers/rampController';

/**
 * Registers the ramp routes with the Fastify instance.
 * @param {FastifyInstance} fastify - The Fastify instance
 * @returns {Promise<void>} Resolves once the route is registered
 */
export const rampRoutes = async (fastify: FastifyInstance): Promise<void> => {
  fastify.post('/ramp/onboarding', onBoarding);
  fastify.post('/ramp/user', createRampUser);
  fastify.post('/ramp/user/:userId/compliance/documents', uploadRampUserDocuments);
  fastify.post('/ramp/user/:userId/bankaccount/ars', addRampUserBankAccount);
  fastify.delete('/ramp/user/:userId/bankaccount/ars/:accountId', removeRampUserBankAccount);
  fastify.get('/ramp/user/:userId/compliance/documents/status', getRampUserDocumentsStatus);
  fastify.get('/ramp/user/:userId/compliance/status', getRampUserValidationStatus);
  fastify.get('/ramp/user/:userId/limits', getRampUserLimits);
  fastify.get('/ramp/user/:userId/balance', getRampUserBalance);
  fastify.get('/ramp/market/price', getRampCryptoPairPrices);
  fastify.post('/ramp/on', rampOn);
  fastify.post('/ramp/off', rampOff);
  fastify.post('/ramp/users/compliance/status/check', checkRampUsersStatus);
};

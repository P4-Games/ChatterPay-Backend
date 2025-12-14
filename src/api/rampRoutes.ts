import type { FastifyInstance } from 'fastify';

import {
  addRampUserBankAccount,
  checkRampUsersStatus,
  createRampUser,
  generateOnRampLink,
  getRampCryptoPairPrices,
  getRampUserBalance,
  getRampUserDocumentsStatus,
  getRampUserLimits,
  getRampUserValidationStatus,
  linkToOperate,
  onBoarding,
  rampOff,
  rampOn,
  removeRampUserBankAccount,
  uploadRampUserDocuments
} from '../controllers/rampController';

/**
 * Registers the ramp routes with the Fastify instance.
 * @param {FastifyInstance} fastify - The Fastify instance
 * @returns {Promise<void>} Resolves once the route is registered
 */
export const rampRoutes = async (fastify: FastifyInstance): Promise<void> => {
  fastify.post('/ramp/linkToOperate', linkToOperate);
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
  fastify.post('/ramp/onramp/link', generateOnRampLink);
};

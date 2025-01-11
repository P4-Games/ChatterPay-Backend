import { FastifyInstance } from 'fastify';

import {
  rampOn,
  rampOff,
  createRampUser,
  getUserRampLimits,
  getUserRampBalance,
  getCryptoPairPrices,
  checkUsersRampStatus,
  uploadRampUserDocuments,
  getUserRampDocumentsStatus,
  getUserRampValidationStatus,
  addRampUserBankAccount,
  removeRampUserBankAccount
} from '../controllers/rampController';

/**
 * Registers the ramp routes with the Fastify instance.
 * @param {FastifyInstance} fastify - The Fastify instance
 * @returns {Promise<void>} Resolves once the route is registered
 */
export const rampRoutes = async (fastify: FastifyInstance): Promise<void> => {
  fastify.post('/ramp/user', createRampUser);
  fastify.post('/ramp/user/:userId/compliance/documents', uploadRampUserDocuments);
  fastify.post('/ramp/user/:userId/bankaccount/ars', addRampUserBankAccount);
  fastify.delete('/ramp/user/:userId/bankaccount/ars/:accountId', removeRampUserBankAccount);
  fastify.get('/ramp/user/:userId/compliance/documents/status', getUserRampDocumentsStatus);
  fastify.get('/ramp/user/:userId/compliance/status', getUserRampValidationStatus);
  fastify.get('/ramp/user/:userId/limits', getUserRampLimits);
  fastify.get('/ramp/user/:userId/balance', getUserRampBalance);
  fastify.get('/ramp/market/price', getCryptoPairPrices);
  fastify.post('/ramp/on', rampOn);
  fastify.post('/ramp/off', rampOff);
  fastify.post('/ramp/users/compliance/status/check', checkUsersRampStatus);
};

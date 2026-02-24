/**
 * Chain Routes
 *
 * Routes for cross-chain network information.
 */

import type { FastifyInstance } from 'fastify';

import { getChains } from '../controllers/chainController';

export default async function chainRoutes(fastify: FastifyInstance) {
  // GET /chains - List supported destination networks
  fastify.get('/', getChains);
}

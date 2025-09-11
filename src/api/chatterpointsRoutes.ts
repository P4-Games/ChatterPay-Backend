import { FastifyInstance } from 'fastify';

import {
  play,
  stats,
  social,
  createCycle,
  leaderboard
} from '../controllers/chatterpointsController';

/**
 * Routes for ChatterPoints (no classes, pure handlers)
 */
export async function chatterpointsRoutes(fastify: FastifyInstance) {
  fastify.post('/chatterpoints/cycle', createCycle);
  fastify.post('/chatterpoints/play', play);
  fastify.post('/chatterpoints/stats', stats);
  fastify.post('/chatterpoints/leaderboard', leaderboard);
  fastify.post('/chatterpoints/social', social);
}

export default chatterpointsRoutes;

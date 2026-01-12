import type { FastifyInstance } from 'fastify';

import {
  clean,
  createCycle,
  cyclePlays,
  gamesInfo,
  leaderboard,
  play,
  social,
  stats,
  userHistory
} from '../controllers/chatterpointsController';

/**
 * Routes for ChatterPoints (no classes, pure handlers)
 */
export async function chatterpointsRoutes(fastify: FastifyInstance) {
  fastify.post('/chatterpoints/cycle', createCycle);
  fastify.post('/chatterpoints/play', play);
  fastify.post('/chatterpoints/stats', stats);
  fastify.post('/chatterpoints/social', social);
  fastify.post('/chatterpoints/leaderboard', leaderboard);
  fastify.post('/chatterpoints/info', gamesInfo);
  fastify.post('/chatterpoints/clean', clean);
  fastify.post('/chatterpoints/cycle/plays', cyclePlays);
  fastify.post('/chatterpoints/user/history', userHistory);
}

export default chatterpointsRoutes;

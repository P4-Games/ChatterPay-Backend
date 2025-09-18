import { FastifyInstance } from 'fastify';

import {
  play,
  stats,
  clean,
  social,
  gamesInfo,
  cyclePlays,
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
  fastify.post('/chatterpoints/social', social);
  fastify.post('/chatterpoints/leaderboard', leaderboard);
  fastify.post('/chatterpoints/info', gamesInfo);
  fastify.post('/chatterpoints/clean', clean);
  fastify.post('/chatterpoints/cycle/plays', cyclePlays);
}

export default chatterpointsRoutes;

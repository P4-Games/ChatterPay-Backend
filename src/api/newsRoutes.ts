import type { FastifyInstance } from 'fastify';

import { getNews } from '../controllers/newsController';

/**
 * Configures routes related to site-wide announcements.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
const newsRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to get the announcements active at this moment.
   * @route GET /news
   */
  fastify.get('/news', getNews);
};

export default newsRoutes;

import type { FastifyReply, FastifyRequest } from 'fastify';

import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { getActiveNews } from '../services/newsService';

type GetNewsQuery = {
  lang?: string;
};

/**
 * Returns the announcements that are visible right now, resolved to the requested language.
 *
 * @route GET /news
 * @param {FastifyRequest} request - Fastify request, optionally carrying `lang`.
 * @param {FastifyReply} reply - Fastify reply.
 * @returns {Promise<FastifyReply>} The active announcements.
 */
export const getNews = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    const { lang } = request.query as GetNewsQuery;
    const news = await getActiveNews(lang ?? 'en');

    return await returnSuccessResponse(reply, 'News fetched successfully', { news });
  } catch (err) {
    return returnErrorResponse(
      'getNews',
      (err as Error).message ?? '',
      reply,
      500,
      'Internal Server Error'
    );
  }
};

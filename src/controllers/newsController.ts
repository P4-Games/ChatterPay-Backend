import type { FastifyReply, FastifyRequest } from 'fastify';

import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { getActiveNews } from '../services/newsService';

type GetNewsQuery = {
  lang?: string;
  target?: string;
};

/**
 * Returns the announcements that are visible right now, resolved to the requested language.
 *
 * `target` narrows the list to the surface being rendered, `landing` or `dashboard`. Left out, the
 * caller gets every active announcement.
 *
 * @route GET /news
 * @param {FastifyRequest} request - Fastify request, optionally carrying `lang` and `target`.
 * @param {FastifyReply} reply - Fastify reply.
 * @returns {Promise<FastifyReply>} The active announcements.
 */
export const getNews = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    const { lang, target } = request.query as GetNewsQuery;
    const news = await getActiveNews(lang ?? 'en', target);

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

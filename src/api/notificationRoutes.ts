import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  deleteNotification,
  getNotifications,
  markAllNotificationsAsRead
} from '../controllers/notificationController';
import { returnErrorResponse } from '../helpers/requestHelper';

/**
 * Configures routes related to notifications.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
const notificationRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Refuses any notification request that did not arrive with the frontend credential.
   *
   * Registered as a hook rather than per route so a route added later cannot forget it.
   *
   * These three routes read and mutate one user's notification history, and they take the user from
   * `channel_user_id` in the request rather than from the credential. That is the deployment-wide
   * model — the same is true of transfers — so this guard does **not** make them safe against a
   * caller naming somebody else's phone number. What it does is stop a second, independently
   * distributed credential from reaching them at all: the bot has no reason to read a notification
   * feed and none of its tools do, so a leaked bot token should not open one.
   *
   * Real per-user authorization needs an identity this API does not have, and it is tracked
   * separately because it spans every endpoint accepting `channel_user_id`, not only these.
   */
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const { tokenType } = request as FastifyRequest & {
      tokenType?: 'frontend' | 'chatizalo' | null;
    };
    if (tokenType !== 'frontend') {
      await returnErrorResponse(
        'notificationRoutes',
        '',
        reply,
        403,
        'This endpoint is only available to the frontend credential'
      );
    }
  });

  /**
   * Route to get notifications with pagination.
   * @route GET /notifications
   */
  fastify.get('/notifications', getNotifications);

  /**
   * Route to mark all notifications as read.
   * @route PATCH /notifications/mark-read
   */
  fastify.patch('/notifications/mark-read', markAllNotificationsAsRead);

  /**
   * Route to soft delete a notification.
   * @route DELETE /notifications/:notification_id
   */
  fastify.delete('/notifications/:notification_id', deleteNotification);
};

export default notificationRoutes;

import type { FastifyInstance } from 'fastify';

import {
  deleteNotification,
  getNotifications,
  markAllNotificationsAsRead
} from '../controllers/notificationController';

/**
 * Configures routes related to notifications.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
const notificationRoutes = async (fastify: FastifyInstance): Promise<void> => {
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

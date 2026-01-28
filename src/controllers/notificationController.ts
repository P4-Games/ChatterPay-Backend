import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  returnErrorResponse,
  returnSuccessResponse
} from '../helpers/requestHelper';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import { mongoNotificationService } from '../services/mongo/mongoNotificationServices';

type GetNotificationsQuery = {
  channel_user_id: string;
  cursor?: string;
  limit?: string;
};

type MarkReadQuery = {
  channel_user_id: string;
};

type DeleteNotificationParams = {
  notification_id: string;
};

type DeleteNotificationQuery = {
  channel_user_id: string;
};

/**
 * Handles the request to get notifications with pagination.
 *
 * @param {FastifyRequest} request - Fastify request with query params.
 * @param {FastifyReply} reply - Fastify reply object.
 * @returns {Promise<FastifyReply>} Response with paginated notifications.
 */
export const getNotifications = async (
  request: FastifyRequest<{ Querystring: GetNotificationsQuery }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const logKey = '[op:getNotifications]';
  try {
    const { channel_user_id, cursor, limit } = request.query;

    if (!channel_user_id || !isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponse(
        'getNotifications',
        logKey,
        reply,
        400,
        `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
      );
    }

    // Validate cursor if provided (should be valid ISO date string)
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (Number.isNaN(cursorDate.getTime())) {
        return await returnErrorResponse(
          'getNotifications',
          logKey,
          reply,
          400,
          'Invalid cursor format. Must be a valid ISO date string'
        );
      }
    }

    // Parse limit with default of 20, max of 100
    const parsedLimit = limit ? parseInt(limit, 10) : 20;
    if (Number.isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return await returnErrorResponse(
        'getNotifications',
        logKey,
        reply,
        400,
        'Limit must be a number between 1 and 100'
      );
    }

    // Fetch paginated notifications and unread count in parallel
    const [{ notifications, has_more, next_cursor }, unread_count] = await Promise.all([
      mongoNotificationService.getNotificationsWithPagination(
        channel_user_id,
        cursor ?? null,
        parsedLimit
      ),
      mongoNotificationService.getUnreadCount(channel_user_id)
    ]);

    return await returnSuccessResponse(reply, 'Notifications fetched successfully', {
      notifications,
      unread_count,
      has_more,
      next_cursor
    });
  } catch (error) {
    return returnErrorResponse('getNotifications', '', reply, 500, 'Internal Server Error');
  }
};

/**
 * Handles the request to mark all notifications as read.
 *
 * @param {FastifyRequest} request - Fastify request with query params.
 * @param {FastifyReply} reply - Fastify reply object.
 * @returns {Promise<FastifyReply>} Response with modified count.
 */
export const markAllNotificationsAsRead = async (
  request: FastifyRequest<{ Querystring: MarkReadQuery }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const logKey = '[op:markAllNotificationsAsRead]';
  try {
    const { channel_user_id } = request.query;

    if (!channel_user_id || !isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponse(
        'markAllNotificationsAsRead',
        logKey,
        reply,
        400,
        `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
      );
    }

    const modified_count = await mongoNotificationService.markAllAsRead(channel_user_id);

    return await returnSuccessResponse(reply, 'Notifications marked as read', {
      modified_count
    });
  } catch (error) {
    return returnErrorResponse(
      'markAllNotificationsAsRead',
      '',
      reply,
      500,
      'Internal Server Error'
    );
  }
};

/**
 * Handles the request to soft delete a notification.
 *
 * @param {FastifyRequest} request - Fastify request with params and query.
 * @param {FastifyReply} reply - Fastify reply object.
 * @returns {Promise<FastifyReply>} Response with modified count.
 */
export const deleteNotification = async (
  request: FastifyRequest<{
    Params: DeleteNotificationParams;
    Querystring: DeleteNotificationQuery;
  }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const logKey = '[op:deleteNotification]';
  try {
    const { notification_id } = request.params;
    const { channel_user_id } = request.query;

    if (!notification_id) {
      return await returnErrorResponse(
        'deleteNotification',
        logKey,
        reply,
        400,
        'Notification ID is required'
      );
    }

    if (!channel_user_id || !isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponse(
        'deleteNotification',
        logKey,
        reply,
        400,
        `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
      );
    }

    // Validate ObjectId format
    const mongoose = await import('mongoose');
    if (!mongoose.Types.ObjectId.isValid(notification_id)) {
      return await returnErrorResponse(
        'deleteNotification',
        logKey,
        reply,
        400,
        'Invalid notification ID format'
      );
    }

    const modified_count = await mongoNotificationService.softDeleteNotification(
      notification_id,
      channel_user_id
    );

    if (modified_count === 0) {
      return await returnErrorResponse(
        'deleteNotification',
        logKey,
        reply,
        404,
        'Notification not found'
      );
    }

    return await returnSuccessResponse(reply, 'Notification deleted successfully', {
      modified_count
    });
  } catch (error) {
    return returnErrorResponse('deleteNotification', '', reply, 500, 'Internal Server Error');
  }
};

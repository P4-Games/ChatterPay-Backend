import { Logger } from '../../helpers/loggerHelper';
import NotificationModel, { type INotification } from '../../models/notificationModel';

export const mongoNotificationService = {
  /**
   * Creates a new notification.
   *
   * @param {Partial<INotification>} data - Notification data.
   * @returns {Promise<INotification>} Created notification document.
   */
  createNotification: async (data: Partial<INotification>): Promise<INotification> => {
    try {
      const notification = await NotificationModel.create(data);
      return notification;
    } catch (error) {
      Logger.error('createNotification', 'Failed to create notification', (error as Error).message);
      throw error;
    }
  },

  /**
   * Retrieves all notifications.
   *
   * @returns {Promise<INotification[]>} All notifications.
   */
  getAllNotifications: async (): Promise<INotification[]> => {
    try {
      // @ts-expect-error
      return await NotificationModel.find().lean();
    } catch (error) {
      Logger.error(
        'getAllNotifications',
        'Failed to fetch notifications',
        (error as Error).message
      );
      throw error;
    }
  },

  /**
   * Retrieves notifications for a specific recipient.
   *
   * @param {string} recipient - The 'to' field to filter notifications by.
   * @returns {Promise<INotification[]>}
   */
  getNotificationsByRecipient: async (recipient: string): Promise<INotification[]> => {
    try {
      // @ts-expect-error
      return await NotificationModel.find({ to: recipient }).lean();
    } catch (error) {
      Logger.error(
        'getNotificationsByRecipient',
        `Failed to fetch notifications for ${recipient}`,
        (error as Error).message
      );
      throw error;
    }
  },

  /**
   * Marks a notification as read.
   *
   * @param {string} id - Notification ID.
   */
  markAsRead: async (id: string): Promise<void> => {
    try {
      await NotificationModel.updateOne({ _id: id }, { $set: { read_date: new Date() } });
    } catch (error) {
      Logger.error('markAsRead', `Failed to set read_date for ${id}`, (error as Error).message);
      throw error;
    }
  },

  /**
   * Marks a notification as deleted.
   *
   * @param {string} id - Notification ID.
   */
  markAsDeleted: async (id: string): Promise<void> => {
    try {
      await NotificationModel.updateOne({ _id: id }, { $set: { deleted_date: new Date() } });
    } catch (error) {
      Logger.error(
        'markAsDeleted',
        `Failed to set deleted_date for ${id}`,
        (error as Error).message
      );
      throw error;
    }
  },

  /**
   * Retrieves notifications with cursor-based pagination.
   *
   * @param {string} phoneNumber - The phone number to filter notifications by.
   * @param {string | null} cursor - ISO timestamp cursor for pagination (sent_date).
   * @param {number} limit - Number of items to return.
   * @returns {Promise<{ notifications: INotification[]; has_more: boolean; next_cursor: string | null }>}
   */
  getNotificationsWithPagination: async (
    phoneNumber: string,
    cursor: string | null,
    limit: number
  ): Promise<{ notifications: INotification[]; has_more: boolean; next_cursor: string | null }> => {
    try {
      const query: {
        to: string;
        deleted_date: null;
        sent_date?: { $lt: Date };
      } = {
        to: phoneNumber,
        deleted_date: null
      };

      if (cursor) {
        query.sent_date = { $lt: new Date(cursor) };
      }

      // Fetch limit + 1 to check if there are more results
      const notifications = await NotificationModel.find(query)
        .sort({ sent_date: -1 })
        .limit(limit + 1)
        .lean();

      const has_more = notifications.length > limit;
      const results = has_more ? notifications.slice(0, limit) : notifications;
      const next_cursor =
        has_more && results.length > 0 ? results[results.length - 1].sent_date.toISOString() : null;

      return {
        // @ts-expect-error
        notifications: results,
        has_more,
        next_cursor
      };
    } catch (error) {
      Logger.error(
        'getNotificationsWithPagination',
        `Failed to fetch paginated notifications for ${phoneNumber}`,
        (error as Error).message
      );
      throw error;
    }
  },

  /**
   * Counts unread notifications for a specific user.
   *
   * @param {string} phoneNumber - The phone number to count notifications for.
   * @returns {Promise<number>} Count of unread notifications.
   */
  getUnreadCount: async (phoneNumber: string): Promise<number> => {
    try {
      return await NotificationModel.countDocuments({
        to: phoneNumber,
        deleted_date: null,
        read_date: null
      });
    } catch (error) {
      Logger.error(
        'getUnreadCount',
        `Failed to count unread notifications for ${phoneNumber}`,
        (error as Error).message
      );
      throw error;
    }
  },

  /**
   * Marks all unread notifications as read for a specific user.
   *
   * @param {string} phoneNumber - The phone number to mark notifications for.
   * @returns {Promise<number>} Number of modified documents.
   */
  markAllAsRead: async (phoneNumber: string): Promise<number> => {
    try {
      const result = await NotificationModel.updateMany(
        {
          to: phoneNumber,
          deleted_date: null,
          read_date: null
        },
        {
          $set: { read_date: new Date() }
        }
      );

      return result.modifiedCount ?? 0;
    } catch (error) {
      Logger.error(
        'markAllAsRead',
        `Failed to mark all notifications as read for ${phoneNumber}`,
        (error as Error).message
      );
      throw error;
    }
  },

  /**
   * Soft deletes a notification with security check.
   *
   * @param {string} notificationId - The notification ID to delete.
   * @param {string} phoneNumber - The phone number to verify ownership.
   * @returns {Promise<number>} Number of modified documents (0 or 1).
   */
  softDeleteNotification: async (notificationId: string, phoneNumber: string): Promise<number> => {
    try {
      const result = await NotificationModel.updateOne(
        {
          _id: notificationId,
          to: phoneNumber,
          deleted_date: null
        },
        {
          $set: { deleted_date: new Date() }
        }
      );

      return result.modifiedCount ?? 0;
    } catch (error) {
      Logger.error(
        'softDeleteNotification',
        `Failed to soft delete notification ${notificationId}`,
        (error as Error).message
      );
      throw error;
    }
  }
};

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
  }
};

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import NotificationModel from '../../../src/models/notificationModel';
import { mongoNotificationService } from '../../../src/services/mongo/mongoNotificationServices';

describe('mongoNotificationServices', () => {
  const phoneNumber = '5492233049354';
  const otherPhoneNumber = '5491100000000';

  beforeEach(async () => {
    await NotificationModel.deleteMany({});
  });

  afterEach(async () => {
    await NotificationModel.deleteMany({});
  });

  describe('getNotificationsWithPagination', () => {
    it('returns latest notifications when no cursor is provided', async () => {
      // Create 3 notifications with different dates
      const baseDate = new Date('2025-01-01T12:00:00Z');
      await NotificationModel.create([
        {
          to: phoneNumber,
          message: 'Notif 1',
          sent_date: new Date(baseDate.getTime() + 1000),
          media: 'INTERNAL',
          template: 't1'
        },
        {
          to: phoneNumber,
          message: 'Notif 2',
          sent_date: new Date(baseDate.getTime() + 2000),
          media: 'INTERNAL',
          template: 't2'
        },
        {
          to: phoneNumber,
          message: 'Notif 3',
          sent_date: new Date(baseDate.getTime() + 3000),
          media: 'INTERNAL',
          template: 't3'
        }
      ]);

      const result = await mongoNotificationService.getNotificationsWithPagination(
        phoneNumber,
        null,
        2
      );

      expect(result.notifications).toHaveLength(2);
      expect(result.notifications[0].message).toBe('Notif 3');
      expect(result.notifications[1].message).toBe('Notif 2');
      expect(result.has_more).toBe(true);
      expect(result.next_cursor).toBe(new Date(baseDate.getTime() + 2000).toISOString());
    });

    it('returns notifications older than the cursor', async () => {
      const baseDate = new Date('2025-01-01T12:00:00Z');
      await NotificationModel.create([
        {
          to: phoneNumber,
          message: 'Notif 1',
          sent_date: new Date(baseDate.getTime() + 1000),
          media: 'INTERNAL',
          template: 't1'
        },
        {
          to: phoneNumber,
          message: 'Notif 2',
          sent_date: new Date(baseDate.getTime() + 2000),
          media: 'INTERNAL',
          template: 't2'
        },
        {
          to: phoneNumber,
          message: 'Notif 3',
          sent_date: new Date(baseDate.getTime() + 3000),
          media: 'INTERNAL',
          template: 't3'
        }
      ]);

      const cursor = new Date(baseDate.getTime() + 3000).toISOString();
      const result = await mongoNotificationService.getNotificationsWithPagination(
        phoneNumber,
        cursor,
        2
      );

      expect(result.notifications).toHaveLength(2);
      expect(result.notifications[0].message).toBe('Notif 2');
      expect(result.notifications[1].message).toBe('Notif 1');
      expect(result.has_more).toBe(false);
      expect(result.next_cursor).toBeNull();
    });

    it('ignores deleted notifications', async () => {
      await NotificationModel.create([
        {
          to: phoneNumber,
          message: 'Active',
          deleted_date: null,
          media: 'INTERNAL',
          template: 't1',
          sent_date: new Date()
        },
        {
          to: phoneNumber,
          message: 'Deleted',
          deleted_date: new Date(),
          media: 'INTERNAL',
          template: 't1',
          sent_date: new Date()
        }
      ]);

      const result = await mongoNotificationService.getNotificationsWithPagination(
        phoneNumber,
        null,
        10
      );

      expect(result.notifications).toHaveLength(1);
      expect(result.notifications[0].message).toBe('Active');
    });
  });

  describe('getUnreadCount', () => {
    it('counts only unread and non-deleted notifications', async () => {
      await NotificationModel.create([
        {
          to: phoneNumber,
          message: 'Unread',
          read_date: null,
          deleted_date: null,
          media: 'INTERNAL',
          template: 't1',
          sent_date: new Date()
        },
        {
          to: phoneNumber,
          message: 'Read',
          read_date: new Date(),
          deleted_date: null,
          media: 'INTERNAL',
          template: 't1',
          sent_date: new Date()
        },
        {
          to: phoneNumber,
          message: 'Unread Deleted',
          read_date: null,
          deleted_date: new Date(),
          media: 'INTERNAL',
          template: 't1',
          sent_date: new Date()
        },
        {
          to: otherPhoneNumber,
          message: 'Other User',
          read_date: null,
          deleted_date: null,
          media: 'INTERNAL',
          template: 't1',
          sent_date: new Date()
        }
      ]);

      const count = await mongoNotificationService.getUnreadCount(phoneNumber);
      expect(count).toBe(1);
    });
  });

  describe('markAllAsRead', () => {
    it('updates read_date for all unread notifications', async () => {
      await NotificationModel.create([
        {
          to: phoneNumber,
          message: 'Unread 1',
          read_date: null,
          media: 'INTERNAL',
          template: 't1',
          sent_date: new Date()
        },
        {
          to: phoneNumber,
          message: 'Unread 2',
          read_date: null,
          media: 'INTERNAL',
          template: 't1',
          sent_date: new Date()
        },
        {
          to: phoneNumber,
          message: 'Already Read',
          read_date: new Date('2024-01-01'),
          media: 'INTERNAL',
          template: 't1',
          sent_date: new Date()
        },
        {
          to: otherPhoneNumber,
          message: 'Other User',
          read_date: null,
          media: 'INTERNAL',
          template: 't1',
          sent_date: new Date()
        }
      ]);

      const modifiedCount = await mongoNotificationService.markAllAsRead(phoneNumber);
      expect(modifiedCount).toBe(2);

      const unreadCount = await mongoNotificationService.getUnreadCount(phoneNumber);
      expect(unreadCount).toBe(0);

      // Verify other user was not affected
      const otherUnreadCount = await mongoNotificationService.getUnreadCount(otherPhoneNumber);
      expect(otherUnreadCount).toBe(1);
    });
  });

  describe('softDeleteNotification', () => {
    it('sets deleted_date for a valid notification', async () => {
      const notif = await NotificationModel.create({
        to: phoneNumber,
        message: 'Delete me',
        media: 'INTERNAL',
        template: 't1',
        sent_date: new Date()
      });

      const modifiedCount = await mongoNotificationService.softDeleteNotification(
        notif._id.toString(),
        phoneNumber
      );

      expect(modifiedCount).toBe(1);

      const updated = await NotificationModel.findById(notif._id);
      expect(updated?.deleted_date).toBeInstanceOf(Date);
    });

    it('fails if notification belongs to another user', async () => {
      const notif = await NotificationModel.create({
        to: otherPhoneNumber,
        message: 'Not mine',
        media: 'INTERNAL',
        template: 't1',
        sent_date: new Date()
      });

      const modifiedCount = await mongoNotificationService.softDeleteNotification(
        notif._id.toString(),
        phoneNumber
      );

      expect(modifiedCount).toBe(0);

      const updated = await NotificationModel.findById(notif._id);
      expect(updated?.deleted_date).toBeNull();
    });
  });
});

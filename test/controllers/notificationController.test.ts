import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteNotification,
  getNotifications,
  markAllNotificationsAsRead
} from '../../src/controllers/notificationController';
import { mongoNotificationService } from '../../src/services/mongo/mongoNotificationServices';

// Mock the service
vi.mock('../../src/services/mongo/mongoNotificationServices', () => ({
  mongoNotificationService: {
    getNotificationsWithPagination: vi.fn(),
    getUnreadCount: vi.fn(),
    markAllAsRead: vi.fn(),
    softDeleteNotification: vi.fn()
  }
}));

describe('notificationController', () => {
  let mockReply: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis()
    };
  });

  describe('getNotifications', () => {
    it('returns 400 if channel_user_id is missing', async () => {
      const mockRequest = { query: {} } as any;
      await getNotifications(mockRequest, mockReply);
      expect(mockReply.status).toHaveBeenCalledWith(400);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          data: expect.objectContaining({ message: expect.stringContaining('channel_user_id') })
        })
      );
    });

    it('returns 400 if limit is invalid', async () => {
      const mockRequest = {
        query: { channel_user_id: '5492233049354', limit: 'invalid' }
      } as any;
      await getNotifications(mockRequest, mockReply);
      expect(mockReply.status).toHaveBeenCalledWith(400);
    });

    it('returns 200 and data on success', async () => {
      const mockRequest = {
        query: { channel_user_id: '5492233049354' }
      } as any;

      (mongoNotificationService.getNotificationsWithPagination as any).mockResolvedValue({
        notifications: [],
        has_more: false,
        next_cursor: null
      });
      (mongoNotificationService.getUnreadCount as any).mockResolvedValue(5);

      await getNotifications(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(200);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({ unread_count: 5 })
        })
      );
    });
  });

  describe('markAllNotificationsAsRead', () => {
    it('returns 200 and modified count', async () => {
      const mockRequest = {
        query: { channel_user_id: '5492233049354' }
      } as any;

      (mongoNotificationService.markAllAsRead as any).mockResolvedValue(10);

      await markAllNotificationsAsRead(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(200);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ modified_count: 10 })
        })
      );
    });
  });

  describe('deleteNotification', () => {
    it('returns 400 if notification_id is not a valid ObjectId', async () => {
      const mockRequest = {
        params: { notification_id: 'invalid-id' },
        query: { channel_user_id: '5492233049354' }
      } as any;

      await deleteNotification(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(400);
    });

    it('returns 404 if softDelete returns 0', async () => {
      const mockRequest = {
        params: { notification_id: '507f1f77bcf86cd799439011' },
        query: { channel_user_id: '5492233049354' }
      } as any;

      (mongoNotificationService.softDeleteNotification as any).mockResolvedValue(0);

      await deleteNotification(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(404);
    });

    it('returns 200 on successful delete', async () => {
      const mockRequest = {
        params: { notification_id: '507f1f77bcf86cd799439011' },
        query: { channel_user_id: '5492233049354' }
      } as any;

      (mongoNotificationService.softDeleteNotification as any).mockResolvedValue(1);

      await deleteNotification(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(200);
    });
  });
});

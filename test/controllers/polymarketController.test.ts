import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  polymarketGetPublicTerms,
  polymarketPurchase,
  polymarketSendTerms
} from '../../src/controllers/polymarketController';
import * as notificationService from '../../src/services/notificationService';
import * as polymarketService from '../../src/services/polymarket';
import * as userService from '../../src/services/userService';

// Mock config
vi.mock('../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/constants')>();
  return {
    ...actual,
    POLYMARKET_ENABLED: true,
    CHATTERPAY_DOMAIN: 'https://chatterpay.net'
  };
});

// Mock helpers
vi.mock('../../src/helpers/validationHelper', () => ({
  isValidPhoneNumber: vi.fn((phone) => phone && phone.length >= 10 && /^\d+$/.test(phone))
}));

// Mock services
vi.mock('../../src/services/polymarket', () => ({
  getCurrentTerms: vi.fn(),
  hasAcceptedCurrentTerms: vi.fn(),
  MIN_BUY_ORDER_USD: 1.5,
  POLYMARKET_MIN_PRICE: 0.001,
  POLYMARKET_MAX_PRICE: 0.999,
  BRIDGE_FEE_BUFFER: 1.02
}));

vi.mock('../../src/services/userService', () => ({
  getUser: vi.fn()
}));

vi.mock('../../src/services/notificationService', () => ({
  sendPolymarketDisabledNotification: vi.fn(),
  sendPolymarketTermsNotAcceptedNotification: vi.fn(),
  sendPolymarketTermsRequest: vi.fn()
}));

describe('polymarketController - Terms and Conditions Endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('polymarketGetPublicTerms', () => {
    it('should return terms successfully when available', async () => {
      const mockTerms = {
        version: 1,
        content: 'Test Terms content',
        effective_date: new Date('2026-01-01T00:00:00Z')
      };
      vi.mocked(polymarketService.getCurrentTerms).mockResolvedValueOnce(mockTerms);

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockImplementation((val) => val)
      } as unknown as FastifyReply;

      const result = await polymarketGetPublicTerms({} as FastifyRequest, mockReply);

      expect(polymarketService.getCurrentTerms).toHaveBeenCalled();
      expect(result).toMatchObject({
        status: 'success',
        data: {
          version: 1,
          content: 'Test Terms content',
          effective_date: mockTerms.effective_date,
          terms_url: 'https://chatterpay.net/polymarket/terms'
        }
      });
    });

    it('should return 404 when terms not found', async () => {
      vi.mocked(polymarketService.getCurrentTerms).mockResolvedValueOnce(null);

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockImplementation((val) => val)
      } as unknown as FastifyReply;

      const result = await polymarketGetPublicTerms({} as FastifyRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(404);
      expect(result).toMatchObject({
        status: 'error',
        data: { message: 'Terms not found' }
      });
    });

    it('should return 500 when service fails', async () => {
      vi.mocked(polymarketService.getCurrentTerms).mockRejectedValueOnce(new Error('DB Error'));

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockImplementation((val) => val)
      } as unknown as FastifyReply;

      const result = await polymarketGetPublicTerms({} as FastifyRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(500);
      expect(result).toMatchObject({
        status: 'error',
        data: { message: 'Failed to fetch terms' }
      });
    });
  });

  describe('polymarketSendTerms', () => {
    const mockRequest = {
      body: {
        channel_user_id: '5491122334455'
      }
    } as unknown as FastifyRequest<{ Body: any }>;

    it('should send terms request successfully when user and terms exist', async () => {
      const mockUser = {
        phone_number: '5491122334455',
        settings: { notifications: { language: 'en' } }
      };
      const mockTerms = {
        version: 1,
        content: 'Test Terms content',
        effective_date: new Date('2026-01-01T00:00:00Z')
      };

      vi.mocked(userService.getUser).mockResolvedValueOnce(mockUser as any);
      vi.mocked(polymarketService.getCurrentTerms).mockResolvedValueOnce(mockTerms);
      vi.mocked(notificationService.sendPolymarketTermsRequest).mockResolvedValueOnce();

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockImplementation((val) => val)
      } as unknown as FastifyReply;

      const result = await polymarketSendTerms(mockRequest, mockReply);

      expect(userService.getUser).toHaveBeenCalledWith('5491122334455');
      expect(polymarketService.getCurrentTerms).toHaveBeenCalled();
      expect(notificationService.sendPolymarketTermsRequest).toHaveBeenCalledWith(
        '5491122334455',
        '1',
        'https://chatterpay.net/polymarket/terms'
      );
      expect(result).toMatchObject({
        status: 'success',
        data: { message: 'NO_REPLY_REQUIRED' }
      });
    });

    it('should return 400 when channel_user_id is invalid or missing', async () => {
      const invalidRequest = {
        body: { channel_user_id: '' }
      } as unknown as FastifyRequest<{ Body: any }>;

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockImplementation((val) => val)
      } as unknown as FastifyReply;

      const result = await polymarketSendTerms(invalidRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(400);
      expect(result).toMatchObject({
        status: 'error',
        data: { message: 'Invalid or missing channel_user_id' }
      });
    });

    it('should return 404 when terms not found', async () => {
      const mockUser = {
        phone_number: '5491122334455',
        settings: { notifications: { language: 'en' } }
      };

      vi.mocked(userService.getUser).mockResolvedValueOnce(mockUser as any);
      vi.mocked(polymarketService.getCurrentTerms).mockResolvedValueOnce(null);

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockImplementation((val) => val)
      } as unknown as FastifyReply;

      const result = await polymarketSendTerms(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(404);
      expect(result).toMatchObject({
        status: 'error',
        data: { message: 'Terms not found' }
      });
    });

    it('should return 500 when service fails', async () => {
      const mockUser = {
        phone_number: '5491122334455',
        settings: { notifications: { language: 'en' } }
      };

      vi.mocked(userService.getUser).mockResolvedValueOnce(mockUser as any);
      vi.mocked(polymarketService.getCurrentTerms).mockRejectedValueOnce(new Error('DB Error'));

      const mockReply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockImplementation((val) => val)
      } as unknown as FastifyReply;

      const result = await polymarketSendTerms(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(500);
      expect(result).toMatchObject({
        status: 'error',
        data: { message: 'Failed to send terms request' }
      });
    });
  });

  describe('polymarketPurchase - minimum BUY order value', () => {
    const mockUser = {
      phone_number: '5491122334455',
      settings: { notifications: { language: 'en' } }
    };

    const makeReply = (): FastifyReply =>
      ({
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockImplementation((val) => val)
      }) as unknown as FastifyReply;

    const makeRequest = (price: number, size: number) =>
      ({
        body: {
          channel_user_id: '5491122334455',
          token_id: 'token-123',
          price,
          size,
          side: 'BUY'
        }
      }) as unknown as FastifyRequest<{ Body: any }>;

    it('should reject BUY orders below the $1.50 minimum', async () => {
      vi.mocked(userService.getUser).mockResolvedValueOnce(mockUser as any);

      const mockReply = makeReply();
      // 0.5 × 2 = $1.00 < $1.50
      const result = await polymarketPurchase(makeRequest(0.5, 2), mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(400);
      expect(result).toMatchObject({ status: 'error' });
      expect((result as any).data.message).toContain('below the $1.50 minimum');
    });

    it('should reject BUY orders just under the minimum', async () => {
      vi.mocked(userService.getUser).mockResolvedValueOnce(mockUser as any);

      const mockReply = makeReply();
      // 0.0855 × 17 = $1.4535 < $1.50
      const result = await polymarketPurchase(makeRequest(0.0855, 17), mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(400);
      expect((result as any).data.message).toContain('below the $1.50 minimum');
    });

    it('should not reject BUY orders at or above the minimum for the min-value rule', async () => {
      vi.mocked(userService.getUser).mockResolvedValueOnce(mockUser as any);

      const mockReply = makeReply();
      // 0.5 × 3 = $1.50 — passes the min check, fails later on terms (no account)
      const result = await polymarketPurchase(makeRequest(0.5, 3), mockReply);

      expect((result as any).data.message).not.toContain('below the $1.50 minimum');
    });
  });
});

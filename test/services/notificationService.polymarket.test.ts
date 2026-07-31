import { beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationModel from '../../src/models/notificationModel';
import { NotificationEnum, TemplateType } from '../../src/models/templateModel';
import { UserModel } from '../../src/models/userModel';
import { cacheService } from '../../src/services/cache/cacheService';
import { chatizaloService } from '../../src/services/chatizalo/chatizaloService';
import { sendPolymarketTermsRequest } from '../../src/services/notificationService';

vi.mock('../../src/services/chatizalo/chatizaloService', () => ({
  chatizaloService: {
    sendInteractiveMessage: vi.fn().mockResolvedValue('ok')
  }
}));

describe('notificationService - polymarket terms request', () => {
  const channelUserId = '1234567890';

  beforeEach(async () => {
    vi.clearAllMocks();
    cacheService.clearAllCaches();

    // Create a mock user
    await UserModel.create({
      phone_number: channelUserId,
      wallets: [],
      settings: {
        notifications: { language: 'en' }
      }
    });
  });

  it('should use database template and format variables if it exists', async () => {
    // Seed templates including polymarket_terms_request
    const baseNotification = {
      title: { en: 'Default Title', es: 'Default Title', pt: 'Default Title' },
      message: { en: 'Default Message', es: 'Default Message', pt: 'Default Message' }
    };

    const notifications: Record<string, any> = Object.fromEntries(
      Object.values(NotificationEnum).map((key) => [key, baseNotification])
    );

    // Custom template for polymarket_terms_request
    notifications[NotificationEnum.polymarket_terms_request] = {
      title: {
        en: 'Accept Polymarket Terms',
        es: 'Acepta los términos de Polymarket',
        pt: 'Aceite os termos da Polymarket'
      },
      message: {
        en: 'Please accept terms (v{0}) at {1} to continue.',
        es: 'Por favor acepta los términos (v{0}) en {1} para continuar.',
        pt: 'Por favor aceite os termos (v{0}) em {1} para continuar.'
      }
    };

    await TemplateType.create({ notifications });

    await sendPolymarketTermsRequest(channelUserId, '2.0', 'https://terms.url');

    // 1. Verify chatizaloService.sendInteractiveMessage was called with formatted message
    expect(chatizaloService.sendInteractiveMessage).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(chatizaloService.sendInteractiveMessage).mock.calls[0][0];
    expect(callArgs.channel_user_id).toBe(channelUserId);
    expect(callArgs.message.header_text).toBe('Accept Polymarket Terms');
    expect(callArgs.message.body_text).toBe(
      'Please accept terms (v2.0) at https://terms.url to continue.'
    );
    expect((callArgs.message as any).buttons).toEqual([
      { id: 'polymarket_terms_accept', title: 'Accept Terms' },
      { id: 'polymarket_terms_decline', title: 'Decline' }
    ]);

    // 2. Verify notification is persisted in database
    const persisted = await NotificationModel.findOne({ to: channelUserId });
    expect(persisted).toBeDefined();
    expect(persisted?.message).toBe('Please accept terms (v2.0) at https://terms.url to continue.');
    expect(persisted?.template).toBe(NotificationEnum.polymarket_terms_request);
  });

  it('should fall back to hardcoded default template if database query fails or template is empty', async () => {
    // DB has no templates
    await sendPolymarketTermsRequest(channelUserId, '1.5', 'https://fallback.url');

    // 1. Verify fallback interactive message sent
    expect(chatizaloService.sendInteractiveMessage).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(chatizaloService.sendInteractiveMessage).mock.calls[0][0];
    expect(callArgs.channel_user_id).toBe(channelUserId);
    expect(callArgs.message.header_text).toBe('Polymarket Terms');
    expect(callArgs.message.body_text).toContain('accept their Terms of Service (v1.5)');
    expect(callArgs.message.body_text).toContain('https://fallback.url');

    // 2. Verify fallback message persisted
    const persisted = await NotificationModel.findOne({ to: channelUserId });
    expect(persisted).toBeDefined();
    expect(persisted?.message).toContain('accept their Terms of Service (v1.5)');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationEnum, TemplateType } from '../../src/models/templateModel';
import { UserModel } from '../../src/models/userModel';
import { cacheService } from '../../src/services/cache/cacheService';
import { chatizaloService } from '../../src/services/chatizalo/chatizaloService';
import { sendReceivedExternalTransferNotification } from '../../src/services/notificationService';

vi.mock('../../src/services/chatizalo/chatizaloService', () => ({
  chatizaloService: {
    sendBotNotification: vi.fn().mockResolvedValue('ok')
  }
}));

describe('notificationService (external deposit notification)', () => {
  const seedTemplates = async (opts: { externalUtilityEnabled: boolean }) => {
    const baseNotification = {
      title: { en: 'Title', es: 'Title', pt: 'Title' },
      message: { en: 'Message', es: 'Message', pt: 'Message' }
    };

    const notifications: Record<string, unknown> = Object.fromEntries(
      Object.values(NotificationEnum).map((key) => [key, baseNotification])
    );

    notifications[NotificationEnum.incoming_transfer_external] = {
      title: { en: 'Incoming', es: 'Incoming', pt: 'Incoming' },
      message: {
        en: 'From [FROM] sent [AMOUNT] [TOKEN]',
        es: 'From [FROM] sent [AMOUNT] [TOKEN]',
        pt: 'From [FROM] sent [AMOUNT] [TOKEN]'
      },
      ...(opts.externalUtilityEnabled
        ? {
            utility: {
              enabled: true,
              template_key: 'external_deposit_update',
              param_order: ['from', 'amount', 'token']
            }
          }
        : {})
    };

    await TemplateType.create({ notifications });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    cacheService.clearAllCaches();
  });

  it('Case A: incoming_transfer_external with utility config sends dual payload', async () => {
    await UserModel.create({
      phone_number: '2222222222',
      wallets: [],
      settings: { notifications: { language: 'es' } }
    });
    await seedTemplates({ externalUtilityEnabled: true });

    await sendReceivedExternalTransferNotification(
      '1111111111',
      'Alice',
      '2222222222',
      '10.50',
      'USDC'
    );

    expect(chatizaloService.sendBotNotification).toHaveBeenCalledTimes(1);

    const payload = (chatizaloService.sendBotNotification as any).mock.calls[0][0];
    expect(payload.channel_user_id).toBe('2222222222');
    expect(payload.message).toBe('From 1111111111 (Alice) sent 10.50 USDC');

    expect(payload.message_kind).toBe('utility');
    expect(payload.preferred_language).toBe('es');
    expect(payload.template_key).toBe('external_deposit_update');
    expect(payload.template_params).toEqual(['1111111111 (Alice)', '10.50', 'USDC']);
  });

  it('Case B: incoming_transfer_external without utility config keeps legacy payload', async () => {
    await UserModel.create({
      phone_number: '2222222222',
      wallets: [],
      settings: { notifications: { language: 'en' } }
    });
    await seedTemplates({ externalUtilityEnabled: false });

    await sendReceivedExternalTransferNotification(
      '3333333333',
      null,
      '2222222222',
      '10.50',
      'USDC'
    );

    expect(chatizaloService.sendBotNotification).toHaveBeenCalledTimes(1);

    const payload = (chatizaloService.sendBotNotification as any).mock.calls[0][0];
    expect(payload.channel_user_id).toBe('2222222222');
    expect(payload.message).toBe('From 3333333333 sent 10.50 USDC');
    expect(payload).not.toHaveProperty('message_kind');
    expect(payload).not.toHaveProperty('preferred_language');
    expect(payload).not.toHaveProperty('template_key');
    expect(payload).not.toHaveProperty('template_params');
  });

  it('Case C: invalid recipient phone skips notification', async () => {
    await sendReceivedExternalTransferNotification('1111111111', null, 'invalid', '10.50', 'USDC');

    expect(chatizaloService.sendBotNotification).not.toHaveBeenCalled();
  });
});

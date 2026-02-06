import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationEnum, TemplateType } from '../../src/models/templateModel';
import { UserModel } from '../../src/models/userModel';
import { cacheService } from '../../src/services/cache/cacheService';
import { chatizaloService } from '../../src/services/chatizalo/chatizaloService';
import {
  persistAndSendNotification,
  sendReceivedTransferNotification
} from '../../src/services/notificationService';

vi.mock('../../src/services/chatizalo/chatizaloService', () => ({
  chatizaloService: {
    sendBotNotification: vi.fn().mockResolvedValue('ok')
  }
}));

describe('notificationService (transfer utility dual payload)', () => {
  const seedTemplates = async (opts: { incomingUtilityEnabled: boolean }) => {
    const baseNotification = {
      title: { en: 'Title', es: 'Title', pt: 'Title' },
      message: { en: 'Message', es: 'Message', pt: 'Message' }
    };

    const notifications: Record<string, unknown> = Object.fromEntries(
      Object.values(NotificationEnum).map((key) => [key, baseNotification])
    );

    const incomingTransferNotification = {
      title: { en: 'Incoming', es: 'Incoming', pt: 'Incoming' },
      message: {
        en: 'From [FROM] sent [AMOUNT] [TOKEN][NOTES]',
        es: 'From [FROM] sent [AMOUNT] [TOKEN][NOTES]',
        pt: 'From [FROM] sent [AMOUNT] [TOKEN][NOTES]'
      },
      ...(opts.incomingUtilityEnabled
        ? {
            utility: {
              enabled: true,
              template_key: 'transfer_update',
              param_order: ['from', 'amount', 'token']
            }
          }
        : {})
    };

    notifications[NotificationEnum.incoming_transfer] = incomingTransferNotification;
    notifications[NotificationEnum.incoming_transfer_w_note] = incomingTransferNotification;

    await TemplateType.create({ notifications });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    cacheService.clearAllCaches();
  });

  it('Case A: incoming_transfer with utility config sends dual payload', async () => {
    await UserModel.create({
      phone_number: '2222222222',
      wallets: [],
      settings: { notifications: { language: 'es' } }
    });
    await seedTemplates({ incomingUtilityEnabled: true });

    await sendReceivedTransferNotification(
      '1111111111',
      'Alice',
      '2222222222',
      '10.50',
      'USDC',
      'Thanks'
    );

    expect(chatizaloService.sendBotNotification).toHaveBeenCalledTimes(1);

    const payload = (chatizaloService.sendBotNotification as any).mock.calls[0][0];
    expect(payload.channel_user_id).toBe('2222222222');
    expect(payload.message).toBe("From 1111111111 (Alice) sent 10.50 USDC\n('Thanks')");

    expect(payload.message_kind).toBe('utility');
    expect(payload.preferred_language).toBe('es');
    expect(payload.template_key).toBe('transfer_update');
    expect(payload.template_params).toEqual(['1111111111 (Alice)', '10.50', 'USDC']);
  });

  it('Case B: incoming_transfer without utility config keeps legacy payload', async () => {
    await UserModel.create({
      phone_number: '2222222222',
      wallets: [],
      settings: { notifications: { language: 'en' } }
    });
    await seedTemplates({ incomingUtilityEnabled: false });

    await sendReceivedTransferNotification(
      '1111111111',
      'Alice',
      '2222222222',
      '10.50',
      'USDC',
      ''
    );

    expect(chatizaloService.sendBotNotification).toHaveBeenCalledTimes(1);

    const payload = (chatizaloService.sendBotNotification as any).mock.calls[0][0];
    expect(payload.channel_user_id).toBe('2222222222');
    expect(payload).not.toHaveProperty('message_kind');
    expect(payload).not.toHaveProperty('preferred_language');
    expect(payload).not.toHaveProperty('template_key');
    expect(payload).not.toHaveProperty('template_params');
  });

  it('Case C: outgoing_transfer payload remains text-only', async () => {
    await persistAndSendNotification({
      to: '2222222222',
      messageBot: 'Outgoing transfer message',
      messagePush: 'Outgoing transfer message',
      template: NotificationEnum.outgoing_transfer,
      sendBot: true
    });

    expect(chatizaloService.sendBotNotification).toHaveBeenCalledTimes(1);

    const payload = (chatizaloService.sendBotNotification as any).mock.calls[0][0];
    expect(payload.channel_user_id).toBe('2222222222');
    expect(payload.message).toBe('Outgoing transfer message');
    expect(payload).not.toHaveProperty('message_kind');
    expect(payload).not.toHaveProperty('preferred_language');
    expect(payload).not.toHaveProperty('template_key');
    expect(payload).not.toHaveProperty('template_params');
  });
});

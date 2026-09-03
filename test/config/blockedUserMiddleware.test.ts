import { beforeEach, describe, expect, it, vi } from 'vitest';

import { USER_BLOCKED_ERROR_CODE, USER_BLOCKED_FALLBACK_MESSAGE } from '../../src/config/constants';
import { blockedUserMiddleware } from '../../src/config/middlewares/blockedUserMiddleware';
import CountryModel from '../../src/models/countries';
import { TemplateType } from '../../src/models/templateModel';
import { UserModel } from '../../src/models/userModel';
import { cacheService } from '../../src/services/cache/cacheService';
import { CacheNames } from '../../src/types/commonType';

const BLOCKED_PHONE = '5491122223333';
const ACTIVE_PHONE = '5491144445555';

const STATUS_ROUTE = '/notifications';

const SUCCESS_SHAPED_ROUTE = '/make_transaction/';

const TEMPLATE_ES = 'Cuenta suspendida. Contactanos por los canales de soporte.';
const TEMPLATE_EN = 'Account suspended. Reach out through our support channels.';

const EXPECTED_ES = TEMPLATE_ES;
const EXPECTED_EN = TEMPLATE_EN;

const seedTemplate = () =>
  TemplateType.collection.insertOne({
    notifications: {
      user_blocked: {
        title: { en: 'Suspended', es: 'Suspendida', pt: 'Suspensa' },
        message: { en: TEMPLATE_EN, es: TEMPLATE_ES, pt: TEMPLATE_EN }
      }
    }
  });

const buildRequest = (overrides: Record<string, unknown> = {}) => {
  const request = {
    method: 'POST',
    url: STATUS_ROUTE,
    body: undefined,
    query: {},
    params: {},
    ...overrides
  };

  return {
    routeOptions: { url: String(request.url).split('?')[0] },
    ...request
  } as never;
};

const buildReply = () => ({
  status: vi.fn().mockReturnThis(),
  send: vi.fn().mockReturnThis()
});

describe('blockedUserMiddleware', () => {
  let reply: ReturnType<typeof buildReply>;

  beforeEach(async () => {
    reply = buildReply();
    cacheService.clearCache(CacheNames.NOTIFICATION);
    await seedTemplate();
    await CountryModel.create({
      code: 'AR',
      name: 'Argentina',
      phone_code: '54',
      notification_language: 'es',
      main_language: 'ES'
    });
    await UserModel.create([
      {
        phone_number: BLOCKED_PHONE,
        blocked: true,
        settings: { notifications: { language: 'es' } }
      },
      {
        phone_number: ACTIVE_PHONE,
        settings: { notifications: { language: 'es' } }
      }
    ]);
  });

  it('lets a request through when it names no account', async () => {
    await blockedUserMiddleware(buildRequest({ url: '/nfts/', method: 'GET' }), reply as never);
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('lets a request through for an account that is not blocked', async () => {
    await blockedUserMiddleware(
      buildRequest({ body: { channel_user_id: ACTIVE_PHONE } }),
      reply as never
    );
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('lets a request through for a phone number that matches no account', async () => {
    await blockedUserMiddleware(
      buildRequest({ body: { channel_user_id: '5491199998888' } }),
      reply as never
    );
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('refuses with 403 and the template message on a status-shaped route', async () => {
    await blockedUserMiddleware(
      buildRequest({ body: { channel_user_id: BLOCKED_PHONE } }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        data: expect.objectContaining({
          code: 403,
          message: EXPECTED_ES,
          details: USER_BLOCKED_ERROR_CODE
        })
      })
    );
  });

  it('renders the template in the language on the account', async () => {
    await UserModel.updateOne(
      { phone_number: BLOCKED_PHONE },
      { 'settings.notifications.language': 'en' }
    );

    await blockedUserMiddleware(
      buildRequest({ body: { channel_user_id: BLOCKED_PHONE } }),
      reply as never
    );

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ message: EXPECTED_EN }) })
    );
  });

  it('still refuses when the template is not loaded yet', async () => {
    cacheService.clearCache(CacheNames.NOTIFICATION);
    await TemplateType.collection.deleteMany({});

    await blockedUserMiddleware(
      buildRequest({ body: { channel_user_id: BLOCKED_PHONE } }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(403);
    const [[sent]] = reply.send.mock.calls as [[{ data: { message: string } }]];
    expect(sent.data.message).toBe(USER_BLOCKED_FALLBACK_MESSAGE);
  });

  it('refuses with 200 and an error body on a success-shaped route', async () => {
    await blockedUserMiddleware(
      buildRequest({ url: SUCCESS_SHAPED_ROUTE, body: { channel_user_id: BLOCKED_PHONE } }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        data: expect.objectContaining({ code: 200, details: USER_BLOCKED_ERROR_CODE })
      })
    );
  });

  it('shapes the refusal by route, whatever credential the request arrived with', async () => {
    for (const tokenType of ['frontend', 'chatizalo']) {
      const scopedReply = buildReply();

      await blockedUserMiddleware(
        buildRequest({
          url: SUCCESS_SHAPED_ROUTE,
          body: { channel_user_id: BLOCKED_PHONE },
          tokenType
        }),
        scopedReply as never
      );

      expect(scopedReply.status).toHaveBeenCalledWith(200);
    }
  });

  it('matches a route whose registered pattern carries a trailing slash the caller omitted', async () => {
    await blockedUserMiddleware(
      buildRequest({
        url: '/make_transaction',
        routeOptions: { url: '/make_transaction/' },
        body: { channel_user_id: BLOCKED_PHONE }
      }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('reads the identifier from the query string too', async () => {
    await blockedUserMiddleware(
      buildRequest({ method: 'GET', query: { channel_user_id: BLOCKED_PHONE } }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('reads the query string even when the body carries a junk value in the same field', async () => {
    await blockedUserMiddleware(
      buildRequest({
        method: 'PATCH',
        url: '/notifications/mark-read',
        body: { channel_user_id: 'junk' },
        query: { channel_user_id: BLOCKED_PHONE }
      }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('refuses a blocked account named under user_channel_id', async () => {
    await blockedUserMiddleware(
      buildRequest({
        method: 'GET',
        url: '/polymarket/events',
        query: { user_channel_id: BLOCKED_PHONE }
      }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('refuses a blocked account addressed by its user id on /users/:id', async () => {
    const blockedUser = await UserModel.findOne({ phone_number: BLOCKED_PHONE });

    await blockedUserMiddleware(
      buildRequest({
        method: 'PUT',
        url: `/users/${blockedUser?._id}`,
        routeOptions: { url: '/users/:id' },
        params: { id: String(blockedUser?._id) }
      }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('refuses a blocked account on a duplicated-slash path that still routes to /users/:id', async () => {
    const blockedUser = await UserModel.findOne({ phone_number: BLOCKED_PHONE });

    await blockedUserMiddleware(
      buildRequest({
        method: 'PUT',
        url: `//users/${blockedUser?._id}`,
        routeOptions: { url: '/users/:id' },
        params: { id: String(blockedUser?._id) },
        body: { blocked: false }
      }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('answers the Telegram webhook with a sendMessage call', async () => {
    await UserModel.updateOne({ phone_number: BLOCKED_PHONE }, { telegram_id: '778899' });

    await blockedUserMiddleware(
      buildRequest({
        url: '/telegram/webhook',
        body: { update_id: 1, message: { from: { id: 778899 }, chat: { id: 4242 } } }
      }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      method: 'sendMessage',
      chat_id: 4242,
      text: EXPECTED_ES
    });
  });

  it('refuses a blocked account on a duplicated-slash Telegram webhook path', async () => {
    await UserModel.updateOne({ phone_number: BLOCKED_PHONE }, { telegram_id: '778899' });

    await blockedUserMiddleware(
      buildRequest({
        url: '//telegram/webhook',
        routeOptions: { url: '/telegram/webhook' },
        body: { update_id: 1, message: { from: { id: 778899 }, chat: { id: 4242 } } }
      }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'sendMessage', chat_id: 4242 })
    );
  });

  it('refuses a blocked account that shares its contact on Telegram before being linked', async () => {
    await blockedUserMiddleware(
      buildRequest({
        url: '/telegram/webhook',
        body: {
          update_id: 1,
          message: {
            from: { id: 111 },
            chat: { id: 4242 },
            contact: { phone_number: BLOCKED_PHONE }
          }
        }
      }),
      reply as never
    );

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'sendMessage', text: EXPECTED_ES })
    );
  });

  it('refuses a blocked account that types its phone number on Telegram', async () => {
    await blockedUserMiddleware(
      buildRequest({
        url: '/telegram/webhook',
        body: {
          update_id: 1,
          message: { from: { id: 111 }, chat: { id: 4242 }, text: BLOCKED_PHONE }
        }
      }),
      reply as never
    );

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'sendMessage', text: EXPECTED_ES })
    );
  });

  it('ignores Telegram text that is not a phone number', async () => {
    await blockedUserMiddleware(
      buildRequest({
        url: '/telegram/webhook',
        body: { update_id: 1, message: { from: { id: 111 }, chat: { id: 4242 }, text: '/wallet' } }
      }),
      reply as never
    );

    expect(reply.send).not.toHaveBeenCalled();
  });

  it('refuses a blocked account named by a phone variant', async () => {
    await blockedUserMiddleware(
      buildRequest({ body: { channel_user_id: '541122223333' } }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('refuses a Telegram-blocked account that types another number', async () => {
    await UserModel.updateOne({ phone_number: BLOCKED_PHONE }, { telegram_id: '778899' });

    await blockedUserMiddleware(
      buildRequest({
        url: '/telegram/webhook',
        body: {
          update_id: 1,
          message: { from: { id: 778899 }, chat: { id: 4242 }, text: ACTIVE_PHONE }
        }
      }),
      reply as never
    );

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'sendMessage', chat_id: 4242 })
    );
  });

  it('lets a request through when the user id is not a valid object id', async () => {
    await blockedUserMiddleware(
      buildRequest({
        method: 'GET',
        url: '/users/abc',
        routeOptions: { url: '/users/:id' },
        params: { id: 'abc' }
      }),
      reply as never
    );
    expect(reply.send).not.toHaveBeenCalled();
  });
});

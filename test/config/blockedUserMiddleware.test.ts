import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_BLOCKED_ERROR_CODE, USER_BLOCKED_MESSAGES } from '../../src/config/constants';
import { blockedUserMiddleware } from '../../src/config/middlewares/blockedUserMiddleware';
import { UserModel } from '../../src/models/userModel';

const BLOCKED_PHONE = '5491122223333';
const ACTIVE_PHONE = '5491144445555';

/**
 * Builds a request shaped the way Fastify hands one to a `preHandler` hook.
 *
 * @param overrides - The parts of the request the case under test cares about.
 * @returns A request object the middleware can read.
 */
const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: 'POST',
    url: '/make_transaction/',
    body: undefined,
    query: {},
    params: {},
    ...overrides
  }) as never;

const buildReply = () => ({
  status: vi.fn().mockReturnThis(),
  send: vi.fn().mockReturnThis()
});

describe('blockedUserMiddleware', () => {
  let reply: ReturnType<typeof buildReply>;

  beforeEach(async () => {
    reply = buildReply();
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

  it('refuses a blocked account with 403 in its own language for the frontend', async () => {
    await blockedUserMiddleware(
      buildRequest({ body: { channel_user_id: BLOCKED_PHONE }, tokenType: 'frontend' }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        data: expect.objectContaining({
          code: 403,
          message: USER_BLOCKED_MESSAGES.es,
          details: USER_BLOCKED_ERROR_CODE
        })
      })
    );
  });

  // The bot renders the message body and cannot act on a status code, so its endpoints report
  // every refusal as a 200. A blocked user has to be refused the same way or the bot shows nothing.
  it('refuses a blocked account with 200 and an error body for the bot', async () => {
    await blockedUserMiddleware(
      buildRequest({ body: { channel_user_id: BLOCKED_PHONE }, tokenType: 'chatizalo' }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        data: expect.objectContaining({
          code: 200,
          message: USER_BLOCKED_MESSAGES.es,
          details: USER_BLOCKED_ERROR_CODE
        })
      })
    );
  });

  it('reads the identifier from the query string too', async () => {
    await blockedUserMiddleware(
      buildRequest({
        method: 'GET',
        url: '/notifications',
        query: { channel_user_id: BLOCKED_PHONE },
        tokenType: 'frontend'
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
        params: { id: String(blockedUser?._id) },
        tokenType: 'frontend'
      }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('refuses a blocked account on the Telegram webhook, as a 200', async () => {
    await UserModel.updateOne({ phone_number: BLOCKED_PHONE }, { telegram_id: '778899' });

    await blockedUserMiddleware(
      buildRequest({
        url: '/telegram/webhook',
        body: { update_id: 1, message: { from: { id: 778899 } } }
      }),
      reply as never
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: USER_BLOCKED_MESSAGES.es })
      })
    );
  });

  it('falls back to English when the account has no usable language set', async () => {
    await UserModel.updateOne(
      { phone_number: BLOCKED_PHONE },
      { 'settings.notifications.language': 'xx' }
    );

    await blockedUserMiddleware(
      buildRequest({ body: { channel_user_id: BLOCKED_PHONE }, tokenType: 'frontend' }),
      reply as never
    );

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: USER_BLOCKED_MESSAGES.en })
      })
    );
  });

  // A malformed id used to reach mongoose as a cast error. This hook runs in front of every
  // handler, so a bad identifier has to read as "no account", never as a 500.
  it('lets a request through when the user id is not a valid object id', async () => {
    await blockedUserMiddleware(
      buildRequest({ method: 'GET', url: '/users/abc', params: { id: 'abc' } }),
      reply as never
    );
    expect(reply.send).not.toHaveBeenCalled();
  });
});

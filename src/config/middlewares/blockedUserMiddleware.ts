import type { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../../helpers/loggerHelper';
import { returnErrorResponse, returnErrorResponseAsSuccess } from '../../helpers/requestHelper';
import { isValidPhoneNumber } from '../../helpers/validationHelper';
import { NotificationEnum } from '../../models/templateModel';
import { mongoUserService } from '../../services/mongo/mongoUserService';
import { getNotificationTemplateForLanguage } from '../../services/notificationService';
import {
  TELEGRAM_WEBHOOK_PATH,
  USER_BLOCKED_ERROR_CODE,
  USER_BLOCKED_FALLBACK_MESSAGE
} from '../constants';

type RequestIdentity = { phoneNumber: string } | { userId: string } | { telegramId: string };

type TelegramWebhookBody = {
  message?: {
    from?: { id?: unknown };
    chat?: { id?: unknown };
    contact?: { phone_number?: unknown };
    text?: unknown;
  };
};

const PHONE_FIELDS = ['channel_user_id', 'user_channel_id', 'phone_number', 'identifier'] as const;

/**
 * Routes where the refusal is sent as HTTP 200 with an error body.
 *
 * These are the endpoints the WhatsApp bot calls. Its HTTP layer raises on any non-2xx before it
 * reads the body, so a status code leaves the person with no message at all. Keyed by route and
 * not by credential, so one endpoint answers the same way whoever called it.
 */
const ROUTES_ANSWERING_ERRORS_AS_SUCCESS = [
  '/make_transaction/',
  '/swap',
  '/get_referral_code/',
  '/get_referral_by_code/',
  '/get_referral_code_with_usage_count/',
  '/submit_referral_by_code/',
  '/get_security_status/',
  '/get_security_questions/',
  '/get_security_events/',
  '/set_security_pin/',
  '/verify_security_pin/',
  '/set_security_recovery_questions/',
  '/reset_security_pin/',
  '/chatterpoints/play',
  '/chatterpoints/stats',
  '/chatterpoints/info',
  '/chatterpoints/social',
  '/chatterpoints/leaderboard',
  '/chatterpoints/cycle/plays',
  '/chatterpoints/user/history',
  '/aave/create_supply',
  '/aave/get_supply',
  '/aave/update_supply',
  '/aave/remove_supply',
  '/balance_by_phone/',
  '/balance_by_phone_sync/',
  '/create_wallet/',
  '/get_wallet/',
  '/get_wallet_sync/',
  '/get_ramp_wallet/',
  '/deposit_info/',
  '/multichain_deposit_cta/',
  '/wallet_next_steps/',
  '/mint_existing/',
  '/nft/',
  '/ramp/onramp/link',
  TELEGRAM_WEBHOOK_PATH
];

const normalizeRoute = (route: string): string => {
  const withoutQuery = route.split('?')[0];
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
};

const NORMALIZED_SUCCESS_ROUTES = new Set(ROUTES_ANSWERING_ERRORS_AS_SUCCESS.map(normalizeRoute));

const telegramRoute = normalizeRoute(TELEGRAM_WEBHOOK_PATH);

const readStringField = (source: unknown, field: string): string => {
  if (typeof source !== 'object' || source === null) return '';

  const value = (source as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * Works out which account a request is acting on.
 *
 * This API has no per-user credential: the user is whoever the request says it is.
 *
 * Routes are matched on `routeOptions.url`, the registered pattern, never on the raw URL. The
 * server runs with `ignoreDuplicateSlashes`, so `//users/:id` reaches the handler while
 * `request.url` still carries both slashes and any prefix test on it silently misses.
 *
 * @param request - The incoming request.
 * @returns The identity the request names, or `null` when it names nobody.
 */
const resolveRequestIdentities = (request: FastifyRequest): RequestIdentity[] => {
  const { body, query, params } = request;
  const route = normalizeRoute(request.routeOptions?.url ?? request.url);

  for (const field of PHONE_FIELDS) {
    // Both sources are tested, never short-circuited: a truthy but invalid body value would
    // otherwise suppress the query string the handler actually reads.
    for (const value of [readStringField(body, field), readStringField(query, field)]) {
      if (value && isValidPhoneNumber(value)) {
        return [{ phoneNumber: value }];
      }
    }
  }

  if (route === telegramRoute) {
    const message = (body as TelegramWebhookBody | undefined)?.message;
    const identities: RequestIdentity[] = [];

    // `telegramController` links an account from `contact.phone_number || text`, so the typed
    // number counts as an identity too. Both it and the Telegram account are collected: naming a
    // second, unblocked number must not shadow a block on the account doing the naming.
    for (const candidate of [message?.contact?.phone_number, message?.text]) {
      if (typeof candidate === 'string' && isValidPhoneNumber(candidate)) {
        identities.push({ phoneNumber: candidate });
        break;
      }
    }

    const fromId = message?.from?.id;
    if (typeof fromId === 'number' || typeof fromId === 'string') {
      identities.push({ telegramId: String(fromId) });
    }

    return identities;
  }

  if (route === '/users/:id') {
    const id = readStringField(params, 'id');
    if (id) return [{ userId: id }];
  }

  return [];
};

const answersErrorsAsSuccess = (request: FastifyRequest): boolean =>
  NORMALIZED_SUCCESS_ROUTES.has(normalizeRoute(request.routeOptions?.url ?? request.url));

/**
 * Refuses every request made on behalf of a blocked account.
 *
 * A `preHandler` and not an `onRequest` hook because the identifier usually lives in the request
 * body, which is not parsed yet at `onRequest` time. Registered on the root instance so a route
 * added later is covered without opting in.
 *
 * @param request - Fastify request.
 * @param reply - Fastify reply.
 * @returns Resolves once the request may proceed, or after replying with the refusal.
 */
export async function blockedUserMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  let identity: RequestIdentity | null = null;
  let blockState: Awaited<ReturnType<typeof mongoUserService.getUserBlockState>> = null;

  for (const candidate of resolveRequestIdentities(request)) {
    const state = await mongoUserService.getUserBlockState(candidate);
    if (state?.blocked) {
      identity = candidate;
      blockState = state;
      break;
    }
  }

  if (!identity || !blockState) return;

  const template = await getNotificationTemplateForLanguage(
    blockState.language,
    NotificationEnum.user_blocked
  );
  const message = template.message || USER_BLOCKED_FALLBACK_MESSAGE;

  Logger.warn(
    'blockedUserMiddleware',
    `Blocked account refused on ${request.method} ${request.url}`,
    JSON.stringify(identity)
  );

  // Telegram ignores any body that is not a method call, so the shared error envelope would leave
  // the person with no message at all.
  if (normalizeRoute(request.routeOptions?.url ?? request.url) === telegramRoute) {
    const chatId = (request.body as TelegramWebhookBody | undefined)?.message?.chat?.id;
    await reply
      .status(200)
      .send(
        chatId === undefined ? undefined : { method: 'sendMessage', chat_id: chatId, text: message }
      );
    return;
  }

  if (answersErrorsAsSuccess(request)) {
    await returnErrorResponseAsSuccess(
      'blockedUserMiddleware',
      '',
      reply,
      message,
      false,
      'phoneNumber' in identity ? identity.phoneNumber : '',
      USER_BLOCKED_ERROR_CODE
    );
    return;
  }

  await returnErrorResponse(
    'blockedUserMiddleware',
    '',
    reply,
    403,
    message,
    USER_BLOCKED_ERROR_CODE
  );
}

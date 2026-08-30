import type { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../../helpers/loggerHelper';
import { returnErrorResponse, returnErrorResponseAsSuccess } from '../../helpers/requestHelper';
import { isValidPhoneNumber } from '../../helpers/validationHelper';
import { mongoUserService } from '../../services/mongo/mongoUserService';
import type { NotificationLanguage } from '../../types/commonType';
import {
  SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT,
  TELEGRAM_WEBHOOK_PATH,
  USER_BLOCKED_ERROR_CODE,
  USER_BLOCKED_MESSAGES
} from '../constants';

/**
 * How a request names the account it acts on.
 *
 * This API has no per-user credential: the frontend and the bot each hold one shared bearer token,
 * and the user is whoever the request body or query string says it is. So the only place a block
 * can be enforced is on that same self-declared identifier — which is enough, because a blocked
 * account cannot operate without naming itself.
 */
type RequestIdentity = { phoneNumber: string } | { userId: string } | { telegramId: string } | null;

/** Fields a request can carry a phone number in, in the order they are trusted. */
const PHONE_FIELDS = ['channel_user_id', 'phone_number', 'identifier'] as const;

/**
 * Pulls a scalar string out of a parsed body or query object.
 *
 * A query string can repeat a key, in which case Fastify hands over an array; a JSON body can hold
 * anything at all. Neither is a usable identifier, so both read as absent.
 *
 * @param source - The parsed body or query object.
 * @param field - The field name to read.
 * @returns The trimmed string value, or an empty string when absent or not a string.
 */
const readStringField = (source: unknown, field: string): string => {
  if (typeof source !== 'object' || source === null) return '';

  const value = (source as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * Works out which account a request is acting on.
 *
 * Body first, then query string: an endpoint that accepts both reads the body, and a caller cannot
 * dodge the check by moving the identifier to the other one.
 *
 * @param request - The incoming request.
 * @returns The identity the request names, or `null` when it names nobody.
 */
const resolveRequestIdentity = (request: FastifyRequest): RequestIdentity => {
  const { body, query, params, url } = request;

  for (const field of PHONE_FIELDS) {
    const value = readStringField(body, field) || readStringField(query, field);
    // `identifier` also carries wallet addresses on the token issuer route; only a phone number
    // identifies a user here, and a wallet reaches the handler's own validation untouched.
    if (value && isValidPhoneNumber(value)) {
      return { phoneNumber: value };
    }
  }

  // The Telegram webhook carries no ChatterPay identifier at all — the account is whoever the
  // Telegram user is linked to.
  if (url.startsWith(TELEGRAM_WEBHOOK_PATH.replace(/\/$/, ''))) {
    const from = (body as { message?: { from?: { id?: unknown } } } | undefined)?.message?.from;
    if (typeof from?.id === 'number' || typeof from?.id === 'string') {
      return { telegramId: String(from.id) };
    }
  }

  // `/users/:id` and the routes under it address the account by its Mongo id.
  if (url.startsWith('/users/')) {
    const id = readStringField(params, 'id');
    if (id) return { userId: id };
  }

  return null;
};

/**
 * Whether this route answers a failed validation with HTTP 200 and an error body.
 *
 * The bot renders whatever message it gets back and cannot act on a status code, so every endpoint
 * it calls reports refusals that way. A blocked user reaching one of those has to be told the same
 * way, or the bot shows nothing at all.
 *
 * @param request - The incoming request.
 * @returns `true` when the refusal must be sent as a 200.
 */
const answersErrorsAsSuccess = (request: FastifyRequest): boolean => {
  const { tokenType } = request as FastifyRequest & { tokenType?: 'frontend' | 'chatizalo' | null };

  if (tokenType === 'chatizalo') return true;

  // The Telegram webhook is authenticated by its own secret header, so it never gets a tokenType.
  return request.url.startsWith(TELEGRAM_WEBHOOK_PATH.replace(/\/$/, ''));
};

/**
 * Refuses every request made on behalf of a blocked account.
 *
 * Registered as a `preHandler` rather than an `onRequest` hook because the identifier usually
 * lives in the request body, which is not parsed yet at `onRequest` time. It is registered once on
 * the root instance so a route added later is covered without anyone remembering to opt in.
 *
 * A request that names no account passes through untouched: the public NFT and balance routes take
 * no user, and the handler behind this hook still runs its own validation.
 *
 * @param request - Fastify request.
 * @param reply - Fastify reply.
 * @returns Resolves once the request may proceed, or after replying with the refusal.
 */
export async function blockedUserMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const identity = resolveRequestIdentity(request);
  if (!identity) return;

  const blockState = await mongoUserService.getUserBlockState(identity);
  if (!blockState?.blocked) return;

  const language: NotificationLanguage =
    blockState.language ?? SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT;
  const message = USER_BLOCKED_MESSAGES[language] ?? USER_BLOCKED_MESSAGES.en;

  Logger.warn(
    'blockedUserMiddleware',
    `Blocked account refused on ${request.method} ${request.url}`,
    JSON.stringify(identity)
  );

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

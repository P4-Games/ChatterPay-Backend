/**
 * The user-facing staking endpoints.
 *
 * Every handler here takes a `channel_user_id` and nothing that names a wallet. That is the whole
 * shape of the authorisation: the service it calls resolves the wallet from the identity, so there is
 * no parameter through which one user's request can reach another user's credential. The one address
 * any of these accepts is an exit's destination, which is where money goes rather than whose money it
 * is.
 *
 * `channel_user_id` is trusted the way it is trusted everywhere else in this repository: the caller
 * holds the internal token and the Next.js route that presents it resolved the phone number from the
 * session cookie itself. That is the existing model, unchanged, and its limit is worth stating plainly
 * — anything holding the token can name any user. Narrowing that is a change to how the whole product
 * authenticates and is not attempted here; what *is* narrowed is the blast radius, because no request
 * can reach a wallet the named user does not own.
 *
 * Reads answer for a wallet this deployment cannot sign for. Mutations refuse it. See
 * `cardanoStakingSignerService`.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import type { CardanoStakingOperationKind } from '../models/cardanoStakingOperationModel';
import {
  authorizeStakingAction,
  getGovernanceHistory,
  getStakingView,
  listGovernanceOptions,
  requestStakingAction,
  type StakingUserRefusal,
  setStakingConsent,
  USER_REQUESTABLE_ACTIONS
} from '../services/cardano/cardanoStakingUserService';

/** The HTTP status each refusal answers with. */
const STATUS_OF: Record<StakingUserRefusal, number> = {
  user_not_found: 404,
  no_staking_account: 404,
  staking_disabled: 409,
  // A gate that would not allow it is the user's situation to resolve, not a malformed request.
  security_gate: 403,
  // Not 400: the request was well formed. What is missing is proof that a session was authenticated
  // for it, which is an authentication failure and reads as one.
  assertion: 401,
  pin_grant: 401,
  action_not_allowed: 400,
  // The request was understood and the state does not permit it. 409 rather than 400: nothing about
  // the request was wrong, and a client that retries it unchanged after the state changes is right.
  refused: 409,
  not_assembled: 409,
  not_started: 502
};

/** What the action endpoint accepts. */
interface ActionBody {
  channel_user_id?: string;
  action?: string;
  recipient_address?: string | null;
  /** Signed by the Next.js route over the user it authenticated and the action asked for. */
  bff_assertion?: string;
  /** Issued by `/cardano/staking/authorize` once the PIN verified for this exact action. */
  pin_grant?: string;
}

/** What the authorise endpoint accepts. */
interface AuthorizeBody {
  channel_user_id?: string;
  action?: string;
  recipient_address?: string | null;
  pin?: string;
  bff_assertion?: string;
}

/**
 * Handles `GET /cardano/staking/state`.
 *
 * @param request - The Fastify request.
 * @param reply - The Fastify reply.
 */
export async function cardanoStakingState(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { channel_user_id: channelUserId } = (request.query ?? {}) as { channel_user_id?: string };
  if (!channelUserId) return missingUser(reply);

  try {
    const result = await getStakingView(channelUserId);
    if (!result.ok) return refuse(reply, result.refusal, result.detail);
    return returnSuccessResponse(reply, 'Cardano staking state', { staking: result.data });
  } catch (error) {
    return failed(reply, 'cardanoStakingState', error);
  }
}

/**
 * Handles `POST /cardano/staking/consent`.
 *
 * @param request - The Fastify request.
 * @param reply - The Fastify reply.
 */
export async function cardanoStakingConsent(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const body = (request.body ?? {}) as {
    channel_user_id?: string;
    accept?: boolean;
    source?: string;
  };
  if (!body.channel_user_id) return missingUser(reply);
  if (typeof body.accept !== 'boolean') {
    return returnErrorResponse(
      'cardanoStakingConsent',
      '',
      reply,
      400,
      'accept must be true or false'
    );
  }

  try {
    const result = await setStakingConsent(
      body.channel_user_id,
      body.accept,
      (body.source ?? 'web').slice(0, 60)
    );
    if (!result.ok) return refuse(reply, result.refusal, result.detail);
    return returnSuccessResponse(reply, 'Cardano staking preference stored', { ...result.data });
  } catch (error) {
    return failed(reply, 'cardanoStakingConsent', error);
  }
}

/**
 * Handles `POST /cardano/staking/action`.
 *
 * @param request - The Fastify request.
 * @param reply - The Fastify reply.
 */
export async function cardanoStakingAction(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const body = (request.body ?? {}) as ActionBody;
  if (!body.channel_user_id) return missingUser(reply);

  const action = body.action as CardanoStakingOperationKind | undefined;
  if (action === undefined || !USER_REQUESTABLE_ACTIONS.includes(action)) {
    return returnErrorResponse(
      'cardanoStakingAction',
      '',
      reply,
      400,
      `action must be one of: ${USER_REQUESTABLE_ACTIONS.join(', ')}`
    );
  }

  try {
    const result = await requestStakingAction(body.channel_user_id, action, {
      recipientAddress: body.recipient_address ?? null,
      // Recorded on the operation so an audit can tell a user's request from the sweep's decision.
      actor: 'web',
      bffAssertion: body.bff_assertion ?? null,
      pinGrant: body.pin_grant ?? null
    });
    if (!result.ok) return refuse(reply, result.refusal, result.detail);

    Logger.log(
      'cardanoStakingAction',
      `${action} started as operation ${result.data.operationId} (${result.data.outcome})`
    );
    return returnSuccessResponse(reply, 'Cardano staking action started', { ...result.data });
  } catch (error) {
    return failed(reply, 'cardanoStakingAction', error);
  }
}

/**
 * Handles `POST /cardano/staking/authorize`.
 *
 * Verifies the PIN for one action and hands back a grant bound to it. Separate from the action itself
 * so that the PIN is entered against a named operation — "authorise withdrawing your rewards" — rather
 * than against a session that then permits anything.
 *
 * @param request - The Fastify request.
 * @param reply - The Fastify reply.
 */
export async function cardanoStakingAuthorize(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const body = (request.body ?? {}) as AuthorizeBody;
  if (!body.channel_user_id) return missingUser(reply);

  const action = body.action as CardanoStakingOperationKind | undefined;
  if (action === undefined || !USER_REQUESTABLE_ACTIONS.includes(action)) {
    return returnErrorResponse(
      'cardanoStakingAuthorize',
      '',
      reply,
      400,
      `action must be one of: ${USER_REQUESTABLE_ACTIONS.join(', ')}`
    );
  }
  if (typeof body.pin !== 'string' || body.pin.trim() === '') {
    return returnErrorResponse('cardanoStakingAuthorize', '', reply, 400, 'pin is required');
  }

  try {
    const result = await authorizeStakingAction(body.channel_user_id, action, {
      pin: body.pin,
      recipientAddress: body.recipient_address ?? null,
      bffAssertion: body.bff_assertion ?? null,
      actor: 'web'
    });
    if (!result.ok) return refuse(reply, result.refusal, result.detail);
    return returnSuccessResponse(reply, 'Cardano staking action authorised', { ...result.data });
  } catch (error) {
    return failed(reply, 'cardanoStakingAuthorize', error);
  }
}

/**
 * Handles `GET /cardano/governance/options`.
 *
 * @param request - The Fastify request.
 * @param reply - The Fastify reply.
 */
export async function cardanoGovernanceOptions(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { limit } = (request.query ?? {}) as { limit?: string };
  const parsed = Number.parseInt(limit ?? '', 10);

  try {
    const result = await listGovernanceOptions(
      Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 20
    );
    if (!result.ok) return refuse(reply, result.refusal, result.detail);
    return returnSuccessResponse(reply, 'Cardano governance options', { ...result.data });
  } catch (error) {
    return failed(reply, 'cardanoGovernanceOptions', error);
  }
}

/**
 * Handles `GET /cardano/governance/history`.
 *
 * @param request - The Fastify request.
 * @param reply - The Fastify reply.
 */
export async function cardanoGovernanceHistory(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const { channel_user_id: channelUserId } = (request.query ?? {}) as { channel_user_id?: string };
  if (!channelUserId) return missingUser(reply);

  try {
    const result = await getGovernanceHistory(channelUserId);
    if (!result.ok) return refuse(reply, result.refusal, result.detail);
    return returnSuccessResponse(reply, 'Cardano governance history', { ...result.data });
  } catch (error) {
    return failed(reply, 'cardanoGovernanceHistory', error);
  }
}

/**
 * The response for a request that names no user.
 *
 * @param reply - The Fastify reply.
 * @returns The response.
 */
function missingUser(reply: FastifyReply): unknown {
  return returnErrorResponse('cardanoStaking', '', reply, 400, 'channel_user_id is required');
}

/**
 * The response for a refusal.
 *
 * @param reply - The Fastify reply.
 * @param refusal - Why.
 * @param detail - What is diagnosable about it.
 * @returns The response.
 */
function refuse(reply: FastifyReply, refusal: StakingUserRefusal, detail: string): unknown {
  // The code travels in the message so a client can branch on it, and the detail travels beside it:
  // both were written to be read by whoever is looking at a refused staking action, and neither
  // carries an address, a key or a figure that is not already the caller's own.
  return returnErrorResponse('cardanoStaking', '', reply, STATUS_OF[refusal], refusal, detail);
}

/**
 * The response for an unhandled failure.
 *
 * @param reply - The Fastify reply.
 * @param context - Which handler.
 * @param error - What went wrong.
 * @returns The response.
 */
function failed(reply: FastifyReply, context: string, error: unknown): unknown {
  Logger.error(context, error instanceof Error ? error.message : String(error));
  return returnErrorResponse(context, '', reply, 500, 'Internal Server Error');
}

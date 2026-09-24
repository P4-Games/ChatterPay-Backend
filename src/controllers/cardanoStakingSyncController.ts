/**
 * The endpoint a scheduler calls, and the only route in this repository that a browser never reaches.
 *
 * Everything else here is authenticated by an `Origin` header and a shared token. Neither works for
 * this: `Origin` is absent from every server-to-server call, and the shared token is held by the web
 * routes and by the bot, so accepting it here would let every component holding it start a run that
 * spends sponsor fees. So this route is exempt from the origin check and carries a credential of its
 * own instead — see `cardanoStakingSyncAuthService` for what makes it usable as one.
 *
 * The HTTP contract is deliberately small, because the scheduler is configured outside this
 * repository and by hand:
 *
 *     POST /internal/cardano/staking/sync
 *     Authorization: Bearer <CARDANO_STAKING_SYNC_SECRET>
 *     Content-Type: application/json
 *
 *     { "jobName": "cardano-staking-sync", "scheduledTime": "2026-01-01T03:00:00Z" }
 *
 * Both body fields are optional. `scheduledTime` is what makes a retry idempotent — Cloud Scheduler
 * sends the same value when it redelivers, and the run's identity is derived from it — so a caller
 * that omits it gets a fresh run per call, which is right for a manual invocation and wrong for a
 * schedule. `X-CloudScheduler-ScheduleTime` is read when the body does not carry one, which is the
 * header Cloud Scheduler sets.
 *
 * Status codes carry the distinction a scheduler needs in order to decide whether to retry:
 *
 * - `200` the run did something, or deliberately did nothing. Includes a lease held by another
 *   instance and a tick that already completed: both mean "no work for you", not "try again".
 * - `401` the credential did not verify, or this deployment has none configured. Retrying will not
 *   help; the body names which of the two it was.
 * - `409` staking is off or misconfigured in this deployment.
 * - `500` the run failed part way. A retry resumes it from its checkpoint.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { getCardanoConfig } from '../config/cardanoConfig';
import {
  CARDANO_STAKING_SYNC_BATCH_LIMIT,
  CARDANO_STAKING_SYNC_EXECUTE
} from '../config/constants';
import { Logger } from '../helpers/loggerHelper';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { buildCardanoProvider } from '../services/cardano/cardanoProviderService';
import { buildStakingProvider } from '../services/cardano/cardanoStakingProviderService';
import { verifyStakingSyncCredential } from '../services/cardano/cardanoStakingSyncAuthService';
import {
  runStakingSync,
  type StakingSyncProvider
} from '../services/cardano/cardanoStakingSyncService';

/** Accounts refreshed in one pass when nothing is configured. */
const DEFAULT_BATCH_LIMIT = 50;

/** Ceiling on the batch limit, whatever is configured or asked for. */
const MAX_BATCH_LIMIT = 500;

/** What the endpoint accepts in the body. */
interface SyncRequestBody {
  jobName?: string;
  scheduledTime?: string;
  /** Overrides the configured batch limit downwards, for a cautious first run. */
  batchLimit?: number;
}

/**
 * Handles `POST /internal/cardano/staking/sync`.
 *
 * @param request - The Fastify request.
 * @param reply - The Fastify reply.
 */
export async function cardanoStakingSync(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  // Checked here as well as in the auth hook, and both on purpose. The hook is what keeps the route
  // from ever being unauthenticated; this one is what keeps the handler from depending on a hook
  // ordering that a future plugin registration could change. Neither is decorative and the cost is one
  // hash comparison.
  const verification = verifyStakingSyncCredential(request.headers.authorization);

  if (!verification.ok) {
    // A deployment that cannot verify anything has authorised nobody, so an unconfigured secret is a
    // 401 rather than a 500: saying it as a server error would invite a retry that fails the same way
    // for the same reason.
    return returnErrorResponse(
      'cardanoStakingSync',
      '',
      reply,
      401,
      'Unauthorized',
      verification.rejection
    );
  }

  const config = getCardanoConfig();
  if (!config.enabled) {
    return returnErrorResponse(
      'cardanoStakingSync',
      '',
      reply,
      409,
      'Cardano is not enabled in this deployment',
      config.disabledReason
    );
  }

  const body = (request.body ?? {}) as SyncRequestBody;
  const headerTime = request.headers['x-cloudscheduler-scheduletime'];
  const scheduledTime = readScheduledTime(
    body.scheduledTime ?? (typeof headerTime === 'string' ? headerTime : undefined)
  );

  const provider = stakingSyncProvider();

  try {
    const result = await runStakingSync({
      chainId: config.chainId,
      jobName: (body.jobName ?? 'cardano-staking-sync').slice(0, 120),
      scheduledTime,
      // Names the process, so a lease says which instance holds it. Cloud Run gives no stable
      // instance id to application code, so this is the best available: it changes per process, which
      // is exactly the granularity a lease needs.
      owner: `${process.pid}@${new Date().toISOString()}`,
      batchLimit: batchLimit(body.batchLimit),
      provider,
      execute: CARDANO_STAKING_SYNC_EXECUTE.trim().toLowerCase() === 'true'
    });

    if (result.refusal === 'staking_disabled') {
      return returnErrorResponse(
        'cardanoStakingSync',
        '',
        reply,
        409,
        'Cardano staking is not enabled in this deployment'
      );
    }

    if (result.status === 'failed') {
      return returnErrorResponse(
        'cardanoStakingSync',
        result.runId,
        reply,
        500,
        'The staking sync run failed part way through'
      );
    }

    Logger.log(
      'cardanoStakingSync',
      `run ${result.runId} ${result.status}: ${result.accountsScanned} accounts, ` +
        `${result.operationsReconciled} reconciled, ${result.actionsStarted} started, ` +
        `${result.backlogCount} remaining`
    );

    return returnSuccessResponse(reply, 'Cardano staking sync finished', {
      runId: result.runId,
      status: result.status,
      phase: result.phase,
      accountsScanned: result.accountsScanned,
      operationsReconciled: result.operationsReconciled,
      actionsStarted: result.actionsStarted,
      backlogCount: result.backlogCount,
      // Counts by reason rather than per account: it is what tells an operator whether a run did
      // nothing because there was nothing to do or because everything was refused for one reason.
      outcomes: result.refusals,
      refusal: result.refusal
    });
  } catch (error) {
    Logger.error(
      'cardanoStakingSync',
      `Unhandled failure: ${error instanceof Error ? error.message : String(error)}`
    );
    return returnErrorResponse('cardanoStakingSync', '', reply, 500, 'Internal Server Error');
  }
}

/**
 * The scheduled time a delivery names.
 *
 * @param raw - What the body or the header carried.
 * @returns The time, or now when there is none. A caller with no scheduled time gets a run of its
 *   own, which is right for a manual invocation: the idempotency this provides is between retries of
 *   one tick, and a hand-made call is not a tick.
 */
function readScheduledTime(raw: string | undefined): Date {
  if (raw === undefined || raw.trim() === '') return new Date();
  const parsed = new Date(raw.trim());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * How many accounts one pass may refresh.
 *
 * @param requested - What the body asked for, if anything.
 * @returns The limit, clamped. A caller may lower it and not raise it past the ceiling: the limit is
 *   what keeps one run from holding its lease for an hour.
 */
function batchLimit(requested: number | undefined): number {
  const configured = Number.parseInt(CARDANO_STAKING_SYNC_BATCH_LIMIT.trim(), 10);
  const base = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_BATCH_LIMIT;
  if (requested === undefined || !Number.isInteger(requested) || requested <= 0) {
    return Math.min(base, MAX_BATCH_LIMIT);
  }
  return Math.min(requested, base, MAX_BATCH_LIMIT);
}

/**
 * The provider the run reads and submits through.
 *
 * Two objects because the two interfaces were built for different jobs — the transfer provider knows
 * about tips, outputs and submission, the staking one about accounts, rewards and pools — and merging
 * them into one class would have made every transfer path carry the staking surface.
 *
 * @returns A provider covering both.
 */
function stakingSyncProvider(): StakingSyncProvider {
  const config = getCardanoConfig();
  const base = buildCardanoProvider();
  const staking = buildStakingProvider(
    config.providerKind,
    config.providerUrl,
    config.providerTimeoutMs,
    config.providerApiKey
  );

  return {
    tip: () => base.tip(),
    utxosFor: (address: string) => base.utxosFor(address),
    submit: (cborHex: string) => base.submit(cborHex),
    statusOf: (transactionId: string) => base.statusOf(transactionId),
    stakingProtocolParameters: () => staking.stakingProtocolParameters(),
    stakeAccount: (rewardAddress: string) => staking.stakeAccount(rewardAddress),
    rewardHistory: (rewardAddress: string) => staking.rewardHistory(rewardAddress),
    registrationHistory: (rewardAddress: string) => staking.registrationHistory(rewardAddress)
  };
}

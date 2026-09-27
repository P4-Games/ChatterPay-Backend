/**
 * The endpoint a scheduler calls, and the only route in this repository that a browser never reaches.
 *
 * It is authenticated and origin-checked like every other route here, which is what the other
 * scheduled endpoints in this repository do: the job presents the shared product token and an
 * `Origin` the deployment allows. The HTTP contract is small because the scheduler is configured
 * outside this repository and by hand:
 *
 *     POST /internal/cardano/staking/sync
 *     Authorization: Bearer <FRONTEND_TOKEN or CHATIZALO_TOKEN>
 *     Origin: <an origin in CORS_ORIGINS>
 *     Content-Type: application/json
 *
 *     { "jobName": "cardano-staking-sync", "scheduledTime": "2026-01-01T03:00:00Z" }
 *
 * Both body fields are optional, and a schedule should send neither.
 *
 * The tick comes from `X-CloudScheduler-ScheduleTime`, the header Cloud Scheduler sets per
 * delivery. It is what makes a retry idempotent: the same value comes back on a redelivery, the
 * run's identity is derived from it, and the second delivery finds the first run and adds nothing.
 * A `scheduledTime` in the body is read only when that header is absent, because a job's body is
 * static and a fixed date there would give every tick the same identity.
 *
 * A header time in the future is not a tick. Cloud Scheduler's "Force run" sends the *next*
 * scheduled time, and taking it as identity would complete that tick early and turn the real
 * delivery into `already_completed`. Such a call, and any call with no usable time, runs as a manual
 * run with an identity of its own. See {@link resolveSyncTrigger}.
 *
 * Status codes carry the distinction a scheduler needs in order to decide whether to retry:
 *
 * - `200` the run did something, or deliberately did nothing. Includes a lease held by another
 *   instance, another run working on the network and a tick that already completed: all mean "no
 *   work for you", not "try again". `executed` and `refusal` in the body say which.
 * - `401` the token did not verify. Retrying will not help.
 * - `409` staking is off or misconfigured in this deployment.
 * - `500` the run failed part way. A retry resumes it from its checkpoint.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { getCardanoConfig } from '../config/cardanoConfig';
import { loadCardanoStakingConfig } from '../config/cardanoStakingConfig';
import { Logger } from '../helpers/loggerHelper';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import type { CardanoStakingSyncTrigger } from '../models/cardanoStakingSyncRunModel';
import { providerUsageSnapshot } from '../services/cardano/cardanoProviderQuotaService';
import { buildCardanoProvider } from '../services/cardano/cardanoProviderService';
import { buildStakingProvider } from '../services/cardano/cardanoStakingProviderService';
import {
  runStakingSync,
  type StakingSyncProvider
} from '../services/cardano/cardanoStakingSyncService';

/** Accounts refreshed in one pass when nothing is configured. */
const DEFAULT_BATCH_LIMIT = 50;

/** Ceiling on the batch limit, whatever is configured or asked for. */
const MAX_BATCH_LIMIT = 500;

/**
 * How far ahead of this machine's clock a schedule time may be and still be read as the current
 * tick. Cloud Scheduler delivers at or after the scheduled time, so a genuine delivery is never
 * ahead except by clock skew, which NTP keeps well under a second. A Force run sends the next
 * tick's time; the tolerance is kept small so that one pressed shortly before a tick is still read
 * as manual and does not take that tick's identity.
 */
export const SCHEDULE_CLOCK_SKEW_MS = 60 * 1000;

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
  const trigger = resolveSyncTrigger(
    request.headers['x-cloudscheduler-scheduletime'],
    body.scheduledTime
  );

  // The network's own settings decide how far a run reaches and whether it may act. Read once here
  // and handed to the run, so every account in the pass is judged by the same document.
  const staking = await loadCardanoStakingConfig(config.chainId);
  const provider = stakingSyncProvider();

  try {
    const result = await runStakingSync({
      chainId: config.chainId,
      jobName: (body.jobName ?? 'cardano-staking-sync').slice(0, 120),
      scheduledTime: trigger.scheduledTime,
      trigger: trigger.kind,
      triggerReason: trigger.reason,
      // Names the process, so a lease says which instance holds it. Cloud Run gives no stable
      // instance id to application code, so this is the best available: it changes per process, which
      // is exactly the granularity a lease needs.
      owner: `${process.pid}@${new Date().toISOString()}`,
      batchLimit: batchLimit(body.batchLimit, staking.maxWalletsPerRun),
      provider,
      execute: staking.sweepExecutionEnabled,
      config: staking
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

    // A refusal is logged as a refusal, never as a run that scanned nothing: "completed: 0" and
    // "did not run" are different facts for whoever reads the log.
    Logger.log('cardanoStakingSync', describeResult(result));

    return returnSuccessResponse(reply, 'Cardano staking sync finished', {
      runId: result.runId,
      executed: result.executed,
      trigger: result.trigger,
      triggerReason: result.triggerReason,
      status: result.status,
      phase: result.phase,
      accountsScanned: result.accountsScanned,
      accountsCreated: result.accountsCreated,
      operationsReconciled: result.operationsReconciled,
      actionsStarted: result.actionsStarted,
      backlogCount: result.backlogCount,
      providerRequests: result.providerRequests,
      stopReason: result.stopReason,
      // The credential's usage today across every consumer in this backend, not only this run. A
      // failure to read it does not fail the response.
      providerUsage: await providerUsageSnapshot(config.chainId).catch(() => null),
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
 * The tick a delivery belongs to.
 *
 * The header wins over the body, and that order is the whole point rather than a preference.
 *
 * Cloud Scheduler sets `X-CloudScheduler-ScheduleTime` per delivery, from the schedule, and sends
 * the same value again when it retries one. The body, by contrast, is configured once and sent
 * unchanged forever. So a `scheduledTime` in the body is a *fixed* date, and taking it would give
 * every tick for the rest of the job's life the same run id — after which the first day would run
 * and every following day would be told the run had already completed. The failure is silent, looks
 * like a healthy 200, and would be found by noticing that nothing had been reconciled in a month.
 *
 * The body field is kept for a hand-made call that wants to name a tick, which is the only caller
 * that can set it to something different each time.
 *
 * @param header - What `X-CloudScheduler-ScheduleTime` carried, if anything.
 * @param body - What the body named, if anything.
 * @param now - The current time, injectable for tests.
 * @returns The tick. With neither source, a time of its own, so a caller with no schedule behind it
 *   gets a fresh run rather than colliding with one: the idempotency on offer here is between
 *   retries of one tick, and a hand-made call is not a tick.
 */
export function scheduledTimeFrom(
  header: unknown,
  body: string | undefined,
  now: Date = new Date()
): Date {
  return readTime(header) ?? readTime(body) ?? now;
}

/** What kind of run a delivery asks for, and why it was read that way. */
export interface SyncTrigger {
  kind: CardanoStakingSyncTrigger;
  /** The tick for a scheduled run; the arrival time for a manual one. */
  scheduledTime: Date;
  /** Why the delivery was classified as it was. */
  reason: string;
}

/**
 * Classifies a delivery as a scheduled tick or a manual run.
 *
 * Only a time that is not in the future identifies a tick. The authenticated caller is the same in
 * both cases, so nothing here grants more than the token already does: a manual run goes through the
 * same lease, network lock and per-account guards as a scheduled one.
 *
 * - Header present, readable, not ahead of `now` by more than {@link SCHEDULE_CLOCK_SKEW_MS}:
 *   `scheduled`, identified by the header. Every retry of that tick resolves to the same run.
 * - Header ahead of that: `manual` (`schedule_time_in_future`). This is Cloud Scheduler's "Force
 *   run", which sends the next tick's time.
 * - Header present and unreadable: `manual` (`schedule_time_unreadable`).
 * - No header, body time readable and not in the future: `scheduled` (`body_tick`), for an operator
 *   resuming a named past tick.
 * - No header, body time in the future: `manual` (`body_time_in_future`).
 * - Nothing usable: `manual` (`no_schedule_time`).
 *
 * @param header - What `X-CloudScheduler-ScheduleTime` carried, if anything.
 * @param body - What the body's `scheduledTime` named, if anything.
 * @param now - The current time, injectable for tests.
 * @returns The classification.
 */
export function resolveSyncTrigger(
  header: unknown,
  body: string | undefined,
  now: Date = new Date()
): SyncTrigger {
  const limit = now.getTime() + SCHEDULE_CLOCK_SKEW_MS;
  const headerPresent = typeof header === 'string' && header.trim() !== '';

  if (headerPresent) {
    const tick = readTime(header);
    if (tick === null) {
      return { kind: 'manual', scheduledTime: now, reason: 'schedule_time_unreadable' };
    }
    if (tick.getTime() > limit) {
      return { kind: 'manual', scheduledTime: now, reason: 'schedule_time_in_future' };
    }
    return { kind: 'scheduled', scheduledTime: tick, reason: 'scheduler_header' };
  }

  const named = readTime(body);
  if (named !== null) {
    if (named.getTime() > limit) {
      return { kind: 'manual', scheduledTime: now, reason: 'body_time_in_future' };
    }
    return { kind: 'scheduled', scheduledTime: named, reason: 'body_tick' };
  }

  return { kind: 'manual', scheduledTime: now, reason: 'no_schedule_time' };
}

/**
 * One log line for a sync call.
 *
 * @param result - What the run reported.
 * @returns The line. Contains ids and counts only; no address or phone number.
 */
function describeResult(result: Awaited<ReturnType<typeof runStakingSync>>): string {
  if (!result.executed) {
    return `run ${result.runId} (${result.trigger}) not executed: ${result.refusal}, stored status ${result.status}`;
  }
  const reason = result.triggerReason === null ? '' : `:${result.triggerReason}`;
  const stop = result.stopReason === null ? '' : `, stopped: ${result.stopReason}`;
  return (
    `run ${result.runId} (${result.trigger}${reason}) ${result.status}: ` +
    `${result.accountsScanned} accounts, ${result.operationsReconciled} reconciled, ` +
    `${result.actionsStarted} started, ${result.backlogCount} remaining, ` +
    `${result.providerRequests} provider requests${stop}`
  );
}

/**
 * One source, parsed.
 *
 * @param raw - The value, which may be anything a header or a JSON body can hold.
 * @returns The time, or null when there is nothing usable. An unparseable value is treated as
 *   absent rather than as an error: a delivery that arrives with a malformed timestamp should still
 *   do the work, and refusing it would mean a header format change could stop the schedule dead.
 */
function readTime(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * How many accounts one pass may refresh.
 *
 * @param requested - What the body asked for, if anything.
 * @param configured - The network's own ceiling, from `staking.maxWalletsPerRun`.
 * @returns The limit, clamped. A caller may lower it and not raise it past the ceiling: the limit is
 *   what keeps one run from holding its lease for an hour.
 */
function batchLimit(requested: number | undefined, configured: number): number {
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
    registrationHistory: (rewardAddress: string) => staking.registrationHistory(rewardAddress),
    poolState: (poolId: string) => staking.poolState(poolId)
  };
}

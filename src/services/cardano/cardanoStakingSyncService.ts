/**
 * The daily pass over every staking account, and what makes it safe to call twice.
 *
 * Cloud Scheduler retries. That is documented behaviour, not an edge case, and it means every
 * assumption this run makes has to survive the same request arriving again — possibly while the
 * first one is still going, possibly after it died half way through. Three mechanisms carry that,
 * and they solve three different problems that are easy to confuse.
 *
 * **Identity.** The run's `_id` is derived from the network, the job name and the *scheduled* time
 * rather than generated. A retry carries the same scheduled time, so it resolves to the same run and
 * resumes it. Two deliveries of one scheduled tick can therefore never become two runs.
 *
 * **Exclusion.** A lease names the instance that holds the run and when its claim lapses. Mongo here
 * is a standalone with no transactions, so the lease is taken with a conditional update whose filter
 * is the condition — either the document matched and this instance owns the run, or it did not and
 * somebody else does. An instance that dies stops renewing, the lease lapses, and the next delivery
 * takes it over. That is why the lease is short relative to the schedule.
 *
 * **Progress.** The cursor is written as the run goes, not at the end. Cloud Run scales to zero and
 * a container can disappear mid-pass; a run that only checkpointed on success would start from the
 * first account every time and never reach the tail. With the cursor in the document, a resumed run
 * continues where it stopped and the backlog is visible as a number rather than as an absence.
 *
 * The batch limit is a fairness device, not a safety one. A run that reaches it stops and reports
 * `partial`, which the next tick continues from — so a backlog drains over several ticks instead of
 * one run trying to hold a lease for an hour.
 */

import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';

import { getCardanoConfig } from '../../config/cardanoConfig';
import {
  type CardanoStakingConfig,
  loadCardanoStakingConfig
} from '../../config/cardanoStakingConfig';
import { Logger } from '../../helpers/loggerHelper';
import CardanoStakingAccount, {
  type ICardanoStakingAccount
} from '../../models/cardanoStakingAccountModel';
import CardanoStakingOperation from '../../models/cardanoStakingOperationModel';
import CardanoStakingSyncLock from '../../models/cardanoStakingSyncLockModel';
import CardanoStakingSyncRun, {
  type CardanoStakingSyncPhase,
  type CardanoStakingSyncStatus,
  type CardanoStakingSyncStopReason,
  type CardanoStakingSyncTrigger,
  type ICardanoStakingSyncRun
} from '../../models/cardanoStakingSyncRunModel';
import { type IUser, UserModel } from '../../models/userModel';
import {
  type CardanoProvider,
  CardanoProviderError,
  CardanoProviderQuotaError,
  type CardanoProviderRunBudget,
  withCardanoProviderContext
} from './cardanoProviderService';
import { ensureStakingAccountQuietly } from './cardanoStakingAccountService';
import { assembleStakingPlan } from './cardanoStakingAssemblyService';
import {
  DEFAULT_RECONCILIATION_POLICY,
  executeStakingOperation,
  reconcileWhenDue
} from './cardanoStakingLifecycleService';
import { observeStakingAccount } from './cardanoStakingObservationService';
import {
  countSponsoredRegistrations,
  createStakingOperation
} from './cardanoStakingOperationService';
import {
  decideAutomaticAction,
  type StakingAction,
  type StakingDecision
} from './cardanoStakingPlanService';
import type { CardanoPoolState, CardanoStakingProvider } from './cardanoStakingProviderService';
import { requestStakingRefresh } from './cardanoStakingRefreshService';
import { selectableStakingUtxos } from './cardanoStakingReservationService';
import { stakingSignerFor } from './cardanoStakingSignerService';
import { deriveStakingAccountState, type StakingFundsVerdict } from './cardanoStakingStateService';

/**
 * How long an instance's claim on a run lasts.
 *
 * Long enough that a working instance is not interrupted by the next delivery, short enough that one
 * that died does not hold the run past the following tick. The schedule is daily; this is minutes.
 */
const LEASE_SECONDS = 15 * 60;

/**
 * How often a working run extends its lease and the network lock.
 *
 * Well inside {@link LEASE_SECONDS}, so a run that is still making progress never lapses and is
 * never taken over by a redelivery while it works.
 */
const LEASE_RENEW_MS = 60 * 1000;

/** Operations examined for settlement in one pass. */
const RECONCILE_LIMIT = 200;

/** What the sync reads from. */
export type StakingSyncProvider = Pick<
  CardanoProvider,
  'tip' | 'utxosFor' | 'submit' | 'statusOf'
> &
  Pick<
    CardanoStakingProvider,
    'stakingProtocolParameters' | 'stakeAccount' | 'rewardHistory' | 'registrationHistory'
  > &
  // Optional: a provider without it is read as "pool state unknown", which initiates no move.
  Partial<Pick<CardanoStakingProvider, 'poolState'>>;

export interface StakingSyncRequest {
  chainId: number;
  /** The scheduler job, part of the run's identity. */
  jobName: string;
  /**
   * The tick this run is for. A retry carries the same value, which is what makes it resume.
   *
   * For a manual run it is the moment of the request and is recorded, not used as identity.
   */
  scheduledTime: Date;
  /**
   * Whether this run belongs to a scheduled tick or was asked for by hand. Defaults to `scheduled`.
   *
   * A manual run never shares an identity with a tick, so it can neither complete a tick ahead of
   * time nor be answered `already_completed` by one.
   */
  trigger?: CardanoStakingSyncTrigger;
  /** Why the trigger was classified as it was. Recorded on the run. */
  triggerReason?: string | null;
  /**
   * The run's identity, resolved once by {@link runStakingSync}. Callers leave it out: a scheduled
   * run derives it from the tick and a manual one is given a fresh one.
   */
  runId?: string;
  /**
   * The run's provider-request ceiling and what it has spent, from `maxProviderRequestsPerRun`.
   * Created by {@link runStakingSync}; callers leave it out.
   */
  runBudget?: CardanoProviderRunBudget;
  /** Who is running it. Any stable per-process identifier. */
  owner: string;
  /** Accounts refreshed in one pass. */
  batchLimit: number;
  provider: StakingSyncProvider;
  /**
   * Whether the run may build, sign and submit.
   *
   * Off means observe and decide only, writing the snapshot and recording what *would* have been
   * done. That is the mode a deployment runs in before anybody has agreed to spend a fee.
   */
  execute: boolean;
  now?: Date;
  /** Overrides the environment's staking configuration. For tests. */
  config?: CardanoStakingConfig;
}

/** Why a run did nothing. */
export type StakingSyncRefusal =
  /** Staking is off or misconfigured. */
  | 'staking_disabled'
  /** Another instance holds the lease and is still inside it. */
  | 'lease_held'
  /** Another run, with a different identity, is working on this network. */
  | 'overlap_held'
  /** This tick already ran to completion. */
  | 'already_completed';

export interface StakingSyncResult {
  runId: string;
  /** Whether this call did any work. `false` for every refusal. */
  executed: boolean;
  trigger: CardanoStakingSyncTrigger;
  triggerReason: string | null;
  /**
   * The run's status. For `already_completed` it is the stored run's, and the counters below are
   * the stored run's too, so a redelivery reports what the tick did rather than zeroes.
   */
  status: CardanoStakingSyncStatus;
  phase: CardanoStakingSyncPhase;
  accountsScanned: number;
  /** Staking accounts created for wallets that had none. */
  accountsCreated: number;
  operationsReconciled: number;
  actionsStarted: number;
  /** Accounts that decided an action and could not act on it, with the reason. */
  refusals: Record<string, number>;
  backlogCount: number;
  /** Provider requests this run spent, as counted by the shared meter. */
  providerRequests: number;
  /** Why the run stopped short of what was due, when it did. */
  stopReason: CardanoStakingSyncStopReason | null;
  refusal: StakingSyncRefusal | null;
}

/**
 * The run identifier for a scheduled tick.
 *
 * Derived rather than generated, so that a retried delivery resolves to the run it is retrying.
 *
 * @param chainId - The network.
 * @param jobName - The scheduler job.
 * @param scheduledTime - The tick.
 * @returns The `_id`.
 */
export function syncRunId(chainId: number, jobName: string, scheduledTime: Date): string {
  return `${chainId}:${jobName}:${scheduledTime.toISOString()}`;
}

/**
 * A fresh run identifier for a run nobody scheduled.
 *
 * Never derived from a tick. A Cloud Scheduler "Force run" carries the *next* scheduled time in its
 * header; deriving the id from it would complete that tick early and turn the real delivery into
 * `already_completed`. The random suffix keeps two manual calls in the same millisecond apart.
 *
 * @param chainId - The network.
 * @param jobName - The job name the call carried.
 * @param requestedAt - When the call arrived.
 * @returns The `_id`.
 */
export function manualSyncRunId(chainId: number, jobName: string, requestedAt: Date): string {
  return `${chainId}:${jobName}:manual:${requestedAt.toISOString()}:${randomUUID().slice(0, 8)}`;
}

/**
 * Runs one pass, or explains why it did not.
 *
 * @param input - What to run and how far.
 * @returns What happened. A refusal carries `executed: false`.
 */
export async function runStakingSync(input: StakingSyncRequest): Promise<StakingSyncResult> {
  const config = input.config ?? (await loadCardanoStakingConfig(input.chainId));
  const now = input.now ?? new Date();
  const trigger: CardanoStakingSyncTrigger = input.trigger ?? 'scheduled';
  const runId =
    trigger === 'manual'
      ? manualSyncRunId(input.chainId, input.jobName, now)
      : syncRunId(input.chainId, input.jobName, input.scheduledTime);
  // Resolved once and carried down. The passes below need the same settings per account, and
  // re-reading the network document per wallet would multiply one lookup by the batch size.
  const request: StakingSyncRequest = { ...input, config, trigger, runId };

  const empty: StakingSyncResult = {
    runId,
    executed: false,
    trigger,
    triggerReason: input.triggerReason ?? null,
    status: 'failed',
    phase: 'reconciling',
    accountsScanned: 0,
    accountsCreated: 0,
    operationsReconciled: 0,
    actionsStarted: 0,
    refusals: {},
    backlogCount: 0,
    providerRequests: 0,
    stopReason: null,
    refusal: null
  };

  // Two flags, because they answer two questions. `config` is the network's staking settings, and
  // the one below is whether this deployment may act on Cardano at all — an unverified derivation
  // or an unusable chain id switches it off, and a sweep is the one caller that signs without
  // anybody having asked it to. The controller checks it too; this is the service refusing on its
  // own behalf, so a second caller cannot start a sweep the endpoint would have turned away.
  const cardano = getCardanoConfig();
  if (!config.enabled || !cardano.enabled) {
    return { ...empty, status: 'failed', refusal: 'staking_disabled' };
  }

  // A tick that already finished is answered from its own record, before any lock is touched: a
  // redelivery must learn what the tick did, not see zeroes that read as "nothing happened".
  const stored = await CardanoStakingSyncRun.findById(runId).lean<ICardanoStakingSyncRun | null>();
  if (stored !== null && stored.status === 'completed') {
    return { ...fromStoredRun(empty, stored), refusal: 'already_completed' };
  }

  const owner = request.owner;
  if (!(await acquireNetworkLock(request.chainId, runId, owner, now))) {
    return {
      ...(stored === null ? empty : fromStoredRun(empty, stored)),
      status: stored?.status ?? 'running',
      refusal: 'overlap_held'
    };
  }

  const renewal = leaseRenewal(request.chainId, runId, owner);
  let result: StakingSyncResult = { ...empty, status: 'running', refusal: null };

  try {
    const claim = await claimRun(runId, request, now);
    if (claim !== 'claimed') {
      return {
        ...(stored === null ? empty : fromStoredRun(empty, stored)),
        status: stored?.status ?? 'running',
        refusal: claim
      };
    }
    result = await executeRun(request, runId, renewal, result);
  } finally {
    parameterCaches.delete(runId);
    for (const key of poolStateCache.keys()) {
      if (key.startsWith(`${runId}|`)) poolStateCache.delete(key);
    }
    await releaseNetworkLock(request.chainId, runId, owner);
  }

  return result;
}

/**
 * The passes of one claimed run.
 *
 * @param request - The run's request, with its configuration resolved.
 * @param runId - The run's identity.
 * @param renewal - Extends the lease and the network lock while the run works.
 * @param initial - The result being accumulated.
 * @returns What happened.
 */
async function executeRun(
  request: StakingSyncRequest,
  runId: string,
  renewal: LeaseRenewal,
  initial: StakingSyncResult
): Promise<StakingSyncResult> {
  const result: StakingSyncResult = { ...initial, executed: true };
  const config = request.config ?? (await loadCardanoStakingConfig(request.chainId));
  // One budget for the whole run, shared by both passes: `maxProviderRequestsPerRun` is a ceiling on
  // what one run may spend, on top of the shared daily quota every request is also reserved against.
  const runBudget: CardanoProviderRunBudget = { limit: config.maxProviderRequestsPerRun, used: 0 };
  const budgeted: StakingSyncRequest = { ...request, runBudget };

  try {
    await setPhase(runId, 'reconciling');
    // Settling operations already on their way is `pending` work: it outranks discovery and refresh,
    // and keeps running when the background share of the quota is spent.
    result.operationsReconciled = await withCardanoProviderContext(
      { priority: 'pending', origin: 'sync.reconcile', runBudget },
      () => reconcilePass(budgeted, renewal)
    );

    // Before the refresh, so an account created now is refreshed by the same run instead of waiting
    // for tomorrow's. A wallet with no account is invisible to the refresh, which is why discovery
    // reads `users` rather than the accounts.
    await setPhase(runId, 'discovering');
    result.accountsCreated = await discoveryPass(request);

    await setPhase(runId, 'refreshing');
    const refreshed = await withCardanoProviderContext(
      { priority: 'background', origin: 'sync.refresh', runBudget },
      () => refreshPass(budgeted, result, renewal)
    );
    result.providerRequests = runBudget.used;
    result.accountsScanned = refreshed.scanned;
    result.backlogCount = refreshed.backlog;
    result.stopReason = refreshed.stopReason;
    result.status = refreshed.exhausted ? 'completed' : 'partial';
    result.phase = refreshed.exhausted ? 'done' : 'refreshing';

    await CardanoStakingSyncRun.updateOne(
      { _id: runId },
      {
        $set: {
          phase: result.phase,
          status: result.status,
          stopReason: result.stopReason,
          finishedAt: new Date(),
          lease: null,
          userCursor: refreshed.cursor,
          accountsScanned: result.accountsScanned,
          accountsCreated: result.accountsCreated,
          operationsReconciled: result.operationsReconciled,
          providerRequests: result.providerRequests,
          backlogCount: result.backlogCount,
          backlogOldestAt: refreshed.backlogOldestAt
        }
      }
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    Logger.error('runStakingSync', `Cardano staking sync ${runId} failed: ${detail}`);
    // The lease is released rather than held to its expiry. The run failed; the next delivery should
    // be able to pick it up now instead of waiting out a claim nobody is using.
    result.providerRequests = runBudget.used;
    await CardanoStakingSyncRun.updateOne(
      { _id: runId },
      {
        $set: {
          status: 'failed',
          lease: null,
          lastError: detail,
          finishedAt: new Date(),
          providerRequests: runBudget.used
        }
      }
    );
    result.status = 'failed';
  }

  return result;
}

/**
 * Takes the run, creating it when this is the first delivery of the tick.
 *
 * The filter is the condition. There is no read-then-write here and no transaction to make one safe:
 * either the conditional update matched — in which case this instance owns the run — or it did not,
 * and somebody else does.
 *
 * @param runId - The run's identity.
 * @param request - The request, for the fields a new run is created with.
 * @param now - The clock.
 * @returns `'claimed'`, or why not.
 */
async function claimRun(
  runId: string,
  request: StakingSyncRequest,
  now: Date
): Promise<'claimed' | StakingSyncRefusal> {
  const expiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000);
  const lease = { owner: request.owner, expiresAt };

  const existing = await CardanoStakingSyncRun.findById(runId).lean();

  if (existing === null) {
    try {
      await CardanoStakingSyncRun.create({
        _id: runId,
        chainId: request.chainId,
        scheduledTime: request.scheduledTime,
        trigger: request.trigger ?? 'scheduled',
        triggerReason: request.triggerReason ?? null,
        startedAt: now,
        lease,
        phase: 'reconciling',
        status: 'running'
      });
      return 'claimed';
    } catch {
      // Another instance created it between the read and the insert. Fall through to the takeover
      // path, which is the same code that handles a lapsed lease.
    }
  } else if (existing.status === 'completed') {
    // The whole point of deriving the id: a retried delivery of a tick that already finished is a
    // no-op, not a second pass over every account.
    return 'already_completed';
  }

  const taken = await CardanoStakingSyncRun.updateOne(
    {
      _id: runId,
      status: { $ne: 'completed' },
      $or: [{ lease: null }, { 'lease.owner': request.owner }, { 'lease.expiresAt': { $lt: now } }]
    },
    { $set: { lease, status: 'running' } }
  );

  return taken.matchedCount === 1 ? 'claimed' : 'lease_held';
}

/**
 * A refusal's result, filled from the stored run so the counters describe what that run did.
 *
 * @param base - The empty result for this call.
 * @param stored - The run as stored.
 * @returns The result.
 */
function fromStoredRun(base: StakingSyncResult, stored: ICardanoStakingSyncRun): StakingSyncResult {
  return {
    ...base,
    executed: false,
    status: stored.status,
    phase: stored.phase,
    trigger: stored.trigger ?? base.trigger,
    triggerReason: stored.triggerReason ?? base.triggerReason,
    accountsScanned: stored.accountsScanned ?? 0,
    accountsCreated: stored.accountsCreated ?? 0,
    operationsReconciled: stored.operationsReconciled ?? 0,
    backlogCount: stored.backlogCount ?? 0,
    providerRequests: stored.providerRequests ?? 0,
    stopReason: stored.stopReason ?? null
  };
}

/**
 * Takes the network lock for a run.
 *
 * The filter matches a lock that lapsed or that this same run and process already hold; anything
 * else makes the upsert try to insert an `_id` that exists, and the duplicate-key error is the
 * refusal. No read precedes the write, so two instances cannot both conclude the lock is free.
 *
 * @param chainId - The network.
 * @param runId - The run asking.
 * @param owner - The process asking.
 * @param now - The clock.
 * @returns Whether the lock is now held by this run.
 * @throws Any database error other than the duplicate key that means "held elsewhere".
 */
export async function acquireNetworkLock(
  chainId: number,
  runId: string,
  owner: string,
  now: Date
): Promise<boolean> {
  try {
    await CardanoStakingSyncLock.updateOne(
      {
        _id: String(chainId),
        $or: [{ expiresAt: { $lt: now } }, { runId, owner }]
      },
      {
        $set: {
          runId,
          owner,
          expiresAt: new Date(now.getTime() + LEASE_SECONDS * 1000),
          acquiredAt: now
        }
      },
      { upsert: true }
    );
    return true;
  } catch (error) {
    if (isDuplicateKey(error)) return false;
    throw error;
  }
}

/**
 * Gives the network lock back, if this run still holds it.
 *
 * Conditional on the holder, so a run whose lock lapsed and was taken by another cannot release the
 * other run's claim.
 *
 * @param chainId - The network.
 * @param runId - The run releasing.
 * @param owner - The process releasing.
 */
async function releaseNetworkLock(chainId: number, runId: string, owner: string): Promise<void> {
  await CardanoStakingSyncLock.deleteOne({ _id: String(chainId), runId, owner });
}

/** Extends a working run's lease and network lock, at most once per {@link LEASE_RENEW_MS}. */
interface LeaseRenewal {
  renewIfDue(): Promise<void>;
}

/**
 * The renewal a run carries through its passes.
 *
 * The lease was previously written once and never extended, so a run that took longer than the
 * lease could be taken over by a redelivery while it was still working. Renewing from the passes
 * themselves ties the claim to progress: a run that stops making progress stops renewing.
 *
 * @param chainId - The network.
 * @param runId - The run.
 * @param owner - The process holding both claims.
 * @returns The renewal.
 */
function leaseRenewal(chainId: number, runId: string, owner: string): LeaseRenewal {
  let last = Date.now();
  return {
    async renewIfDue(): Promise<void> {
      const now = Date.now();
      if (now - last < LEASE_RENEW_MS) return;
      last = now;
      const expiresAt = new Date(now + LEASE_SECONDS * 1000);
      await CardanoStakingSyncRun.updateOne(
        { _id: runId, 'lease.owner': owner },
        { $set: { 'lease.expiresAt': expiresAt } }
      );
      await CardanoStakingSyncLock.updateOne(
        { _id: String(chainId), runId, owner },
        { $set: { expiresAt } }
      );
    }
  };
}

/**
 * Whether a database error is a unique-index collision.
 *
 * @param error - What was thrown.
 * @returns `true` for code 11000.
 */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * Moves the run's phase marker.
 *
 * @param runId - The run.
 * @param phase - Where it is.
 */
async function setPhase(runId: string, phase: CardanoStakingSyncPhase): Promise<void> {
  await CardanoStakingSyncRun.updateOne({ _id: runId }, { $set: { phase } });
}

/**
 * Settles operations that are still live.
 *
 * Deliberately first. An account with an operation in flight is refused a new one, so reconciling
 * before refreshing is what lets a settled operation free its account inside the same pass instead of
 * waiting a further day.
 *
 * @param request - The run's request.
 * @param renewal - Keeps the run's claims alive while it works.
 * @returns How many operations were examined.
 */
async function reconcilePass(request: StakingSyncRequest, renewal: LeaseRenewal): Promise<number> {
  const live = await CardanoStakingOperation.find({
    chainId: request.chainId,
    status: { $in: ['signed', 'submitted', 'unknown_submit'] },
    // Only the ones due. A pass that found nothing due does not read the tip at all.
    $or: [
      { nextCheckAt: null },
      { nextCheckAt: { $exists: false } },
      { nextCheckAt: { $lte: request.now ?? new Date() } }
    ]
  })
    .limit(RECONCILE_LIMIT)
    .exec();

  if (live.length === 0) return 0;

  const tip = await request.provider.tip();
  let examined = 0;

  const config = request.config ?? (await loadCardanoStakingConfig(request.chainId));
  const now = request.now ?? new Date();

  for (const operation of live) {
    await renewal.renewIfDue();
    try {
      // The same claimed entry point the dashboard uses: an operation a screen looked at a moment
      // ago is not looked at again, and neither side can settle on a laxer rule than the other.
      const due = await reconcileWhenDue(
        operation._id as Types.ObjectId,
        request.provider,
        config.operationStatusCheckIntervalMs,
        now,
        DEFAULT_RECONCILIATION_POLICY,
        tip.slot
      );
      if (due.checked) examined += 1;
      if (due.outcome === 'confirmed' || due.outcome === 'absent_past_ttl') {
        await requestStakingRefresh(
          { accountIds: [operation.accountId] },
          due.outcome === 'confirmed' ? 'operation_confirmed' : 'operation_settled',
          now
        );
      }
    } catch (error) {
      // One operation that cannot be reconciled does not stop the pass. It stays live and is
      // examined again on the next tick, which is the correct outcome: nothing about it was decided.
      Logger.warn(
        'runStakingSync',
        `Cardano staking operation ${String(operation._id)} could not be reconciled: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return examined;
}

/**
 * Gives a staking account to every Cardano wallet on this network that has none.
 *
 * The refresh pass reads accounts, so a wallet without one is invisible to it and stays invisible
 * forever: no read creates the row and the user is answered `no_staking_account` for as long as that
 * lasts. This pass is the other half — it reads `users`, and what it writes is what the refresh then
 * has something to refresh.
 *
 * Creating a row enrols nobody. The account starts at `awaiting_consent` with the preference off, so
 * what this pass changes is whether the position can be *seen*, not whether it participates.
 *
 * The wallets that already have an account are excluded by the query rather than skipped in the loop,
 * and that is what makes the pass finish its universe. Bounded by the batch limit like the refresh —
 * a pass that walked every user would make the length of a run depend on the size of the product —
 * and a limit spent on wallets that need nothing is a limit that never reaches the ones that do: with
 * a universe larger than one batch, every run would examine the same first users, find them all
 * provisioned, and the tail would never be reached. Excluding them means each run spends its budget
 * on alta and the remainder shrinks by what was created.
 *
 * @param request - The run's request.
 * @returns How many accounts were created.
 */
async function discoveryPass(request: StakingSyncRequest): Promise<number> {
  const pending = await UserModel.aggregate<{ _id: Types.ObjectId }>([
    {
      $match: {
        wallets: { $elemMatch: { chain_id: request.chainId, address_type: 'cardano_base' } }
      }
    },
    // Oldest first, and before the lookup: the sort decides who the batch is spent on, so it has to
    // happen while the whole universe is still in play.
    { $sort: { _id: 1 } },
    {
      // The join runs against `user_chain_unique`, and `$limit: 1` inside it is what keeps this from
      // reading a user's accounts on other networks.
      $lookup: {
        from: 'cardano_staking_accounts',
        let: { userId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$userId', '$$userId'] }, chainId: request.chainId } },
          { $limit: 1 },
          { $project: { _id: 1 } }
        ],
        as: 'stakingAccount'
      }
    },
    { $match: { stakingAccount: { $size: 0 } } },
    { $limit: request.batchLimit },
    { $project: { _id: 1 } }
  ]);

  let created = 0;

  for (const row of pending) {
    // Read as a document rather than carried out of the aggregation: the alta needs the wallets, and
    // a user who was provisioned between the query and here is answered by the same idempotent path.
    const user = await UserModel.findById(row._id).exec();
    if (user === null) continue;

    const wallet = user.wallets.find(
      (entry) => entry.chain_id === request.chainId && entry.address_type === 'cardano_base'
    );
    if (wallet === undefined) continue;

    // Quietly: one wallet whose data cannot produce an account is not a reason to abandon the rest of
    // the pass, and the refusal is logged with which wallet it was. A wallet refused this way is read
    // again by the next run, which is the right behaviour — the fix is in the wallet, and when it
    // lands the account appears without anybody rerunning anything.
    if (await ensureStakingAccountQuietly(user, wallet)) created += 1;
  }

  if (created > 0) {
    Logger.log(
      'discoveryPass',
      `Created ${created} Cardano staking accounts on ${request.chainId}`
    );
  }
  return created;
}

/** What one refresh pass got through. */
interface RefreshOutcome {
  scanned: number;
  cursor: string | null;
  exhausted: boolean;
  backlog: number;
  backlogOldestAt: Date | null;
  stopReason: CardanoStakingSyncStopReason | null;
}

/** Stops a pass because a quota said no. The account being worked on stays due. */
class SweepHalt extends Error {
  /**
   * @param reason - Which ceiling stopped the pass.
   */
  constructor(readonly reason: CardanoStakingSyncStopReason) {
    super(`sweep halted: ${reason}`);
    this.name = 'SweepHalt';
  }
}

/** Shortest wait before an account whose read failed is tried again. */
const OBSERVATION_BACKOFF_BASE_MS = 15 * 60 * 1000;

/**
 * The filter for accounts due now.
 *
 * `null` is due: an account created by discovery, and every account written before the field
 * existed, is read on the first pass that reaches it.
 *
 * @param chainId - The network.
 * @param now - The clock.
 * @returns The filter.
 */
function dueFilter(chainId: number, now: Date): Record<string, unknown> {
  return { chainId, $or: [{ nextEligibleCheckAt: null }, { nextEligibleCheckAt: { $lte: now } }] };
}

/**
 * Observes the accounts that are due, decides what each needs, and acts when the run may.
 *
 * Selected by `nextEligibleCheckAt`, oldest due first, rather than by `_id`. Every account read is
 * given its next check before the pass moves on — a day out for an empty, unregistered wallet, hours
 * for one that holds ada or is registered, a backoff for one whose read failed — so what a pass did
 * is recorded on the accounts themselves. An interrupted pass resumes by selecting what is still due,
 * and an account can neither be starved (its due time only ever ages) nor read far more often than
 * its cadence. A transfer or a settled operation makes an account due now through
 * `cardanoStakingRefreshService`, which never touches consent or opt-out.
 *
 * A quota refusal or a provider 429 stops the pass where it is. The account being worked on keeps
 * its due time and is first in line next time; nothing is marked as checked that was not.
 *
 * @param request - The run's request.
 * @param result - Accumulates what was started and what was refused.
 * @param renewal - Keeps the run's claims alive while it works.
 * @returns How far it got.
 */
async function refreshPass(
  request: StakingSyncRequest,
  result: StakingSyncResult,
  renewal: LeaseRenewal
): Promise<RefreshOutcome> {
  const runId = runIdOf(request);
  const now = request.now ?? new Date();

  // Accounts something in this backend asked to refresh go first — a transfer, a settled operation.
  // Ordered by due time alone they would queue behind every never-checked and every older due
  // account, which on a first pass over a large universe is hours. The rest of the batch is the
  // oldest due, so the periodic checks still advance on every run.
  const requested = await CardanoStakingAccount.find({
    ...dueFilter(request.chainId, now),
    refreshRequestedAt: { $ne: null, $lte: now }
  })
    .sort({ refreshRequestedAt: 1, _id: 1 })
    .limit(request.batchLimit)
    .exec();
  const periodic =
    requested.length >= request.batchLimit
      ? []
      : await CardanoStakingAccount.find({
          ...dueFilter(request.chainId, now),
          _id: { $nin: requested.map((account) => account._id) }
        })
          .sort({ nextEligibleCheckAt: 1, _id: 1 })
          .limit(request.batchLimit - requested.length)
          .exec();
  const accounts = [...requested, ...periodic];

  let scanned = 0;
  let lastId: string | null = null;
  let stopReason: CardanoStakingSyncStopReason | null = null;

  for (const account of accounts) {
    await renewal.renewIfDue();
    try {
      await refreshAccount(account, request, result);
    } catch (error) {
      const halt = haltReason(error, request);
      if (halt !== null) {
        stopReason = halt;
        break;
      }
      // Recorded on the account rather than raised. One unreadable wallet is not a reason to abandon
      // the rest of the universe, and the error is exactly the thing the next pass needs to see.
      const detail = error instanceof Error ? error.message : String(error);
      Logger.warn(
        'runStakingSync',
        `Cardano staking account ${String(account._id)} failed: ${detail}`
      );
      await scheduleAfterFailure(account, request, `sync:${detail}`);
    }
    lastId = String(account._id);
    scanned += 1;

    // The checkpoint goes in as the pass goes, not at the end. A container that disappears here has
    // still recorded everything before this point.
    await CardanoStakingSyncRun.updateOne(
      { _id: runId },
      {
        $set: {
          userCursor: lastId,
          accountsScanned: scanned,
          providerRequests: request.runBudget?.used ?? 0
        }
      }
    );
  }

  const due = dueFilter(request.chainId, now);
  const backlog = await CardanoStakingAccount.countDocuments(due);
  const oldest =
    backlog === 0
      ? null
      : await CardanoStakingAccount.findOne(due)
          .sort({ nextEligibleCheckAt: 1, _id: 1 })
          .select('nextEligibleCheckAt lastSyncAt createdAt')
          .lean<{ nextEligibleCheckAt: Date | null; lastSyncAt: Date | null; createdAt?: Date }>();
  const exhausted = backlog === 0;

  return {
    scanned,
    cursor: exhausted ? null : lastId,
    exhausted,
    backlog,
    // Since when the oldest due account has been waiting: its due time, or for one never checked,
    // when it was last attempted or created.
    backlogOldestAt:
      oldest === null
        ? null
        : (oldest.nextEligibleCheckAt ?? oldest.lastSyncAt ?? oldest.createdAt ?? null),
    stopReason: exhausted ? null : (stopReason ?? 'batch_limit')
  };
}

/**
 * Whether an error means the pass has to stop, and why.
 *
 * @param error - What was thrown while refreshing one account.
 * @param request - The run's request, for its request budget.
 * @returns The stop reason, or `null` for an error that concerns only that account.
 */
function haltReason(
  error: unknown,
  request: StakingSyncRequest
): CardanoStakingSyncStopReason | null {
  if (error instanceof SweepHalt) return error.reason;
  if (error instanceof CardanoProviderQuotaError) {
    return error.scope === 'run' ? 'run_request_limit' : 'rate_limited';
  }
  if (error instanceof CardanoProviderError && error.failure === 'rate_limited') {
    return runBudgetSpent(request) ? 'run_request_limit' : 'rate_limited';
  }
  return null;
}

/**
 * Whether the run has used its whole request budget.
 *
 * @param request - The run's request.
 * @returns `true` when a budget is set and spent.
 */
function runBudgetSpent(request: StakingSyncRequest): boolean {
  const budget = request.runBudget;
  return budget !== undefined && budget.used >= budget.limit;
}

/**
 * One account: read it, decide, and act if allowed.
 *
 * An unregistered credential the provider reports as holding nothing costs one request: the stake
 * account read, which carries the total under the credential. Nothing else is read for it — no reward
 * history, no parameters, no UTxOs — because nothing could be decided: an empty wallet cannot pay a
 * deposit. When the provider does not report that total, the full path runs as before.
 *
 * @param account - The account.
 * @param request - The run's request.
 * @param result - Accumulates what happened.
 * @throws SweepHalt When a quota refused the account's read.
 */
async function refreshAccount(
  account: ICardanoStakingAccount,
  request: StakingSyncRequest,
  result: StakingSyncResult
): Promise<void> {
  const now = request.now ?? new Date();
  const config = request.config ?? (await loadCardanoStakingConfig(request.chainId));
  const observation = await observeStakingAccount(account, request.provider, now);

  if (observation.outcome !== 'observed' || observation.state === null) {
    if (observation.reason === 'rate_limited') {
      throw new SweepHalt(runBudgetSpent(request) ? 'run_request_limit' : 'rate_limited');
    }
    count(result, `observe_${observation.reason ?? 'unavailable'}`);
    await scheduleAfterFailure(account, request, null);
    return;
  }

  const controlled = observation.state.controlledLovelace ?? null;
  const empty = !observation.state.registered && controlled === 0n;

  const cadence = new Date(
    now.getTime() + (empty ? config.emptyAccountRecheckMs : config.activeAccountRecheckMs)
  );
  // One pipeline update, so a refresh requested while this account was being read is honoured
  // atomically: a request whose moment lies ahead of this observation keeps the next check no later
  // than that moment and is not cleared; one this observation already covers is cleared.
  const pending = { $ifNull: ['$refreshRequestedAt', null] };
  const ahead = { $and: [{ $ne: [pending, null] }, { $gt: [pending, now] }] };
  await CardanoStakingAccount.updateOne({ _id: account._id }, [
    {
      $set: {
        lastSyncAt: now,
        observationFailures: 0,
        lastKnownBalanceLovelace: controlled === null ? null : String(controlled),
        ...(controlled !== null && controlled > 0n ? { lastPositiveBalanceAt: now } : {}),
        nextEligibleCheckAt: { $cond: [ahead, { $min: [cadence, pending] }, cadence] },
        refreshRequestedAt: { $cond: [ahead, pending, null] },
        refreshReason: { $cond: [ahead, '$refreshReason', null] }
      }
    }
  ]);

  if (empty) {
    await writeState(account._id as Types.ObjectId, 'not_eligible', config.consentRequired);
    count(result, 'empty_wallet');
    return;
  }

  const user = await UserModel.findById(account.userId).exec();
  if (user === null) {
    count(result, 'user_missing');
    return;
  }

  const decision = await decide(account, user, request);

  // Recomputed on every pass, before anything is started and again after. The state is derived from
  // facts held elsewhere, so recomputing it is how an account whose state drifted is corrected —
  // rather than by somebody noticing that a registered wallet still reads `awaiting_consent`.
  await writeState(account._id as Types.ObjectId, decision.refusal, config.consentRequired);

  if (decision.action === 'none') {
    count(result, decision.refusal ?? 'nothing_to_do');
    return;
  }

  if (!request.execute) {
    count(result, `would_${decision.action}`);
    return;
  }

  // The account as stored after this pass observed it. The copy the pass selected predates the
  // observation, and for a wallet read for the first time it carries no confirmed chain read, which
  // the operation guard refuses — leaving the enrolment to the next pass for no reason.
  const observed = (await CardanoStakingAccount.findById(account._id).exec()) ?? account;
  const started = await startAction(observed, user, decision.action, request);
  if (started === 'started') result.actionsStarted += 1;
  else count(result, started);

  await writeState(account._id as Types.ObjectId, decision.refusal, config.consentRequired);
}

/**
 * Records a failed read and pushes the account's next check out.
 *
 * `lastObservedAt` is not touched: it says when the chain last answered, and a failure is not an
 * answer. The wait doubles per consecutive failure, from fifteen minutes up to the active cadence.
 *
 * @param account - The account.
 * @param request - The run's request.
 * @param lastError - What to record, or `null` to leave the observation's own record.
 */
async function scheduleAfterFailure(
  account: ICardanoStakingAccount,
  request: StakingSyncRequest,
  lastError: string | null
): Promise<void> {
  const now = request.now ?? new Date();
  const config = request.config ?? (await loadCardanoStakingConfig(request.chainId));
  const failures = (account.observationFailures ?? 0) + 1;
  const delay = Math.min(
    OBSERVATION_BACKOFF_BASE_MS * 2 ** (failures - 1),
    config.activeAccountRecheckMs
  );
  await CardanoStakingAccount.updateOne(
    { _id: account._id },
    {
      $set: {
        lastSyncAt: now,
        observationFailures: failures,
        nextEligibleCheckAt: new Date(now.getTime() + delay),
        ...(lastError === null ? {} : { lastError })
      }
    }
  );
}

/**
 * Recomputes and stores the state an account is shown as.
 *
 * @param accountId - The account.
 * @param refusal - Why the sweep did nothing, which is what says whether the wallet is short of funds
 *   or simply had nothing to do.
 * @param consentRequired - Whether this deployment requires the terms to have been accepted, which
 *   decides whether a wallet nobody asked reads as waiting for the user or as waiting for funds.
 */
async function writeState(
  accountId: Types.ObjectId,
  refusal: StakingDecision['refusal'],
  consentRequired: boolean
): Promise<void> {
  const account = await CardanoStakingAccount.findById(accountId).exec();
  if (account === null) return;

  const live = await CardanoStakingOperation.findOne({
    accountId,
    status: {
      $in: ['queued', 'executing', 'signed', 'submitted', 'unknown_submit', 'manual_review']
    }
  })
    .sort({ createdAt: -1 })
    .lean();

  // Only one refusal says anything about the funds. Every other one leaves the verdict absent, which
  // the derivation reads as no opinion rather than as "sufficient".
  const funds: StakingFundsVerdict = refusal === 'not_eligible' ? 'insufficient' : null;

  const state = deriveStakingAccountState(
    account,
    live === null ? null : { kind: live.kind, status: live.status },
    funds,
    consentRequired
  );

  if (state !== account.state) {
    await CardanoStakingAccount.updateOne({ _id: accountId }, { $set: { state } });
  }
}

/**
 * What the sweep concludes for one account.
 *
 * @param account - The account, freshly observed.
 * @param user - Its user, for the signer check.
 * @param request - The run's request.
 * @returns The decision.
 */
async function decide(
  account: ICardanoStakingAccount,
  user: IUser,
  request: StakingSyncRequest
): Promise<StakingDecision> {
  const config = request.config ?? (await loadCardanoStakingConfig(request.chainId));
  const fresh = await CardanoStakingAccount.findById(account._id).exec();
  const subject = fresh ?? account;

  const parameters = await decisionParameters(request);
  const signer = stakingSignerFor(subject, user);
  const utxos = signer.available
    ? await selectableStakingUtxos(await request.provider.utxosFor(subject.walletAddress))
    : [];
  const spendable = utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);

  const decision = decideAutomaticAction(subject, {
    config,
    parameters,
    addressBytes: signer.available ? signer.material.user.addressBytes : new Uint8Array(),
    spendableLovelace: spendable,
    poolState: await poolStateFor(subject, config, request),
    operationInFlight: await hasLiveOperation(subject._id as Types.ObjectId),
    signerAvailable: signer.available,
    sponsoredRegistrationsInWindow: await countSponsoredRegistrations(
      subject._id as Types.ObjectId,
      config.sponsorWindowDays
    )
  });

  // The chain reads `none` again when a user's own vote delegation never landed — expired or
  // refused. The default is for credentials nobody chose for; one whose owner asked for a delegation
  // of their own is left for them to repeat, rather than given the default on their behalf.
  if (decision.action === 'delegate_vote' && (await userChoseVote(subject._id as Types.ObjectId))) {
    return { action: 'none', refusal: 'not_available', detail: 'user_governance_choice' };
  }
  return decision;
}

/**
 * Whether the account's owner ever asked for a vote delegation of their own.
 *
 * @param accountId - The account.
 * @returns `true` when a `delegate_vote` operation exists that the sweep did not start.
 */
async function userChoseVote(accountId: Types.ObjectId): Promise<boolean> {
  const chosen = await CardanoStakingOperation.exists({
    accountId,
    kind: 'delegate_vote',
    actor: { $ne: 'cron' }
  });
  return chosen !== null;
}

/**
 * Protocol parameters for deciding, read once per run.
 *
 * Only the decision reads them from here: whether a wallet clears the threshold does not change
 * inside a run of a few minutes, and reading them per account multiplied one request by every funded
 * wallet. Building and signing never use this copy — `assembleStakingPlan` reads the parameters in
 * force at that moment, which is what the deposit and fee in a transaction must come from. A failed
 * read is not kept, so the next account asks again.
 *
 * @param request - The run's request, which carries the cache for the run.
 * @returns The parameters.
 */
function decisionParameters(
  request: StakingSyncRequest
): ReturnType<StakingSyncProvider['stakingProtocolParameters']> {
  const cache = parameterCaches.get(request.runId ?? '');
  if (cache !== undefined) return cache;
  const read = request.provider.stakingProtocolParameters();
  const key = request.runId ?? '';
  parameterCaches.set(key, read);
  read.catch(() => parameterCaches.delete(key));
  return read;
}

/**
 * The state of the pool an account delegates to, when the sweep may act on it.
 *
 * Read only when `autoRedelegateRetiredPools` is on and the credential is registered to a pool: with
 * the flag off nothing would be done with the answer, so no request is spent on it. Each pool is read
 * once per run, however many accounts delegate to it. A failed read is `null` — unknown — which
 * initiates no move; a quota refusal or 429 still stops the pass.
 *
 * @param account - The account, freshly observed.
 * @param config - The network's settings.
 * @param request - The run's request, which carries the per-run cache key.
 * @returns The pool's state, or `null`.
 */
async function poolStateFor(
  account: ICardanoStakingAccount,
  config: CardanoStakingConfig,
  request: StakingSyncRequest
): Promise<CardanoPoolState | null> {
  const poolId = account.onChain.poolId;
  const read = request.provider.poolState;
  if (!config.autoRedelegateRetiredPools || !account.onChain.registered) return null;
  if (poolId === null || read === undefined) return null;

  const key = `${request.runId ?? ''}|${poolId}`;
  let pending = poolStateCache.get(key);
  if (pending === undefined) {
    pending = read.call(request.provider, poolId);
    poolStateCache.set(key, pending);
  }
  try {
    return await pending;
  } catch (error) {
    poolStateCache.delete(key);
    if (error instanceof CardanoProviderError && error.failure === 'rate_limited') throw error;
    Logger.warn(
      'runStakingSync',
      `Pool ${poolId} could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/** Per-run pool reads, keyed by `<runId>|<poolId>` and dropped when the run ends. */
const poolStateCache = new Map<string, Promise<CardanoPoolState | null>>();

/** Per-run parameter reads, keyed by run id and dropped when the run ends. */
const parameterCaches = new Map<
  string,
  ReturnType<StakingSyncProvider['stakingProtocolParameters']>
>();

/**
 * Whether an operation already holds this credential.
 *
 * @param accountId - The account.
 * @returns `true` when one is live.
 */
async function hasLiveOperation(accountId: Types.ObjectId): Promise<boolean> {
  const live = await CardanoStakingOperation.countDocuments({
    accountId,
    status: { $in: ['queued', 'executing', 'signed', 'submitted', 'unknown_submit'] }
  });
  return live > 0;
}

/**
 * Creates the operation, assembles its plan and executes it.
 *
 * @param account - The account.
 * @param user - Its user.
 * @param action - What was decided.
 * @param request - The run's request.
 * @returns `'started'`, or the refusal that stopped it.
 */
async function startAction(
  account: ICardanoStakingAccount,
  user: IUser,
  action: Exclude<StakingAction, 'none'>,
  request: StakingSyncRequest
): Promise<string> {
  const assembly = await assembleStakingPlan({
    account,
    user,
    action,
    provider: request.provider,
    ...(request.config === undefined ? {} : { config: request.config })
  });
  if (assembly.outcome === 'refused') return `assembly_${assembly.refusal}`;

  // Opened here when the sweep is the one starting the cycle.
  //
  // A cycle groups every operation and deposit event of one registration, and an operation cannot
  // exist without one. The consent write opens a cycle for a wallet whose owner joined deliberately;
  // a wallet enrolled automatically has no consent write, so without this the sweep decides to enrol
  // it and then cannot create the operation that would.
  //
  // `financingMode` is fixed in the same write and for the same reason it is fixed at consent time:
  // it says whose the deposit is, and reading it from configuration when the position is unwound
  // would let a settings change reassign ownership of ada that is already on chain.
  if (action === 'register_and_delegate' && !account.currentLifecycleId) {
    const opened = `${String(account._id)}:${Date.now()}`;
    await CardanoStakingAccount.updateOne(
      { _id: account._id as Types.ObjectId },
      { $set: { currentLifecycleId: opened, financingMode: account.financingMode ?? 'user' } }
    );
    account.currentLifecycleId = opened;
  }

  const runId = runIdOf(request);
  let operation: Awaited<ReturnType<typeof createStakingOperation>>;
  try {
    operation = await createStakingOperation(account, {
      kind: action,
      actor: 'cron',
      // Derived from the run and the account, so a retried delivery of the same tick cannot create a
      // second operation for the same account and action.
      idempotencyKey: `${runId}:${String(account._id)}:${action}`
    });
  } catch (error) {
    return `create_${error instanceof Error ? error.message : String(error)}`;
  }

  const execution = await executeStakingOperation({
    operation,
    plan: assembly.plan,
    signer: assembly.signer,
    provider: request.provider,
    estimatedFeeLovelace: assembly.estimatedFeeLovelace,
    budget: {
      chainId: request.chainId,
      window: windowFor(request.now ?? new Date()),
      capLovelace: String(
        (request.config ?? (await loadCardanoStakingConfig(request.chainId))).feeDailyCapLovelace
      ),
      lifecycleId: operation.lifecycleId,
      kind: action
    }
  });

  return execution.outcome === 'submitted' || execution.outcome === 'unknown_submit'
    ? 'started'
    : `execute_${execution.outcome}`;
}

/**
 * The identity {@link runStakingSync} resolved for this run.
 *
 * @param request - The run's request.
 * @returns The run id; derived from the tick when the request predates the field.
 */
function runIdOf(request: StakingSyncRequest): string {
  return request.runId ?? syncRunId(request.chainId, request.jobName, request.scheduledTime);
}

/**
 * The budget window a moment falls in.
 *
 * @param now - The clock.
 * @returns The window key.
 */
function windowFor(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Counts one outcome.
 *
 * @param result - The accumulator.
 * @param key - What happened.
 */
function count(result: StakingSyncResult, key: string): void {
  result.refusals[key] = (result.refusals[key] ?? 0) + 1;
}

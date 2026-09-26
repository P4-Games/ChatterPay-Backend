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
import CardanoStakingSyncRun, {
  type CardanoStakingSyncPhase,
  type CardanoStakingSyncStatus
} from '../../models/cardanoStakingSyncRunModel';
import { type IUser, UserModel } from '../../models/userModel';
import type { CardanoProvider } from './cardanoProviderService';
import { ensureStakingAccountQuietly } from './cardanoStakingAccountService';
import { assembleStakingPlan } from './cardanoStakingAssemblyService';
import {
  DEFAULT_RECONCILIATION_POLICY,
  executeStakingOperation,
  reconcileStakingOperation
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
import type { CardanoStakingProvider } from './cardanoStakingProviderService';
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
  >;

export interface StakingSyncRequest {
  chainId: number;
  /** The scheduler job, part of the run's identity. */
  jobName: string;
  /** The tick this run is for. A retry carries the same value, which is what makes it resume. */
  scheduledTime: Date;
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
  /** This tick already ran to completion. */
  | 'already_completed';

export interface StakingSyncResult {
  runId: string;
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
 * Runs one pass, or explains why it did not.
 *
 * @param request - What to run and how far.
 * @returns What happened.
 */
export async function runStakingSync(input: StakingSyncRequest): Promise<StakingSyncResult> {
  const config = input.config ?? (await loadCardanoStakingConfig(input.chainId));
  // Resolved once and carried down. The passes below need the same settings per account, and
  // re-reading the network document per wallet would multiply one lookup by the batch size.
  const request: StakingSyncRequest = { ...input, config };
  const now = request.now ?? new Date();
  const runId = syncRunId(request.chainId, request.jobName, request.scheduledTime);

  const empty: StakingSyncResult = {
    runId,
    status: 'failed',
    phase: 'reconciling',
    accountsScanned: 0,
    accountsCreated: 0,
    operationsReconciled: 0,
    actionsStarted: 0,
    refusals: {},
    backlogCount: 0,
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

  const claim = await claimRun(runId, request, now);
  if (claim !== 'claimed') return { ...empty, status: 'completed', refusal: claim };

  const result: StakingSyncResult = { ...empty, status: 'running', refusal: null };

  try {
    await setPhase(runId, 'reconciling');
    result.operationsReconciled = await reconcilePass(request);

    // Before the refresh, so an account created now is refreshed by the same run instead of waiting
    // for tomorrow's. A wallet with no account is invisible to the refresh, which is why discovery
    // reads `users` rather than the accounts.
    await setPhase(runId, 'discovering');
    result.accountsCreated = await discoveryPass(request);

    await setPhase(runId, 'refreshing');
    const refreshed = await refreshPass(request, result);
    result.accountsScanned = refreshed.scanned;
    result.backlogCount = refreshed.backlog;
    result.status = refreshed.exhausted ? 'completed' : 'partial';
    result.phase = refreshed.exhausted ? 'done' : 'refreshing';

    await CardanoStakingSyncRun.updateOne(
      { _id: runId },
      {
        $set: {
          phase: result.phase,
          status: result.status,
          finishedAt: new Date(),
          lease: null,
          userCursor: refreshed.cursor,
          accountsScanned: result.accountsScanned,
          accountsCreated: result.accountsCreated,
          operationsReconciled: result.operationsReconciled,
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
    await CardanoStakingSyncRun.updateOne(
      { _id: runId },
      { $set: { status: 'failed', lease: null, lastError: detail, finishedAt: new Date() } }
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
 * @returns How many operations were examined.
 */
async function reconcilePass(request: StakingSyncRequest): Promise<number> {
  const live = await CardanoStakingOperation.find({
    chainId: request.chainId,
    status: { $in: ['signed', 'submitted', 'unknown_submit'] }
  })
    .limit(RECONCILE_LIMIT)
    .exec();

  if (live.length === 0) return 0;

  const tip = await request.provider.tip();
  let examined = 0;

  for (const operation of live) {
    try {
      await reconcileStakingOperation(
        operation,
        request.provider,
        tip.slot,
        DEFAULT_RECONCILIATION_POLICY
      );
      examined += 1;
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
}

/**
 * Observes accounts, decides what each needs, and acts when the run is allowed to.
 *
 * Paged by `_id` from the cursor the run carries, so an interrupted pass continues rather than
 * restarting — which is what keeps the tail of a large universe from never being reached.
 *
 * @param request - The run's request.
 * @param result - Accumulates what was started and what was refused.
 * @returns How far it got.
 */
async function refreshPass(
  request: StakingSyncRequest,
  result: StakingSyncResult
): Promise<RefreshOutcome> {
  const runId = syncRunId(request.chainId, request.jobName, request.scheduledTime);
  const stored = await CardanoStakingSyncRun.findById(runId).lean();
  const cursor = stored?.userCursor ?? null;

  const filter: Record<string, unknown> = { chainId: request.chainId };
  if (cursor !== null) filter._id = { $gt: cursor };

  const accounts = await CardanoStakingAccount.find(filter)
    .sort({ _id: 1 })
    .limit(request.batchLimit)
    .exec();

  let scanned = 0;
  let lastId: string | null = cursor;

  for (const account of accounts) {
    lastId = String(account._id);
    scanned += 1;
    try {
      await refreshAccount(account, request, result);
    } catch (error) {
      // Recorded on the account rather than raised. One unreadable wallet is not a reason to abandon
      // the rest of the universe, and the error is exactly the thing the next pass needs to see.
      const detail = error instanceof Error ? error.message : String(error);
      Logger.warn('runStakingSync', `Cardano staking account ${lastId} failed: ${detail}`);
      await CardanoStakingAccount.updateOne(
        { _id: account._id },
        { $set: { lastError: `sync:${detail}` } }
      );
    }

    // The checkpoint goes in as the pass goes, not at the end. A container that disappears here has
    // still recorded everything before this point.
    await CardanoStakingSyncRun.updateOne(
      { _id: runId },
      { $set: { userCursor: lastId, accountsScanned: scanned } }
    );
  }

  const exhausted = accounts.length < request.batchLimit;
  const remaining = exhausted
    ? 0
    : await CardanoStakingAccount.countDocuments({
        chainId: request.chainId,
        _id: { $gt: lastId }
      });

  const oldest = exhausted
    ? null
    : await CardanoStakingAccount.findOne({ chainId: request.chainId, _id: { $gt: lastId } })
        .sort({ lastSyncAt: 1 })
        .lean();

  return {
    scanned,
    // A pass that reached the end clears the cursor, so the next tick starts from the top rather
    // than from wherever the last account happened to be.
    cursor: exhausted ? null : lastId,
    exhausted,
    backlog: remaining,
    backlogOldestAt: oldest?.lastSyncAt ?? null
  };
}

/**
 * One account: read it, decide, and act if allowed.
 *
 * @param account - The account.
 * @param request - The run's request.
 * @param result - Accumulates what happened.
 */
async function refreshAccount(
  account: ICardanoStakingAccount,
  request: StakingSyncRequest,
  result: StakingSyncResult
): Promise<void> {
  const now = request.now ?? new Date();
  const observation = await observeStakingAccount(account, request.provider, now);

  await CardanoStakingAccount.updateOne({ _id: account._id }, { $set: { lastSyncAt: now } });

  if (observation.outcome !== 'observed') {
    count(result, `observe_${observation.reason ?? 'unavailable'}`);
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
  await writeState(
    account._id as Types.ObjectId,
    decision.refusal,
    (request.config ?? (await loadCardanoStakingConfig(request.chainId))).consentRequired
  );

  if (decision.action === 'none') {
    count(result, decision.refusal ?? 'nothing_to_do');
    return;
  }

  if (!request.execute) {
    count(result, `would_${decision.action}`);
    return;
  }

  const started = await startAction(account, user, decision.action, request);
  if (started === 'started') result.actionsStarted += 1;
  else count(result, started);

  await writeState(
    account._id as Types.ObjectId,
    decision.refusal,
    (request.config ?? (await loadCardanoStakingConfig(request.chainId))).consentRequired
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

  const parameters = await request.provider.stakingProtocolParameters();
  const signer = stakingSignerFor(subject, user);
  const utxos = signer.available
    ? await selectableStakingUtxos(await request.provider.utxosFor(subject.walletAddress))
    : [];
  const spendable = utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);

  return decideAutomaticAction(subject, {
    config,
    parameters,
    addressBytes: signer.available ? signer.material.user.addressBytes : new Uint8Array(),
    spendableLovelace: spendable,
    poolState: null,
    operationInFlight: await hasLiveOperation(subject._id as Types.ObjectId),
    signerAvailable: signer.available,
    sponsoredRegistrationsInWindow: await countSponsoredRegistrations(
      subject._id as Types.ObjectId,
      config.sponsorWindowDays
    )
  });
}

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

  const runId = syncRunId(request.chainId, request.jobName, request.scheduledTime);
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

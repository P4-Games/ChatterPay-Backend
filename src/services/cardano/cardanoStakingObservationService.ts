/**
 * Reading what the chain already says about a stake credential, and writing down only that.
 *
 * This runs before any decision and it is deliberately incapable of making one. Its whole job is to
 * turn a provider's answer into the account's `onChain` snapshot, a set of reward facts and a
 * governance history — and to do it in a way that is correct for the case the rest of the design
 * would otherwise get wrong: **a wallet that was already staking before ChatterPay looked at it.**
 *
 * On Cardano a stake credential belongs to the key. A user who delegated their wallet in a browser
 * wallet a year ago arrives here registered, delegated, with a deposit locked and rewards accrued,
 * and none of it was ChatterPay's doing. Three things follow, and each of them is a rule this module
 * enforces rather than a case it happens to handle:
 *
 * - **It is not re-registered.** The ledger refuses a second registration for a live credential, so
 *   the only thing a retry buys is a sponsor fee spent to learn what a read would have said.
 * - **No deposit event is invented.** `cardano_staking_deposit_events` records deposits ChatterPay
 *   moved. Writing a row for a deposit somebody else paid would put a payment in the ledger of this
 *   service that never passed through it.
 * - **The deposit figure is read, not assumed.** An exit has to refund exactly what was locked, and
 *   that is not necessarily today's protocol parameter. Where the provider reports the figure it is
 *   recorded; where it does not, it stays `null`, and an exit is blocked rather than built on a
 *   guess that would fail to balance after a fee had been spent.
 *
 * **Nothing here writes a zero it did not read.** A provider that fails leaves the previous snapshot
 * exactly where it was and `asOf` untouched, because a stale figure that is visibly stale is worth
 * more than a fresh-looking zero — and `asOf` is what every economic guard downstream checks.
 */

import type { Types } from 'mongoose';

import { Logger } from '../../helpers/loggerHelper';
import CardanoStakingAccount, {
  type CardanoGovernanceDelegation,
  type ICardanoStakingAccount
} from '../../models/cardanoStakingAccountModel';
import CardanoStakingGovernanceEvent from '../../models/cardanoStakingGovernanceEventModel';
import CardanoStakingOperation from '../../models/cardanoStakingOperationModel';
import CardanoStakingReward from '../../models/cardanoStakingRewardModel';
import { sameDRep } from './cardanoDRepIdService';
import { CardanoProviderError } from './cardanoProviderService';
import {
  type CardanoStakeAccountState,
  type CardanoStakingProvider,
  depositInForce
} from './cardanoStakingProviderService';

/** What an observation established. */
export type StakingObservationOutcome =
  /** The chain answered and the snapshot was updated. */
  | 'observed'
  /** The provider could not answer. Nothing was written and the old snapshot stands. */
  | 'unavailable';

export interface StakingObservation {
  outcome: StakingObservationOutcome;
  /** Why it failed, when it did. */
  reason: string | null;
  /** Reward credits written for the first time by this pass. */
  newRewardCredits: number;
  /** Whether this pass concluded the credential was registered by someone other than ChatterPay. */
  externallyRegistered: boolean;
  /** The state as read, absent when the provider could not answer. */
  state: CardanoStakeAccountState | null;
}

/** What the observation needs from a provider. */
export type StakingObservationProvider = Pick<
  CardanoStakingProvider,
  'stakeAccount' | 'rewardHistory' | 'registrationHistory'
>;

/**
 * Reads one credential's chain state and records it.
 *
 * Idempotent. Running it twice writes the same snapshot and inserts no reward twice: credits are
 * keyed by epoch and source, so a re-read of the same epoch collides with the row already there.
 *
 * @param account - The account to observe.
 * @param provider - Where to read.
 * @param now - Observation time, stamped on the snapshot.
 * @returns What was established.
 */
export async function observeStakingAccount(
  account: ICardanoStakingAccount,
  provider: StakingObservationProvider,
  now: Date = new Date()
): Promise<StakingObservation> {
  const accountId = account._id as Types.ObjectId;

  let state: CardanoStakeAccountState;
  try {
    state = await provider.stakeAccount(account.rewardAddress);
  } catch (error) {
    // The snapshot and its `asOf` are left exactly as they were. Every economic guard downstream
    // reads `asOf`, so leaving it alone is what keeps a failed read from looking like a fresh one.
    const reason = error instanceof CardanoProviderError ? error.failure : 'read_failed';
    Logger.warn(
      'observeStakingAccount',
      `Cardano stake account ${account.rewardAddress} could not be read: ${reason}`
    );
    await CardanoStakingAccount.updateOne(
      { _id: accountId },
      { $set: { lastError: `observe:${reason}` } }
    );
    return {
      outcome: 'unavailable',
      reason,
      newRewardCredits: 0,
      externallyRegistered: false,
      state: null
    };
  }

  const depositLovelace = await resolveDeposit(account, state, provider);
  const registrationOrigin = await resolveOrigin(account, state);
  const rewards = await recordRewards(account, provider);

  await CardanoStakingAccount.updateOne(
    { _id: accountId },
    {
      $set: {
        'onChain.registered': state.registered,
        'onChain.poolId': state.poolId,
        'onChain.governanceDelegation': state.governanceDelegation,
        'onChain.depositLovelace': depositLovelace === null ? null : String(depositLovelace),
        'onChain.registrationOrigin': registrationOrigin,
        'onChain.withdrawableRewardsLovelace': String(state.withdrawableRewardsLovelace),
        'onChain.lifetimeRewardsLovelace':
          state.lifetimeRewardsLovelace === null ? '0' : String(state.lifetimeRewardsLovelace),
        'onChain.historicalCompleteness': rewards.completeness,
        // Written last in this object and only on a read that succeeded: this is the field that
        // tells every economic path the snapshot is real.
        'onChain.asOf': now,
        lastObservedAt: now,
        lastError: null
      }
    }
  );

  await recordGovernanceChange(account, state.governanceDelegation, now);

  return {
    outcome: 'observed',
    reason: null,
    newRewardCredits: rewards.inserted,
    externallyRegistered: registrationOrigin === 'external',
    state
  };
}

/**
 * The deposit currently locked for a credential.
 *
 * Three sources, in the order of how much they are worth. A figure this backend recorded on its own
 * confirmed registration is best: it is what this service actually paid. Next is the provider's own
 * account figure, where the dialect reports one. Last is the registration history, which is the only
 * source that exists for a credential registered elsewhere on a provider that does not report a
 * deposit on the account itself.
 *
 * A previously recorded figure is never overwritten with `null`. Losing it would turn an account
 * that can exit into one that cannot, on the strength of a provider that simply stopped reporting.
 *
 * @param account - The account.
 * @param state - What the provider said about it.
 * @param provider - Where to read the registration history, if it comes to that.
 * @returns The deposit in lovelace, or `null` when nothing established one.
 */
async function resolveDeposit(
  account: ICardanoStakingAccount,
  state: CardanoStakeAccountState,
  provider: StakingObservationProvider
): Promise<bigint | null> {
  // Not registered means nothing is locked, and that is a fact rather than an absence: the figure
  // is cleared so a later exit cannot read a deposit from a registration that has already ended.
  if (!state.registered) return null;

  if (state.depositLovelace !== null) return state.depositLovelace;

  const recorded = account.onChain?.depositLovelace;
  if (recorded !== null && recorded !== undefined && recorded !== '') return BigInt(recorded);

  const confirmed = await CardanoStakingOperation.findOne({
    accountId: account._id,
    kind: 'register_and_delegate',
    chainOutcome: 'confirmed',
    actualRegistrationDepositLovelace: { $ne: null }
  })
    .sort({ createdAt: -1 })
    .select('actualRegistrationDepositLovelace');
  if (confirmed?.actualRegistrationDepositLovelace) {
    return BigInt(confirmed.actualRegistrationDepositLovelace);
  }

  try {
    return depositInForce(await provider.registrationHistory(account.rewardAddress));
  } catch (error) {
    // A history that cannot be read leaves the deposit unknown, which blocks an exit. That is the
    // intended outcome: an exit built on a guessed refund does not balance and is refused by the
    // ledger after a fee has already been spent.
    Logger.warn(
      'observeStakingAccount',
      `Cardano registration history for ${account.rewardAddress} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

/**
 * Who registered the credential.
 *
 * Decided from this service's own record rather than from anything the chain says, because the chain
 * does not record who asked. A confirmed registration operation of ours is the only evidence that
 * ChatterPay did it; a credential registered on chain without one was registered by the user, in
 * some other wallet, at some other time.
 *
 * Once decided, it is not revised on later passes. The question is about a past event and the
 * answer does not change; re-deciding it every sync would let a temporarily unreadable operation
 * history reattribute a user's deposit.
 *
 * @param account - The account.
 * @param state - What the provider said about it.
 * @returns The origin.
 */
async function resolveOrigin(
  account: ICardanoStakingAccount,
  state: CardanoStakeAccountState
): Promise<ICardanoStakingAccount['onChain']['registrationOrigin']> {
  const known = account.onChain?.registrationOrigin;
  if (known === 'chatterpay' || known === 'external') return known;
  if (!state.registered) return 'unknown';

  const ours = await CardanoStakingOperation.exists({
    accountId: account._id,
    kind: 'register_and_delegate',
    chainOutcome: 'confirmed'
  });
  return ours === null ? 'external' : 'chatterpay';
}

/**
 * Writes down every reward credit the chain has for this credential.
 *
 * Append-only and keyed, so a re-read inserts nothing. The insert is attempted per credit rather
 * than filtered against what is already stored: the unique index is the thing that decides, and
 * reading first would leave a window in which two syncs both decide a credit is new.
 *
 * @param account - The account.
 * @param provider - Where to read.
 * @returns How many were new, and whether the history could be read whole.
 */
async function recordRewards(
  account: ICardanoStakingAccount,
  provider: StakingObservationProvider
): Promise<{ inserted: number; completeness: 'complete' | 'partial' }> {
  let history: Awaited<ReturnType<StakingObservationProvider['rewardHistory']>>;
  try {
    history = await provider.rewardHistory(account.rewardAddress);
  } catch (error) {
    Logger.warn(
      'observeStakingAccount',
      `Cardano reward history for ${account.rewardAddress} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    // Unreadable history is `partial` rather than an error: the withdrawable balance comes from the
    // account snapshot and is unaffected, and what is lost is only the record of what was earned.
    return { inserted: 0, completeness: 'partial' };
  }

  let inserted = 0;
  for (const credit of history.credits) {
    try {
      await CardanoStakingReward.create({
        accountId: account._id,
        chainId: account.chainId,
        epoch: credit.epoch,
        amountLovelace: String(credit.amountLovelace),
        sourceKey: credit.sourceKey,
        sourceType: credit.sourceType
      });
      inserted += 1;
    } catch {
      // Duplicate key: this credit is already on file. The ordinary outcome of every pass after the
      // first, and the reason lifetime earnings do not drift upward every time the sweep runs.
    }
  }
  return { inserted, completeness: history.completeness };
}

/**
 * Records a vote delegation that has changed since the last look.
 *
 * Compared by canonical identity rather than by text, because the same DRep is spelled differently
 * by different providers and a text comparison would log a change on every single sync.
 *
 * Deduplicated against the latest stored event rather than against the snapshot alone. The snapshot
 * is written first, so comparing only against it would be enough — until a process dies between the
 * two writes, and the next pass sees a snapshot that already moved and an audit trail that never
 * learnt why. Reading the last event closes that window.
 *
 * @param account - The account, carrying the previous delegation.
 * @param current - What the chain says now.
 * @param now - Observation time.
 */
async function recordGovernanceChange(
  account: ICardanoStakingAccount,
  current: CardanoGovernanceDelegation,
  now: Date
): Promise<void> {
  const previous = account.onChain?.governanceDelegation ?? null;
  if (sameDelegation(previous, current)) return;

  const latest = await CardanoStakingGovernanceEvent.findOne({ accountId: account._id })
    .sort({ requestedAt: -1 })
    .select('kind drepIdCip129');
  if (
    latest !== null &&
    sameDelegation({ kind: latest.kind, idCip129: latest.drepIdCip129 ?? undefined }, current)
  ) {
    return;
  }

  await CardanoStakingGovernanceEvent.create({
    accountId: account._id,
    chainId: account.chainId,
    kind: current.kind,
    drepIdCip129: current.idCip129 ?? null,
    credential: current.credential ?? null,
    previousKind: previous?.kind ?? null,
    previousDrepIdCip129: previous?.idCip129 ?? null,
    // Observed rather than requested: this change was found on chain, and whoever made it did not
    // do so through this service. The audit trail says so rather than attributing it to a user.
    actor: 'chain',
    // No operation produced it, and borrowing an id to satisfy a column would make the trail claim
    // otherwise.
    operationId: null,
    requestedAt: now,
    confirmedAt: now
  });
}

/**
 * Whether two delegations say the same thing.
 *
 * @param left - One delegation, or nothing at all.
 * @param right - The other.
 * @returns `true` when they name the same kind and, for a DRep, the same credential.
 */
function sameDelegation(
  left: { kind?: string; idCip129?: string | null } | null,
  right: CardanoGovernanceDelegation
): boolean {
  if (left === null || left.kind !== right.kind) return false;
  if (right.kind !== 'drep') return true;
  return sameDRep(left.idCip129 ?? null, right.idCip129 ?? null);
}

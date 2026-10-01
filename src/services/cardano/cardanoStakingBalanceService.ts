/**
 * What a staked wallet is worth, assembled from the three places the ada actually is.
 *
 * Once a credential is registered, "the balance" stops being one number the provider hands over. The
 * ada is in three places at once and they behave differently:
 *
 * - **In outputs.** Spendable now, and what every existing balance path already reports.
 * - **In the registration deposit.** Locked in the ledger, not in any output, and refundable in full
 *   to whoever deregisters the credential. Under Plan B that is the user, so it is theirs and it
 *   counts — leaving it out would show a user who staked five ada a balance of three and look like
 *   money that went missing.
 * - **In the reward account.** Withdrawable now, but not in an output and not spendable until a
 *   withdrawal transaction lands.
 *
 * A fourth figure exists and is deliberately **not** counted: rewards that have been calculated for
 * the current epoch but not yet distributed. They are not withdrawable, they can still change, and
 * adding them would report money the user cannot touch as money they have.
 *
 * The part that matters more than the arithmetic is what happens when a read fails. Every existing
 * balance path in this repository answers a provider failure with zeroes, because a dashboard that
 * throws takes the whole wallet view down. That trade is defensible for a display and indefensible
 * here: an economic decision taken on a zero that means "we could not ask" will conclude the wallet
 * is empty, refuse an enrolment that should have happened, or — worse — read a staked position as
 * unstaked. So this resolver has no zero-shaped failure. It returns `unavailable`, carries no
 * amounts at all in that case, and every consumer has to say what it does about that.
 */

import { Logger } from '../../helpers/loggerHelper';
import type { ICardanoStakingAccount } from '../../models/cardanoStakingAccountModel';
import type { CardanoProvider } from './cardanoProviderService';
import { logCardanoProviderError } from './cardanoProviderService';
import { selectableBalance } from './cardanoTxService';

/**
 * How old the staking snapshot may be before its figures stop being usable for a decision.
 *
 * The sweep runs daily, so anything inside a day is the normal state of affairs. Past that, the
 * deposit and the reward balance are old enough that something should have refreshed them and did
 * not, which is a different situation from "read a moment ago" even though the numbers look alike.
 */
const SNAPSHOT_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

/** Why a balance is not `complete`. */
export type CardanoStakingBalanceReason =
  /** The chain could not be read. No figure here would mean anything. */
  | 'provider_unavailable'
  /** The credential has never been read, so its staking figures do not exist yet. */
  | 'never_observed'
  /** The snapshot is old enough that something should have refreshed it. */
  | 'snapshot_stale';

/** The ada, split by where it is. Every figure in lovelace. */
export interface CardanoStakingBalanceAmounts {
  /** Ada in outputs, all of it. */
  utxoLovelace: bigint;
  /** Ada in outputs this wallet can actually reach: unclaimed, and not pinned behind tokens. */
  spendableLovelace: bigint;
  /**
   * The registration deposit, when it is the user's to get back.
   *
   * Zero for an unregistered credential, and zero when the deposit is owned by the sponsor — in
   * which case it is not part of the user's net worth even though it is on chain against their
   * credential.
   */
  userOwnedRefundableDepositLovelace: bigint;
  /** Sitting in the reward account and withdrawable now. */
  withdrawableRewardsLovelace: bigint;
  /**
   * Calculated for the current epoch and not yet distributed.
   *
   * Reported so it can be shown as what it is, and **not** included in {@link totalAdaLovelace}.
   */
  pendingRewardsLovelace: bigint;
  /** The three counted parts, summed. */
  totalAdaLovelace: bigint;
  /** When the staking half of this was read. */
  asOf: Date | null;
}

export type CardanoStakingBalance =
  | ({
      availability: 'complete';
      reason: null;
      /** Whether an economic decision may be taken on these figures. */
      economicallyUsable: true;
    } & CardanoStakingBalanceAmounts)
  | ({
      availability: 'stale';
      reason: CardanoStakingBalanceReason;
      economicallyUsable: false;
    } & CardanoStakingBalanceAmounts)
  | {
      /**
       * Nothing is known. Carries no amounts at all, on purpose.
       *
       * A zero in this position reads as "the wallet is empty" to every consumer that does not check
       * the availability, and that is the reading that turns an outage into a wrong decision. There
       * is nothing here to misread.
       */
      availability: 'unavailable';
      reason: CardanoStakingBalanceReason;
      economicallyUsable: false;
    };

/** What the resolver reads from. */
export type StakingBalanceProvider = Pick<CardanoProvider, 'utxosFor'>;

/**
 * The ada a staked wallet holds, across outputs, deposit and rewards.
 *
 * @param account - The staking account, carrying the last confirmed snapshot. `null` for a wallet
 *   with no staking account at all, which is the ordinary case and not an error: the wallet's ada is
 *   entirely in its outputs.
 * @param address - The base address whose outputs to read.
 * @param provider - Where to read the outputs.
 * @param now - The clock, injectable for tests.
 * @returns The balance, or `unavailable` when the outputs could not be read.
 */
export async function resolveStakingBalance(
  account: ICardanoStakingAccount | null,
  address: string,
  provider: StakingBalanceProvider,
  now: Date = new Date()
): Promise<CardanoStakingBalance> {
  let utxoLovelace: bigint;
  let spendableLovelace: bigint;
  try {
    const utxos = await provider.utxosFor(address);
    utxoLovelace = utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
    spendableLovelace = selectableBalance(utxos);
  } catch (error) {
    logCardanoProviderError('resolveStakingBalance', error);
    // Deliberately not zeroes. See the note at the top of this file.
    Logger.warn(
      'resolveStakingBalance',
      `Cardano balance for ${address} is unavailable; no figure is being reported`
    );
    return {
      availability: 'unavailable',
      reason: 'provider_unavailable',
      economicallyUsable: false
    };
  }

  // No staking account: every lovelace this wallet has is in its outputs, and that is complete rather
  // than unknown. The deposit and rewards are zero because there is no credential registered, not
  // because a read failed.
  if (account === null) {
    return complete({
      utxoLovelace,
      spendableLovelace,
      userOwnedRefundableDepositLovelace: 0n,
      withdrawableRewardsLovelace: 0n,
      pendingRewardsLovelace: 0n,
      asOf: null
    });
  }

  const onChain = account.onChain;

  // Never read: the outputs are known and the staking half is not. Reporting the outputs alone as a
  // total would understate a position that may well be registered, so the amounts are carried and the
  // availability says not to decide on them.
  if (onChain.asOf === null) {
    return degraded('never_observed', {
      utxoLovelace,
      spendableLovelace,
      userOwnedRefundableDepositLovelace: 0n,
      withdrawableRewardsLovelace: 0n,
      pendingRewardsLovelace: 0n,
      asOf: null
    });
  }

  const amounts = {
    utxoLovelace,
    spendableLovelace,
    userOwnedRefundableDepositLovelace: refundableDeposit(account),
    withdrawableRewardsLovelace: BigInt(onChain.withdrawableRewardsLovelace),
    pendingRewardsLovelace: BigInt(onChain.pendingRewardsLovelace),
    asOf: onChain.asOf
  };

  const age = now.getTime() - onChain.asOf.getTime();
  return age > SNAPSHOT_STALE_AFTER_MS ? degraded('snapshot_stale', amounts) : complete(amounts);
}

/**
 * The deposit that is the user's to reclaim, in lovelace.
 *
 * Three conditions, and all of them have to hold. The credential has to be registered — an
 * unregistered one has no deposit standing against it. The figure has to be known — `null` means the
 * provider could not report what was paid, and a guess here would inflate a net worth. And the
 * deposit has to be economically the user's: under Plan B it always is, but the field exists because
 * a sponsor-financed cycle would put the same lovelace on chain against the same credential while
 * belonging to somebody else.
 *
 * @param account - The account.
 * @returns The refundable deposit, or zero.
 */
function refundableDeposit(account: ICardanoStakingAccount): bigint {
  if (!account.onChain.registered) return 0n;
  if (account.depositEconomicOwner !== 'user') return 0n;
  const recorded = account.onChain.depositLovelace;
  return recorded === null ? 0n : BigInt(recorded);
}

/**
 * A balance good enough to act on.
 *
 * @param amounts - The figures, without the total.
 * @returns The balance.
 */
function complete(
  amounts: Omit<CardanoStakingBalanceAmounts, 'totalAdaLovelace'>
): CardanoStakingBalance {
  return {
    availability: 'complete',
    reason: null,
    economicallyUsable: true,
    ...amounts,
    totalAdaLovelace: total(amounts)
  };
}

/**
 * A balance worth showing and not worth deciding on.
 *
 * @param reason - Why.
 * @param amounts - The figures, without the total.
 * @returns The balance.
 */
function degraded(
  reason: CardanoStakingBalanceReason,
  amounts: Omit<CardanoStakingBalanceAmounts, 'totalAdaLovelace'>
): CardanoStakingBalance {
  return {
    availability: 'stale',
    reason,
    economicallyUsable: false,
    ...amounts,
    totalAdaLovelace: total(amounts)
  };
}

/**
 * The three counted parts, summed.
 *
 * Pending rewards are absent from this on purpose: they are not withdrawable and they can still
 * change, so counting them would report money the user cannot touch.
 *
 * @param amounts - The figures.
 * @returns The total, in lovelace.
 */
function total(amounts: Omit<CardanoStakingBalanceAmounts, 'totalAdaLovelace'>): bigint {
  return (
    amounts.utxoLovelace +
    amounts.userOwnedRefundableDepositLovelace +
    amounts.withdrawableRewardsLovelace
  );
}

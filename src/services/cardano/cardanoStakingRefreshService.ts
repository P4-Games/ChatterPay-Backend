/**
 * Marking a staking account as due for a refresh, from something this backend saw happen.
 *
 * The sweep reads accounts by when they are due. A transfer this backend moved, or an operation that
 * settled, is evidence that an account changed, and waiting out its cadence would leave the snapshot
 * stale for hours. This module makes such an account due now.
 *
 * It only ever schedules a read. It writes nothing about consent, opt-out, eligibility or state, so
 * no signal routed through here can put a wallet back into staking: whatever the sweep then decides
 * is decided by the same guards as any other pass.
 *
 * The absence of a request says nothing. A deposit from outside ChatterPay produces no signal here,
 * which is why every account keeps its periodic check regardless.
 */

import type { Types } from 'mongoose';

import { Logger } from '../../helpers/loggerHelper';
import CardanoStakingAccount from '../../models/cardanoStakingAccountModel';

/** Why an account was marked. Stored verbatim. */
export type StakingRefreshReason =
  | 'transfer_in'
  | 'transfer_out'
  | 'operation_confirmed'
  | 'operation_settled';

/** Which accounts to mark: by id, or by the base address the account was created for. */
export type StakingRefreshTarget =
  | { accountIds: readonly Types.ObjectId[] }
  | { chainId: number; walletAddresses: readonly string[] };

/**
 * Makes the targeted accounts due at `now + delayMs`.
 *
 * `refreshRequestedAt` records the moment from which a read reflects the change — later than `now`
 * for a transfer that was only just submitted and has not reached a block. The sweep does not clear
 * it with an observation taken before that moment, and schedules the next check no later than it,
 * so a read that happens to run in between cannot absorb the request and push the account out by a
 * whole cadence. Of several requests the latest such moment is kept, and the earliest due time.
 *
 * Idempotent and cheap: one `updateMany`, no provider call. Failure is logged and swallowed by
 * {@link requestStakingRefreshQuietly}, never by this function.
 *
 * @param target - The accounts.
 * @param reason - Why.
 * @param now - The clock.
 * @param delayMs - How long after `now` the change can be read on chain.
 * @returns How many accounts were marked.
 */
export async function requestStakingRefresh(
  target: StakingRefreshTarget,
  reason: StakingRefreshReason,
  now: Date = new Date(),
  delayMs = 0
): Promise<number> {
  if ('accountIds' in target && target.accountIds.length === 0) return 0;
  if ('walletAddresses' in target && target.walletAddresses.length === 0) return 0;
  const filter =
    'accountIds' in target
      ? { _id: { $in: [...target.accountIds] } }
      : { chainId: target.chainId, walletAddress: { $in: [...target.walletAddresses] } };
  const dueAt = new Date(now.getTime() + delayMs);

  const updated = await CardanoStakingAccount.updateMany(filter, [
    {
      $set: {
        refreshReason: reason,
        refreshRequestedAt: {
          $max: [{ $ifNull: ['$refreshRequestedAt', dueAt] }, dueAt]
        },
        // `null` already means due now and is left alone; a later due time is brought forward.
        nextEligibleCheckAt: {
          $cond: [
            { $eq: [{ $ifNull: ['$nextEligibleCheckAt', null] }, null] },
            null,
            { $min: ['$nextEligibleCheckAt', dueAt] }
          ]
        }
      }
    }
  ]);
  return updated.modifiedCount;
}

/**
 * {@link requestStakingRefresh} for a caller whose own work must not fail because of it.
 *
 * A transfer that went through is not undone because the staking snapshot could not be marked; the
 * account is still read on its own cadence.
 *
 * @param target - The accounts.
 * @param reason - Why.
 * @param now - The clock.
 * @param delayMs - How long after `now` the change can be read on chain.
 */
export async function requestStakingRefreshQuietly(
  target: StakingRefreshTarget,
  reason: StakingRefreshReason,
  now: Date = new Date(),
  delayMs = 0
): Promise<void> {
  try {
    await requestStakingRefresh(target, reason, now, delayMs);
  } catch (error) {
    Logger.warn(
      'requestStakingRefreshQuietly',
      `Could not mark Cardano staking accounts for refresh (${reason}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

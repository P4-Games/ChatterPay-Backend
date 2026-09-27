/**
 * The sponsor's staking fee budget: reserving it, settling it, and giving it back.
 *
 * Under Plan B the user funds the registration deposit and ChatterPay pays only the network fees of
 * staking itself. This module is the whole authorisation path for that spending. Nothing else may
 * decide that an operation can afford its fee.
 *
 * **Why it is written the way it is.** Mongo here is standalone and the codebase uses no
 * transactions, so there are two hazards and each one needs its own answer:
 *
 * 1. *Two instances spending the same room.* Aggregating the ledger and then writing would let both
 *    read a window with room and both proceed. The answer is that the check and the increment are a
 *    single conditional document update.
 * 2. *One instance spending the same room twice.* A process that dies between charging the window
 *    and writing what it charged it for comes back unable to tell whether its own charge landed.
 *    Retrying the atomic update would charge it again. The answer is that every change to the
 *    counter is a compare-and-swap on that operation's own entry in `operationCharges`, in the
 *    same update: a repeat finds an entry it no longer matches and does nothing.
 *
 * The order inside {@link reserveStakingFee} follows from the same reasoning. The counter is
 * charged first and the audit entry written second, so a crash in between over-reserves - budget
 * held for an operation that may not exist - rather than under-reserving. The opposite order would
 * produce an audit trail claiming a spend the counter never authorised.
 *
 * A reservation is **never** released because an outcome looks bad. It is released only when the
 * operation carries proof that its transaction is not on the chain, which is the same rule the UTxO
 * claims already follow.
 */

import type { Types } from 'mongoose';

import { Logger } from '../../helpers/loggerHelper';
import CardanoStakingFeeBudget, {
  type ICardanoStakingFeeBudget
} from '../../models/cardanoStakingFeeBudgetModel';
import CardanoStakingOperation from '../../models/cardanoStakingOperationModel';
import CardanoStakingSponsorFeeEvent from '../../models/cardanoStakingSponsorFeeEventModel';

/** Mongo's duplicate-key error code. */
const DUPLICATE_KEY = 11000;

/** How a reservation attempt ended. */
export type StakingFeeReservationOutcome =
  /** The window was charged by this call. */
  | 'granted'
  /** This operation had already charged the window. The retry changed nothing, on purpose. */
  | 'already_reserved'
  /** The window has no room left. The operation must not be built. */
  | 'insufficient_budget'
  /** The configured cap is not a usable amount. Nothing is charged and nothing runs. */
  | 'invalid_cap';

/** How a settle or release attempt ended. */
export type StakingFeeSettlementOutcome =
  | 'applied'
  /** Already applied by an earlier call. */
  | 'already_applied'
  /** No reservation of this operation is outstanding in this window. */
  | 'not_reserved'
  /** The operation does not carry proof that its transaction never reached the chain. */
  | 'no_absence_proof';

export interface StakingFeeReservationRequest {
  chainId: number;
  /** Window key, `YYYY-MM-DD`. One window, one cap. */
  window: string;
  /** Ceiling for the window, in lovelace, as configured. Fixed when the window is first opened. */
  capLovelace: string;
  accountId: Types.ObjectId;
  operationId: Types.ObjectId;
  lifecycleId: string;
  /** Mirrors the operation's `kind`. */
  kind: string;
  /** Lovelace to hold for this operation. */
  amountLovelace: number;
}

export interface StakingFeeReservationResult {
  outcome: StakingFeeReservationOutcome;
  windowId: string;
  /** The window's reserved total after the call, or `null` when nothing could be read. */
  reservedLovelace: number | null;
}

export interface StakingFeeSettlementResult {
  outcome: StakingFeeSettlementOutcome;
  windowId: string;
  reservedLovelace: number | null;
  confirmedLovelace: number | null;
}

/**
 * The `_id` of a budget window.
 *
 * Derived rather than stored so that two callers cannot disagree about which document a window is,
 * which would be two counters and no cap.
 *
 * @param chainId - Internal Cardano chain id.
 * @param window - Window key, `YYYY-MM-DD`.
 * @returns The document id.
 */
export function budgetWindowId(chainId: number, window: string): string {
  return `${chainId}:${window}`;
}

/**
 * Reads a configured cap into the number the counter works in.
 *
 * Lovelace fee budgets are tens of ada, far below the exact-integer limit of a double, so a number
 * is safe here in a way it is not for balances. A value that is not a plain non-negative integer is
 * refused rather than coerced: `NaN` compares false against every bound, which would turn a typo in
 * configuration into a window that grants nothing, silently.
 *
 * @param capLovelace - Cap as configured, a decimal string.
 * @returns The cap, or `null` when the string is not a usable amount.
 */
function readCap(capLovelace: string): number | null {
  if (!/^\d+$/.test(capLovelace)) return null;
  const cap = Number(capLovelace);
  return Number.isSafeInteger(cap) ? cap : null;
}

/**
 * Opens the window if it is not open yet, and returns it.
 *
 * The cap is written only on insert. A configuration change therefore takes effect on the next
 * window rather than raising the ceiling of one that is already being spent — a cap that moves
 * under the operations charging against it is not a cap.
 *
 * @param chainId - Internal Cardano chain id.
 * @param window - Window key.
 * @param capLovelace - Cap to give the window if this call is the one that opens it.
 * @returns The window document.
 */
async function openWindow(
  chainId: number,
  window: string,
  capLovelace: string
): Promise<ICardanoStakingFeeBudget> {
  const windowId = budgetWindowId(chainId, window);

  const budget = await CardanoStakingFeeBudget.findOneAndUpdate(
    { _id: windowId },
    { $setOnInsert: { chainId, window, capLovelace } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  if (budget.capLovelace !== capLovelace) {
    Logger.warn(
      'openWindow',
      `Cardano staking fee window ${windowId} holds cap ${budget.capLovelace} while configuration says ${capLovelace}; the window keeps its own`
    );
  }

  return budget;
}

/**
 * Holds part of a window's budget for one operation.
 *
 * Safe to call again with the same `operationId`: the second call reports `already_reserved` and
 * charges nothing. That is what makes it safe to call *before* the operation document exists, which
 * is the order the caller needs — budget first, then build.
 *
 * @param request - What to hold, for which operation, against which window.
 * @returns The outcome and the window's reserved total after the call.
 */
export async function reserveStakingFee(
  request: StakingFeeReservationRequest
): Promise<StakingFeeReservationResult> {
  const { chainId, window, capLovelace, operationId, amountLovelace } = request;
  const windowId = budgetWindowId(chainId, window);
  const key = operationId.toHexString();

  const budget = await openWindow(chainId, window, capLovelace);
  const cap = readCap(budget.capLovelace);
  if (cap === null) {
    Logger.error(
      'reserveStakingFee',
      `Cardano staking fee window ${windowId} has an unusable cap: ${budget.capLovelace}`
    );
    return { outcome: 'invalid_cap', windowId, reservedLovelace: null };
  }

  // One update: the operation has not charged this window yet, and what it wants still fits. Both
  // conditions and both effects, or neither.
  const charged = await CardanoStakingFeeBudget.findOneAndUpdate(
    {
      _id: windowId,
      [`operationCharges.${key}`]: { $exists: false },
      reservedLovelace: { $lte: cap - amountLovelace }
    },
    {
      $inc: { reservedLovelace: amountLovelace },
      $set: {
        [`operationCharges.${key}`]: { lovelace: amountLovelace, state: 'reserved' },
        updatedAt: new Date()
      }
    },
    { new: true }
  );

  if (charged === null) {
    // Either there was no room or this operation had already charged the window. Telling them apart
    // needs a read, and only on this path: an operation that is refused for lack of budget is a
    // product decision, while one that was already charged is a retry that must be allowed to
    // continue.
    const current = await CardanoStakingFeeBudget.findById(windowId);
    const alreadyReserved = current?.operationCharges?.get(key) !== undefined;
    return {
      outcome: alreadyReserved ? 'already_reserved' : 'insufficient_budget',
      windowId,
      reservedLovelace: current?.reservedLovelace ?? null
    };
  }

  await writeAuditEntry(request, windowId);

  return { outcome: 'granted', windowId, reservedLovelace: charged.reservedLovelace };
}

/**
 * Records what the window was charged for, for auditing.
 *
 * Deliberately after the charge and deliberately non-fatal. This collection authorises nothing, so
 * failing to write it must not undo a reservation that is already holding room; the reconciliation
 * between the ledger and the counter is what surfaces the gap.
 *
 * @param request - The same reservation request.
 * @param windowId - Window the fee was charged against.
 */
async function writeAuditEntry(
  request: StakingFeeReservationRequest,
  windowId: string
): Promise<void> {
  try {
    await CardanoStakingSponsorFeeEvent.create({
      chainId: request.chainId,
      accountId: request.accountId,
      operationId: request.operationId,
      lifecycleId: request.lifecycleId,
      kind: request.kind,
      amountLovelace: String(request.amountLovelace),
      budgetWindow: windowId
    });
  } catch (error) {
    // A duplicate is the expected shape of a retry finishing what an earlier call started.
    if ((error as { code?: number }).code === DUPLICATE_KEY) return;
    Logger.error(
      'writeAuditEntry',
      `Cardano staking fee reserved on ${windowId} for operation ${request.operationId.toHexString()} but not recorded:`,
      error
    );
  }
}

/**
 * Moves a reservation to what was actually spent.
 *
 * The difference goes back to the window in the same update that records the spend, so a fee that
 * came in under the estimate stops holding room the moment it is known.
 *
 * @param chainId - Internal Cardano chain id.
 * @param window - Window key.
 * @param operationId - Operation whose reservation is being settled.
 * @param actualLovelace - Network fee the confirmed transaction actually paid.
 * @param txId - Transaction the fee was paid by, for the audit entry.
 * @returns The outcome and the window's totals after the call.
 */
export async function settleStakingFee(
  chainId: number,
  window: string,
  operationId: Types.ObjectId,
  actualLovelace: number,
  txId: string | null = null
): Promise<StakingFeeSettlementResult> {
  const windowId = budgetWindowId(chainId, window);
  const key = operationId.toHexString();

  const current = await CardanoStakingFeeBudget.findById(windowId);
  const charge = current?.operationCharges?.get(key);
  if (charge === undefined) {
    return {
      outcome: 'not_reserved',
      windowId,
      reservedLovelace: current?.reservedLovelace ?? null,
      confirmedLovelace: current?.confirmedLovelace ?? null
    };
  }
  if (charge.state === 'settled') {
    return {
      outcome: 'already_applied',
      windowId,
      reservedLovelace: current?.reservedLovelace ?? null,
      confirmedLovelace: current?.confirmedLovelace ?? null
    };
  }

  // Conditioned on the entry still being the reserved one, state included. Conditioning on the
  // amount alone looks equivalent until a fee settles for exactly what was reserved: the entry
  // would still match and a repeated settle would add the same lovelace to the confirmed total a
  // second time.
  const settled = await CardanoStakingFeeBudget.findOneAndUpdate(
    {
      _id: windowId,
      [`operationCharges.${key}.state`]: 'reserved',
      [`operationCharges.${key}.lovelace`]: charge.lovelace
    },
    {
      $inc: {
        reservedLovelace: actualLovelace - charge.lovelace,
        confirmedLovelace: actualLovelace
      },
      $set: {
        [`operationCharges.${key}`]: { lovelace: actualLovelace, state: 'settled' },
        updatedAt: new Date()
      }
    },
    { new: true }
  );

  if (settled === null) {
    const after = await CardanoStakingFeeBudget.findById(windowId);
    return {
      outcome: 'already_applied',
      windowId,
      reservedLovelace: after?.reservedLovelace ?? null,
      confirmedLovelace: after?.confirmedLovelace ?? null
    };
  }

  await CardanoStakingSponsorFeeEvent.updateOne(
    { operationId },
    {
      $set: {
        status: 'confirmed',
        amountLovelace: String(actualLovelace),
        txId,
        confirmedAt: new Date()
      }
    }
  );

  return {
    outcome: 'applied',
    windowId,
    reservedLovelace: settled.reservedLovelace,
    confirmedLovelace: settled.confirmedLovelace
  };
}

/**
 * Gives a reservation back, and only on proof that its transaction never reached the chain.
 *
 * The proof is read from the operation rather than taken as an argument, so that the rule cannot be
 * satisfied by a caller asserting it. An operation whose outcome is merely `rejected`, or still
 * `unknown`, keeps its room: the budget would otherwise free lovelace that a transaction still in
 * flight is about to spend, and the window would authorise more than it has.
 *
 * @param chainId - Internal Cardano chain id.
 * @param window - Window key.
 * @param operationId - Operation whose reservation is being released.
 * @returns The outcome and the window's totals after the call.
 */
export async function releaseStakingFee(
  chainId: number,
  window: string,
  operationId: Types.ObjectId
): Promise<StakingFeeSettlementResult> {
  const windowId = budgetWindowId(chainId, window);
  const key = operationId.toHexString();

  const operation = await CardanoStakingOperation.findById(operationId).select('absenceProof');
  if (operation === null || operation.absenceProof === null) {
    const current = await CardanoStakingFeeBudget.findById(windowId);
    return {
      outcome: 'no_absence_proof',
      windowId,
      reservedLovelace: current?.reservedLovelace ?? null,
      confirmedLovelace: current?.confirmedLovelace ?? null
    };
  }

  const current = await CardanoStakingFeeBudget.findById(windowId);
  const charge = current?.operationCharges?.get(key);
  if (charge === undefined) {
    return {
      outcome: 'not_reserved',
      windowId,
      reservedLovelace: current?.reservedLovelace ?? null,
      confirmedLovelace: current?.confirmedLovelace ?? null
    };
  }
  if (charge.state === 'settled') {
    // A confirmed transaction paid this fee. There is nothing to give back, whatever the
    // operation says about itself afterwards.
    return {
      outcome: 'already_applied',
      windowId,
      reservedLovelace: current?.reservedLovelace ?? null,
      confirmedLovelace: current?.confirmedLovelace ?? null
    };
  }

  // The entry is removed rather than zeroed, so the window forgets an operation that provably never
  // happened. A later reservation for the same id would be a new attempt, which is legitimate.
  const released = await CardanoStakingFeeBudget.findOneAndUpdate(
    {
      _id: windowId,
      [`operationCharges.${key}.state`]: 'reserved',
      [`operationCharges.${key}.lovelace`]: charge.lovelace
    },
    {
      $inc: { reservedLovelace: -charge.lovelace },
      $unset: { [`operationCharges.${key}`]: '' },
      $set: { updatedAt: new Date() }
    },
    { new: true }
  );

  if (released === null) {
    const after = await CardanoStakingFeeBudget.findById(windowId);
    return {
      outcome: 'already_applied',
      windowId,
      reservedLovelace: after?.reservedLovelace ?? null,
      confirmedLovelace: after?.confirmedLovelace ?? null
    };
  }

  await CardanoStakingSponsorFeeEvent.updateOne({ operationId }, { $set: { status: 'released' } });

  return {
    outcome: 'applied',
    windowId,
    reservedLovelace: released.reservedLovelace,
    confirmedLovelace: released.confirmedLovelace
  };
}

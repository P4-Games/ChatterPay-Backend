import { type Document, model, Schema } from 'mongoose';

/**
 * The sponsor's fee budget for one window, and the only thing that authorises spending it.
 *
 * **This is a counter, not a ledger.** Deciding by aggregating
 * `cardano_staking_sponsor_fee_events` would read a total and then write, and two Cloud Run
 * instances doing that concurrently both see room and both proceed. Mongo here is standalone and
 * the codebase uses no transactions, so the reservation is a single conditional
 * `findOneAndUpdate`: the check and the increment happen in one atomic document update.
 *
 *     findOneAndUpdate(
 *       { _id: windowId, reservedLovelace: { $lte: capMinusAmount } },
 *       { $inc: { reservedLovelace: amount } }
 *     )
 *
 * A `null` result means there was no room. Nothing else needs locking.
 *
 * The same update also carries the per-operation entry in `operationCharges`, and that is what
 * makes a reservation exactly-once rather than merely atomic. Without it, a process that dies
 * between incrementing the counter and writing the operation it was for leaves a retry unable to
 * tell whether its own reservation already landed, and the retry charges the window twice.
 *
 * Amounts are decimal strings everywhere else in this domain, but `$inc` only works on numbers, so
 * these two are stored as numbers. Lovelace budgets are small enough — tens of ada, that is tens of
 * millions of lovelace — to sit far below the 2^53 exact-integer limit. `capLovelace` stays a
 * string because it is configuration, read and compared as `bigint` like every other setting.
 */
/** One operation's share of a window, and whether it is still only held. */
export interface CardanoStakingFeeCharge {
  lovelace: number;
  state: 'reserved' | 'settled';
}

const feeChargeSchema = new Schema<CardanoStakingFeeCharge>(
  {
    lovelace: { type: Number, required: true },
    state: { type: String, enum: ['reserved', 'settled'], required: true }
  },
  { _id: false }
);

export interface ICardanoStakingFeeBudget extends Document<string> {
  /** `<chainId>:<window>`, e.g. `900000000001:2026-09-22`. Its uniqueness is the lock. */
  _id: string;
  chainId: number;
  /** Window key, so a window can be found without parsing `_id`. */
  window: string;
  /** Ceiling for this window, in lovelace. Mirrors the network's configured budget. */
  capLovelace: string;
  /** Committed to operations that may still spend it. Never decremented on an uncertain outcome. */
  reservedLovelace: number;
  /** Actually spent, as transactions confirm. */
  confirmedLovelace: number;
  /**
   * What each operation currently accounts for in this window, keyed by operation id.
   *
   * Every change to the counter is conditioned on this entry and rewrites it in the same atomic
   * update, so a repeated reserve, settle or release finds an entry it no longer matches and
   * does nothing. This is the substitute for the transaction this deployment does not have.
   *
   * The state is carried alongside the amount rather than inferred from it, because a fee that
   * settles for exactly what was reserved is indistinguishable by amount alone -- and that case
   * would let a repeated settle add the same lovelace to `confirmedLovelace` twice.
   *
   * A released operation is removed; a settled one is kept, because keeping it is what stops a
   * second settle. The map is therefore bounded by the operations of a single window.
   */
  operationCharges: Map<string, CardanoStakingFeeCharge>;
  updatedAt: Date;
}

const cardanoStakingFeeBudgetSchema = new Schema<ICardanoStakingFeeBudget>(
  {
    _id: { type: String, required: true },
    chainId: { type: Number, required: true },
    window: { type: String, required: true },
    capLovelace: { type: String, required: true },
    reservedLovelace: { type: Number, required: true, default: 0 },
    confirmedLovelace: { type: Number, required: true, default: 0 },
    operationCharges: {
      type: Map,
      of: feeChargeSchema,
      required: true,
      default: () => new Map()
    },
    updatedAt: { type: Date, required: true, default: Date.now }
  },
  // The migration owns this collection's existence, not whichever process touches the model
  // first. Mongoose otherwise creates the collection and builds its indexes in the background
  // when the model is compiled, which is at import time: a read-only process would bring the
  // collection into being, and a dry run would leave exactly the trace it promises not to.
  { autoCreate: false, autoIndex: false, _id: false }
);

cardanoStakingFeeBudgetSchema.index({ chainId: 1, window: -1 }, { name: 'budget_windows' });

const CardanoStakingFeeBudget = model<ICardanoStakingFeeBudget>(
  'CardanoStakingFeeBudget',
  cardanoStakingFeeBudgetSchema,
  'cardano_staking_fee_budget'
);

export default CardanoStakingFeeBudget;

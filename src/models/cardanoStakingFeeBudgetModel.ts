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
 * Amounts are decimal strings everywhere else in this domain, but `$inc` only works on numbers, so
 * these two are stored as numbers. Lovelace budgets are small enough — tens of ada, that is tens of
 * millions of lovelace — to sit far below the 2^53 exact-integer limit. `capLovelace` stays a
 * string because it is configuration, read and compared as `bigint` like every other setting.
 */
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
    updatedAt: { type: Date, required: true, default: Date.now }
  },
  { _id: false }
);

cardanoStakingFeeBudgetSchema.index({ chainId: 1, window: -1 }, { name: 'budget_windows' });

const CardanoStakingFeeBudget = model<ICardanoStakingFeeBudget>(
  'CardanoStakingFeeBudget',
  cardanoStakingFeeBudgetSchema,
  'cardano_staking_fee_budget'
);

export default CardanoStakingFeeBudget;

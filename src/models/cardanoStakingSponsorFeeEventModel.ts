import { type Document, model, Schema, type Types } from 'mongoose';

/**
 * What ChatterPay actually spent on network fees, one entry per operation.
 *
 * **This does not authorise anything.** It is the record of what happened, for auditing and
 * reporting; the thing that decides whether an operation may spend is the atomic counter in
 * `cardano_staking_fee_budget`. Aggregating this collection to make that decision would not be
 * atomic and would reopen the race the counter exists to close. The two are reconciled
 * periodically, and a mismatch raises an alert rather than gating an operation.
 *
 * Nothing here belongs to the user: under Plan B the sponsor pays fees, and the registration
 * deposit is the user's own asset, tracked in `cardano_staking_deposit_events`. This is not the
 * retired `cardano_fee_debts`, which recorded what a *user* owed.
 */
export interface ICardanoStakingSponsorFeeEvent extends Document {
  chainId: number;
  accountId: Types.ObjectId;
  operationId: Types.ObjectId;
  lifecycleId: string;
  /** Which operation the fee was spent on, mirroring the operation's `kind`. */
  kind: string;
  /** Lovelace spent, decimal string. */
  amountLovelace: string;
  txId: string | null;
  /** `reserved` while in flight, `confirmed` once the transaction settles, `released` if it never landed. */
  status: 'reserved' | 'confirmed' | 'released';
  /** Budget window this was charged against, matching `cardano_staking_fee_budget._id`. */
  budgetWindow: string;
  confirmedAt: Date | null;
}

const cardanoStakingSponsorFeeEventSchema = new Schema<ICardanoStakingSponsorFeeEvent>(
  {
    chainId: { type: Number, required: true },
    accountId: { type: Schema.Types.ObjectId, required: true },
    operationId: { type: Schema.Types.ObjectId, required: true },
    lifecycleId: { type: String, required: true },
    kind: { type: String, required: true },
    amountLovelace: { type: String, required: true },
    txId: { type: String, required: false, default: null },
    status: {
      type: String,
      enum: ['reserved', 'confirmed', 'released'],
      required: true,
      default: 'reserved'
    },
    budgetWindow: { type: String, required: true },
    confirmedAt: { type: Date, required: false, default: null }
  },
  { timestamps: true }
);

// One entry per operation. A scheduler retry charges the budget once.
cardanoStakingSponsorFeeEventSchema.index(
  { operationId: 1 },
  { unique: true, name: 'operation_unique' }
);
cardanoStakingSponsorFeeEventSchema.index(
  { chainId: 1, confirmedAt: -1 },
  { name: 'budget_window' }
);
// Reconciling the counter against this record walks a window at a time.
cardanoStakingSponsorFeeEventSchema.index(
  { budgetWindow: 1, status: 1 },
  { name: 'budget_reconcile' }
);

const CardanoStakingSponsorFeeEvent = model<ICardanoStakingSponsorFeeEvent>(
  'CardanoStakingSponsorFeeEvent',
  cardanoStakingSponsorFeeEventSchema,
  'cardano_staking_sponsor_fee_events'
);

export default CardanoStakingSponsorFeeEvent;

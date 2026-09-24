import { type Document, model, Schema, type Types } from 'mongoose';

/**
 * Rewards credited to a stake credential, one document per epoch credit.
 *
 * **Append-only, and deliberately without a `withdrawn` state.** On Cardano a withdrawal empties the
 * whole reward account; it does not withdraw "epoch 520's reward". Nothing on chain says which
 * credits a given withdrawal consumed, so marking documents as spent would mean inventing an
 * imputation rule (FIFO, pro-rata) that the product does not need and no explorer could confirm.
 *
 * What is withdrawable right now is a snapshot of chain state, kept on the account. This collection
 * answers a different question: what was ever earned.
 */
export interface ICardanoStakingReward extends Document {
  accountId: Types.ObjectId;
  chainId: number;
  /** Epoch the reward was credited for. */
  epoch: number;
  /** Lovelace credited, decimal string. */
  amountLovelace: string;
  /**
   * Provider-side identity of the credit, so re-reading the same epoch does not double count.
   *
   * Where a provider offers no per-event id, the adapter derives a stable one from the fields that
   * identify the credit — never from the amount alone, which repeats.
   */
  sourceKey: string;
  /** What kind of credit this is, as the provider classifies it (member, leader, refund…). */
  sourceType: string | null;
  /** When this service first observed the credit. Not when the chain produced it. */
  observedAt: Date;
}

const cardanoStakingRewardSchema = new Schema<ICardanoStakingReward>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true },
    chainId: { type: Number, required: true },
    epoch: { type: Number, required: true },
    amountLovelace: { type: String, required: true },
    sourceKey: { type: String, required: true },
    sourceType: { type: String, required: false, default: null },
    observedAt: { type: Date, required: true, default: Date.now }
  },
  // Collections and indexes in this database are administered by hand, so the model must not bring
  // either into existence. Mongoose otherwise creates the collection and builds its indexes in the
  // background when the model is compiled, which is at import time: importing this file from a
  // read-only process would create the collection, and an index built that way is one nobody
  // reviewed.
  { autoCreate: false, autoIndex: false, timestamps: true }
);

// Re-reading an epoch inserts nothing new. This is what keeps lifetime earnings from drifting up
// every time the sweep runs.
cardanoStakingRewardSchema.index(
  { accountId: 1, epoch: 1, sourceKey: 1 },
  { unique: true, name: 'reward_event_unique' }
);
cardanoStakingRewardSchema.index({ accountId: 1, epoch: -1 }, { name: 'reward_history' });

const CardanoStakingReward = model<ICardanoStakingReward>(
  'CardanoStakingReward',
  cardanoStakingRewardSchema,
  'cardano_staking_rewards'
);

export default CardanoStakingReward;

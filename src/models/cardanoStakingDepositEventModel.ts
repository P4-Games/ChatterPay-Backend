import { type Document, model, Schema, type Types } from 'mongoose';

/**
 * The life of one registration deposit: what was paid, and what came back.
 *
 * Under Plan B the deposit comes out of the user's own UTxOs and stays theirs. It is not a debt to
 * ChatterPay and it is not the sponsor's to recover, which is why `economicOwner` is recorded per
 * cycle instead of being read from configuration later — a settings change must not be able to
 * reassign ownership of ada that is already locked on chain.
 */
export interface ICardanoStakingDepositEvent extends Document {
  userId: Types.ObjectId;
  chainId: number;
  accountId: Types.ObjectId;
  /** The registration cycle this deposit belongs to. */
  lifecycleId: string;
  /**
   * Lovelace actually locked, read back from the confirmed registration.
   *
   * This — not the current protocol parameter — is what an unregistration has to refund. Cardano
   * returns what was deposited, so if `stakeAddressDeposit` changes in between, a certificate built
   * from the current value will not balance and the transaction is rejected.
   */
  depositPaidLovelace: string;
  depositConfirmedAt: Date | null;
  depositTxId: string | null;
  refundAmountLovelace: string | null;
  refundedAt: Date | null;
  refundTxId: string | null;
  /** Who the deposit belongs to. `user` under Plan B. */
  economicOwner: 'user' | 'sponsor';
}

const cardanoStakingDepositEventSchema = new Schema<ICardanoStakingDepositEvent>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    chainId: { type: Number, required: true },
    accountId: { type: Schema.Types.ObjectId, required: true },
    lifecycleId: { type: String, required: true },
    depositPaidLovelace: { type: String, required: true },
    depositConfirmedAt: { type: Date, required: false, default: null },
    depositTxId: { type: String, required: false, default: null },
    refundAmountLovelace: { type: String, required: false, default: null },
    refundedAt: { type: Date, required: false, default: null },
    refundTxId: { type: String, required: false, default: null },
    economicOwner: { type: String, enum: ['user', 'sponsor'], required: true, default: 'user' }
  },
  { timestamps: true }
);

// One deposit per registration cycle. A retry of the same cycle must not open a second one.
cardanoStakingDepositEventSchema.index(
  { accountId: 1, lifecycleId: 1 },
  { unique: true, name: 'account_lifecycle_unique' }
);
// Deposits still locked: those with no refund recorded.
cardanoStakingDepositEventSchema.index({ chainId: 1, refundedAt: 1 }, { name: 'open_deposits' });

const CardanoStakingDepositEvent = model<ICardanoStakingDepositEvent>(
  'CardanoStakingDepositEvent',
  cardanoStakingDepositEventSchema,
  'cardano_staking_deposit_events'
);

export default CardanoStakingDepositEvent;

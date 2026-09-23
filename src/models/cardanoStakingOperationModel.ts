import { type Document, model, Schema, type Types } from 'mongoose';

/** What an operation intends to do on chain. */
export type CardanoStakingOperationKind =
  | 'register_and_delegate'
  | 'withdraw_rewards'
  | 'deregister'
  | 'exit_and_send_max'
  | 'redelegate_pool'
  | 'delegate_vote'
  // Declared so the shape is settled, and refused while `drepOwnEnabled` is off.
  | 'register_drep'
  | 'unregister_drep'
  | 'update_drep'
  | 'cast_drep_vote';

/** How far an operation has got, from this service's point of view. */
export type CardanoStakingOperationStatus =
  | 'queued'
  | 'executing'
  | 'signed'
  | 'submitted'
  | 'unknown_submit'
  | 'confirmed'
  | 'expired_unconfirmed'
  | 'rejected'
  | 'cancelled'
  | 'manual_review';

/**
 * What is known about the transaction's fate on chain — which is a different question from
 * `status`.
 *
 * This is what decides whether the stake credential stays locked. Hanging that decision off
 * `status` looks equivalent until an operator marks a signed operation for review: it would leave
 * the set of blocking statuses and free the credential while the transaction can still confirm.
 *
 * - `none` — never signed, never submitted. Nothing can land.
 * - `pending` — submitted, waiting.
 * - `unknown` — submitted and the outcome could not be established. Includes timeouts, 5xx, 429,
 *   and a TTL that expired without an on-chain check.
 * - `confirmed` / `rejected` — settled, either way.
 */
export type CardanoStakingChainOutcome = 'none' | 'pending' | 'unknown' | 'confirmed' | 'rejected';

/** Outcomes that mean the chain may still change under us. */
export const BLOCKING_CHAIN_OUTCOMES: readonly CardanoStakingChainOutcome[] = ['pending', 'unknown'];

/** A transaction output this operation has claimed as an input. */
export interface CardanoStakingOutpoint {
  txHash: string;
  outputIndex: number;
}

/** The quote the user authorised, frozen at the moment they authorised it. */
export interface CardanoStakingQuoteSnapshot {
  requestedGrossLovelace: string;
  commercialFeeLovelace: string;
  recipientNetLovelace: string;
  networkFeeLovelace: string;
  /** When the quote stops being valid. A submit past this point has to re-quote. */
  expiresAt: Date;
}

export interface ICardanoStakingOperation extends Document {
  accountId: Types.ObjectId;
  chainId: number;
  /** Groups the operations of one registration cycle. */
  lifecycleId: string;
  /** Schema version of the intent, so an in-flight operation is read the way it was written. */
  intentVersion: number;
  kind: CardanoStakingOperationKind;
  /** `cron`, or the authenticated channel that asked for it. */
  actor: string;
  /** Caller-supplied, unique per network. Makes a retry a no-op instead of a second transaction. */
  idempotencyKey: string;
  status: CardanoStakingOperationStatus;
  chainOutcome: CardanoStakingChainOutcome;
  requestedAt: Date;
  selectedOutpoints: CardanoStakingOutpoint[];
  leaseOwner: string | null;
  leaseUntil: Date | null;
  ttlSlot: number | null;
  txId: string | null;
  /**
   * The signed transaction, stored **before** submitting.
   *
   * Without it, a process that dies between signing and submitting cannot tell whether the
   * transaction exists, and rebuilding a different one risks a double spend.
   */
  signedCborProtected: string | null;
  /** Deposit actually paid, for a registration. Read back from the confirmed transaction. */
  actualRegistrationDepositLovelace: string | null;
  /** Deposit actually refunded, for an unregistration. */
  actualRefundLovelace: string | null;
  networkFeeLovelace: string | null;
  commercialFeeLovelace: string | null;
  quoteSnapshot: CardanoStakingQuoteSnapshot | null;
  recipientAddress: string | null;
  availableRewardWithdrawalLovelace: string | null;
  errorCode: string | null;
  attempts: number;
}

const outpointSchema = new Schema<CardanoStakingOutpoint>(
  {
    txHash: { type: String, required: true },
    outputIndex: { type: Number, required: true }
  },
  { _id: false }
);

const quoteSnapshotSchema = new Schema<CardanoStakingQuoteSnapshot>(
  {
    requestedGrossLovelace: { type: String, required: true },
    commercialFeeLovelace: { type: String, required: true },
    recipientNetLovelace: { type: String, required: true },
    networkFeeLovelace: { type: String, required: true },
    expiresAt: { type: Date, required: true }
  },
  { _id: false }
);

const cardanoStakingOperationSchema = new Schema<ICardanoStakingOperation>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true },
    chainId: { type: Number, required: true },
    lifecycleId: { type: String, required: true },
    intentVersion: { type: Number, required: true, default: 1 },
    kind: {
      type: String,
      enum: [
        'register_and_delegate',
        'withdraw_rewards',
        'deregister',
        'exit_and_send_max',
        'redelegate_pool',
        'delegate_vote',
        'register_drep',
        'unregister_drep',
        'update_drep',
        'cast_drep_vote'
      ],
      required: true
    },
    actor: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    status: {
      type: String,
      enum: [
        'queued',
        'executing',
        'signed',
        'submitted',
        'unknown_submit',
        'confirmed',
        'expired_unconfirmed',
        'rejected',
        'cancelled',
        'manual_review'
      ],
      required: true,
      default: 'queued'
    },
    chainOutcome: {
      type: String,
      enum: ['none', 'pending', 'unknown', 'confirmed', 'rejected'],
      required: true,
      default: 'none'
    },
    requestedAt: { type: Date, required: true, default: Date.now },
    selectedOutpoints: { type: [outpointSchema], required: true, default: () => [] },
    leaseOwner: { type: String, required: false, default: null },
    leaseUntil: { type: Date, required: false, default: null },
    ttlSlot: { type: Number, required: false, default: null },
    txId: { type: String, required: false, default: null },
    signedCborProtected: { type: String, required: false, default: null },
    actualRegistrationDepositLovelace: { type: String, required: false, default: null },
    actualRefundLovelace: { type: String, required: false, default: null },
    networkFeeLovelace: { type: String, required: false, default: null },
    commercialFeeLovelace: { type: String, required: false, default: null },
    quoteSnapshot: { type: quoteSnapshotSchema, required: false, default: null },
    recipientAddress: { type: String, required: false, default: null },
    availableRewardWithdrawalLovelace: { type: String, required: false, default: null },
    errorCode: { type: String, required: false, default: null },
    attempts: { type: Number, required: true, default: 0 }
  },
  { timestamps: true }
);

// A retry carrying the same key is the same intent, not a second one.
cardanoStakingOperationSchema.index(
  { chainId: 1, idempotencyKey: 1 },
  { unique: true, name: 'idempotency_unique' }
);

// At most one economic operation per account while the chain may still move.
//
// The filter is on `chainOutcome`, not on `status`: an operation under `manual_review` whose
// transaction might still confirm has to keep blocking, and one already rejected must not.
cardanoStakingOperationSchema.index(
  { accountId: 1 },
  {
    unique: true,
    name: 'one_live_op_per_account',
    partialFilterExpression: { chainOutcome: { $in: ['pending', 'unknown'] } }
  }
);

// The reconciler sweeps by outcome and expired lease.
cardanoStakingOperationSchema.index({ chainOutcome: 1, leaseUntil: 1 }, { name: 'reconcile_scan' });
// Sparse: most operations never get a txId, and a null-heavy index earns nothing.
cardanoStakingOperationSchema.index({ txId: 1 }, { name: 'txid_lookup', sparse: true });

const CardanoStakingOperation = model<ICardanoStakingOperation>(
  'CardanoStakingOperation',
  cardanoStakingOperationSchema,
  'cardano_staking_operations'
);

export default CardanoStakingOperation;

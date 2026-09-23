import { type Document, model, type Query, Schema, type Types, type UpdateQuery } from 'mongoose';

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
export const BLOCKING_CHAIN_OUTCOMES: readonly CardanoStakingChainOutcome[] = [
  'pending',
  'unknown'
];

/**
 * Evidence that a transaction is not, and can no longer be, on chain.
 *
 * A rejection on its own is not that evidence. A node answers "rejected" to a resubmission of a
 * transaction it has already accepted, and a submit that timed out can be rejected by the next node
 * asked while the first one is still propagating it. Releasing the credential on the word
 * `rejected` alone is how a stake credential gets a second certificate built for it while the first
 * one is settling.
 *
 * - `never_submitted` - the transaction was never handed to a node. Nothing can appear.
 * - `ttl_expired_and_absent` - the TTL passed and an on-chain lookup found no such transaction.
 *   Past its TTL a Cardano transaction can never become valid, so its absence is final.
 * - `chain_rejected` - the chain itself reports the transaction as invalid, with a ledger error.
 */
export type CardanoStakingAbsenceProof =
  | 'never_submitted'
  | 'ttl_expired_and_absent'
  | 'chain_rejected';

/**
 * Whether an operation still holds its account's stake credential.
 *
 * Derived, never assigned by a caller: the schema recomputes it on every write, partial updates
 * included, and the unique partial index hangs off it. It exists because the condition is a
 * disjunction - an uncertain chain outcome *or* a status that has not reached the chain yet - and a
 * partial index cannot express an `or`.
 */
export type CardanoStakingLiveness = 'live' | 'settled';

/** Statuses that hold the credential while the chain outcome is still `none`. */
const UNSETTLED_STATUSES: readonly CardanoStakingOperationStatus[] = [
  'queued',
  'executing',
  'signed',
  'submitted',
  'unknown_submit',
  'expired_unconfirmed',
  'manual_review'
];

/**
 * Whether an operation excludes another one on the same account.
 *
 * Every branch that is not provably finished answers `live`. The three cases that matter, and the
 * hole each one closes:
 *
 * - `queued`, `executing` and `signed` carry `chainOutcome: 'none'`, because nothing was submitted.
 *   Keying exclusion off the outcome alone would let a second operation be queued for an account
 *   whose first one has already selected its UTxOs and is about to be signed.
 * - `manual_review` over `chainOutcome: 'unknown'` holds. An operator looking at a transaction is
 *   not the chain deciding about it.
 * - `rejected` releases only with an {@link CardanoStakingAbsenceProof}. Without one a rejection is
 *   a report, not a fact about the ledger.
 *
 * @param status - Where the service believes the operation is.
 * @param chainOutcome - What is known about the transaction on chain.
 * @param absenceProof - Why the transaction is known not to be on chain, when that is known.
 * @returns `'live'` while the operation still holds the credential, `'settled'` once it does not.
 */
export function operationLiveness(
  status: CardanoStakingOperationStatus,
  chainOutcome: CardanoStakingChainOutcome,
  absenceProof: CardanoStakingAbsenceProof | null
): CardanoStakingLiveness {
  if (BLOCKING_CHAIN_OUTCOMES.includes(chainOutcome)) return 'live';
  if (chainOutcome === 'confirmed') return 'settled';
  if (chainOutcome === 'rejected') return absenceProof === null ? 'live' : 'settled';
  // `none`: nothing reached a node, so the status is the whole story.
  if (status === 'rejected') return absenceProof === null ? 'live' : 'settled';
  return UNSETTLED_STATUSES.includes(status) ? 'live' : 'settled';
}

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
  /** Why the transaction is known not to be on chain. `null` until something proves it. */
  absenceProof: CardanoStakingAbsenceProof | null;
  /** Derived from the three fields above. Written by the schema, never by a caller. */
  liveness: CardanoStakingLiveness;
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
    absenceProof: {
      type: String,
      enum: ['never_submitted', 'ttl_expired_and_absent', 'chain_rejected'],
      required: false,
      default: null
    },
    // Recomputed by the hooks below on every write. A value a caller supplies is overwritten.
    liveness: { type: String, enum: ['live', 'settled'], required: true, default: 'live' },
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
  // The migration owns this collection's existence, not whichever process touches the model
  // first. Mongoose otherwise creates the collection and builds its indexes in the background
  // when the model is compiled, which is at import time: a read-only process would bring the
  // collection into being, and a dry run would leave exactly the trace it promises not to.
  { autoCreate: false, autoIndex: false, timestamps: true }
);

// A retry carrying the same key is the same intent, not a second one.
cardanoStakingOperationSchema.index(
  { chainId: 1, idempotencyKey: 1 },
  { unique: true, name: 'idempotency_unique' }
);

/** The fields `liveness` is a function of. A write touching any of them has to recompute it. */
const LIVENESS_INPUTS = ['status', 'chainOutcome', 'absenceProof'] as const;

// Documents saved through the model: everything needed is already on the document.
cardanoStakingOperationSchema.pre(
  'validate',
  function recomputeLiveness(this: ICardanoStakingOperation) {
    this.liveness = operationLiveness(this.status, this.chainOutcome, this.absenceProof ?? null);
  }
);

// Documents changed through a query. The reconciler works this way - it sets an outcome on a
// document it never loaded - and without this hook `liveness` would keep whatever it was written
// with, which is to say the index would stop describing reality after the first update.
//
// The current document is read when the update is partial, because `liveness` is a function of
// three fields and an update that sets one of them says nothing about the other two. The extra read
// is the price of having no transactions; skipping it would mean trusting every caller to pass all
// three every time, and the one caller that forgets frees a credential that is still in use.
cardanoStakingOperationSchema.pre(
  ['findOneAndUpdate', 'updateOne', 'updateMany'],
  async function recomputeLivenessOnUpdate(this: Query<unknown, ICardanoStakingOperation>) {
    const update = this.getUpdate() as UpdateQuery<ICardanoStakingOperation> | null;
    if (update === null || Array.isArray(update)) return;

    const set = (update.$set ?? {}) as Record<string, unknown>;
    const unset = (update.$unset ?? {}) as Record<string, unknown>;
    const plain = update as Record<string, unknown>;
    const touched = LIVENESS_INPUTS.filter(
      (field) => field in set || field in unset || field in plain
    );
    if (touched.length === 0) return;

    const read = (field: (typeof LIVENESS_INPUTS)[number]): unknown => {
      if (field in unset) return null;
      if (field in set) return set[field];
      return plain[field];
    };

    let status = read('status') as CardanoStakingOperationStatus | undefined;
    let chainOutcome = read('chainOutcome') as CardanoStakingChainOutcome | undefined;
    let absenceProof = read('absenceProof') as CardanoStakingAbsenceProof | null | undefined;

    if (touched.length < LIVENESS_INPUTS.length) {
      const current = await this.model
        .findOne(this.getFilter())
        .select('status chainOutcome absenceProof')
        .lean<Pick<ICardanoStakingOperation, 'status' | 'chainOutcome' | 'absenceProof'> | null>();
      // No match: the update writes nothing, so there is no liveness to compute. Leaving the update
      // alone also keeps an upsert from inventing one out of the defaults of a document that is
      // about to be built from the filter.
      if (current === null) return;
      status = status ?? current.status;
      chainOutcome = chainOutcome ?? current.chainOutcome;
      absenceProof = absenceProof === undefined ? (current.absenceProof ?? null) : absenceProof;
    }

    this.set(
      'liveness',
      operationLiveness(
        status as CardanoStakingOperationStatus,
        chainOutcome as CardanoStakingChainOutcome,
        (absenceProof ?? null) as CardanoStakingAbsenceProof | null
      )
    );
  }
);

// At most one live operation per account.
//
// The filter is on `liveness`, not on `chainOutcome` and not on `status`. Either of those alone
// leaves a hole: an outcome of `none` covers everything from `queued` to `expired_unconfirmed`, and
// a status of `manual_review` says nothing about whether a transaction is still settling.
cardanoStakingOperationSchema.index(
  { accountId: 1 },
  {
    unique: true,
    name: 'one_live_op_per_account',
    partialFilterExpression: { liveness: 'live' }
  }
);

// The reconciler sweeps by outcome and expired lease.
cardanoStakingOperationSchema.index(
  { liveness: 1, chainOutcome: 1, leaseUntil: 1 },
  { name: 'reconcile_scan' }
);
// Sparse: most operations never get a txId, and a null-heavy index earns nothing.
cardanoStakingOperationSchema.index({ txId: 1 }, { name: 'txid_lookup', sparse: true });

const CardanoStakingOperation = model<ICardanoStakingOperation>(
  'CardanoStakingOperation',
  cardanoStakingOperationSchema,
  'cardano_staking_operations'
);

export default CardanoStakingOperation;

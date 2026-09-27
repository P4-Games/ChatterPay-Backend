import { type Document, model, Schema } from 'mongoose';

/**
 * The network-wide claim a staking sync run holds while it works.
 *
 * The lease on a run document excludes two deliveries of the same run, and nothing else: a manual
 * run and a scheduled one have different ids, so each would take its own lease and both would walk
 * the same accounts at once. This document is keyed by network, so at most one run of any kind acts
 * on a network at a time. The per-account guards (`one_live_op_per_account`, the idempotency key)
 * still apply underneath it; this lock keeps two passes from racing to those guards in the first
 * place.
 *
 * Taken with a conditional upsert: the filter matches a lapsed or self-owned lock, and a live lock
 * owned by someone else makes the upsert collide on `_id`, which is the refusal.
 */
export interface ICardanoStakingSyncLock extends Document<string> {
  /** `<chainId>`. */
  _id: string;
  /** The run holding it. */
  runId: string;
  /** The process holding it. */
  owner: string;
  /** When the claim lapses unless renewed. */
  expiresAt: Date;
  acquiredAt: Date;
}

const cardanoStakingSyncLockSchema = new Schema<ICardanoStakingSyncLock>(
  {
    _id: { type: String, required: true },
    runId: { type: String, required: true },
    owner: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    acquiredAt: { type: Date, required: true }
  },
  // Collections and indexes in this database are administered by hand; see the account model.
  { autoCreate: false, autoIndex: false, _id: false, timestamps: false, versionKey: false }
);

const CardanoStakingSyncLock = model<ICardanoStakingSyncLock>(
  'CardanoStakingSyncLock',
  cardanoStakingSyncLockSchema,
  'cardano_staking_sync_locks'
);

export default CardanoStakingSyncLock;

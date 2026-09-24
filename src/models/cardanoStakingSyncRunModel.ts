import { type Document, model, Schema } from 'mongoose';

/** How far through its sequence a run got. */
export type CardanoStakingSyncPhase =
  | 'reconciling'
  | 'completing_authorised'
  | 'handling_retired_pools'
  | 'discovering'
  | 'refreshing'
  | 'done';

/** Whether a run finished its universe, part of it, or failed. */
export type CardanoStakingSyncStatus = 'running' | 'partial' | 'completed' | 'failed';

/** Lease held by whichever instance is running this. */
export interface CardanoStakingSyncLease {
  owner: string;
  expiresAt: Date;
}

/**
 * One scheduler run.
 *
 * `_id` is derived from network, job name and the *scheduled* time rather than generated, so a
 * Cloud Scheduler retry — which delivers the same scheduled time — resumes the existing run instead
 * of starting a parallel one. Duplicate delivery is a documented Scheduler behaviour, not an edge
 * case.
 */
export interface ICardanoStakingSyncRun extends Document<string> {
  /** `<network>:<schedulerJobName>:<scheduledTime>`. */
  _id: string;
  chainId: number;
  scheduledTime: Date;
  startedAt: Date;
  finishedAt: Date | null;
  lease: CardanoStakingSyncLease | null;
  phase: CardanoStakingSyncPhase;
  status: CardanoStakingSyncStatus;
  /**
   * Where discovery stopped inside this run.
   *
   * Paired with the per-network cursor below: without one that survives between runs, a backlog
   * means every day starts again at the same first accounts and the tail is never reached.
   */
  userCursor: string | null;
  operationCursor: string | null;
  accountsScanned: number;
  operationsReconciled: number;
  registrationsCreated: number;
  providerRequests: number;
  /** Accounts known to still need work when the run stopped. */
  backlogCount: number;
  /** Age of the oldest unprocessed account, so a growing tail is visible and not just its size. */
  backlogOldestAt: Date | null;
  lastError: string | null;
}

const leaseSchema = new Schema<CardanoStakingSyncLease>(
  {
    owner: { type: String, required: true },
    expiresAt: { type: Date, required: true }
  },
  { _id: false }
);

const cardanoStakingSyncRunSchema = new Schema<ICardanoStakingSyncRun>(
  {
    _id: { type: String, required: true },
    chainId: { type: Number, required: true },
    scheduledTime: { type: Date, required: true },
    startedAt: { type: Date, required: true, default: Date.now },
    finishedAt: { type: Date, required: false, default: null },
    lease: { type: leaseSchema, required: false, default: null },
    phase: {
      type: String,
      enum: [
        'reconciling',
        'completing_authorised',
        'handling_retired_pools',
        'discovering',
        'refreshing',
        'done'
      ],
      required: true,
      default: 'reconciling'
    },
    status: {
      type: String,
      enum: ['running', 'partial', 'completed', 'failed'],
      required: true,
      default: 'running'
    },
    userCursor: { type: String, required: false, default: null },
    operationCursor: { type: String, required: false, default: null },
    accountsScanned: { type: Number, required: true, default: 0 },
    operationsReconciled: { type: Number, required: true, default: 0 },
    registrationsCreated: { type: Number, required: true, default: 0 },
    providerRequests: { type: Number, required: true, default: 0 },
    backlogCount: { type: Number, required: true, default: 0 },
    backlogOldestAt: { type: Date, required: false, default: null },
    lastError: { type: String, required: false, default: null }
  },
  // Collections and indexes in this database are administered by hand, so the model must not bring
  // either into existence. Mongoose otherwise creates the collection and builds its indexes in the
  // background when the model is compiled, which is at import time: importing this file from a
  // read-only process would create the collection, and an index built that way is one nobody
  // reviewed.
  { autoCreate: false, autoIndex: false, _id: false, timestamps: true }
);

cardanoStakingSyncRunSchema.index({ chainId: 1, startedAt: -1 }, { name: 'recent_runs' });
// Finding a run whose owner died and whose lease has lapsed.
cardanoStakingSyncRunSchema.index({ 'lease.expiresAt': 1 }, { name: 'lease_expiry' });

const CardanoStakingSyncRun = model<ICardanoStakingSyncRun>(
  'CardanoStakingSyncRun',
  cardanoStakingSyncRunSchema,
  'cardano_staking_sync_runs'
);

export default CardanoStakingSyncRun;

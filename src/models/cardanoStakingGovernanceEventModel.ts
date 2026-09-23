import { type Document, model, Schema, type Types } from 'mongoose';

import type {
  CardanoDRepCredential,
  CardanoGovernanceDelegationKind
} from './cardanoStakingAccountModel';

/**
 * Audit trail of vote delegation changes.
 *
 * Append-only, and each entry carries the previous value: without it there is no way to tell who
 * changed what, or to rebuild the sequence when a provider lags and the current state is read out
 * of order.
 *
 * A vote delegation change never touches the stake pool. That is structural rather than a
 * convention here — the Conway `vote_deleg_cert` has no field for a pool — but the history is kept
 * separately from pool changes so the independence is visible in the record too.
 */
export interface ICardanoStakingGovernanceEvent extends Document {
  accountId: Types.ObjectId;
  chainId: number;
  kind: CardanoGovernanceDelegationKind;
  /** Canonical CIP-129 identifier, when `kind` is `drep`. */
  drepIdCip129: string | null;
  credential: CardanoDRepCredential | null;
  previousKind: CardanoGovernanceDelegationKind | null;
  previousDrepIdCip129: string | null;
  /** Who asked for the change: the authenticated channel, or `cron` for a reconciliation. */
  actor: string;
  operationId: Types.ObjectId;
  requestedAt: Date;
  txId: string | null;
  confirmedAt: Date | null;
}

const credentialSchema = new Schema<CardanoDRepCredential>(
  {
    type: { type: String, enum: ['key_hash', 'script_hash'], required: true },
    hashHex: { type: String, required: true }
  },
  { _id: false }
);

const cardanoStakingGovernanceEventSchema = new Schema<ICardanoStakingGovernanceEvent>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true },
    chainId: { type: Number, required: true },
    kind: {
      type: String,
      enum: ['drep', 'always_abstain', 'always_no_confidence', 'none', 'not_registered'],
      required: true
    },
    drepIdCip129: { type: String, required: false, default: null },
    credential: { type: credentialSchema, required: false, default: null },
    previousKind: { type: String, required: false, default: null },
    previousDrepIdCip129: { type: String, required: false, default: null },
    actor: { type: String, required: true },
    operationId: { type: Schema.Types.ObjectId, required: true },
    requestedAt: { type: Date, required: true, default: Date.now },
    txId: { type: String, required: false, default: null },
    confirmedAt: { type: Date, required: false, default: null }
  },
  { timestamps: true }
);

cardanoStakingGovernanceEventSchema.index(
  { accountId: 1, confirmedAt: -1 },
  { name: 'governance_history' }
);
// One event per operation: a reconciler that re-reads a confirmed change must not log it twice.
cardanoStakingGovernanceEventSchema.index(
  { operationId: 1 },
  { unique: true, name: 'governance_operation_unique' }
);

const CardanoStakingGovernanceEvent = model<ICardanoStakingGovernanceEvent>(
  'CardanoStakingGovernanceEvent',
  cardanoStakingGovernanceEventSchema,
  'cardano_staking_governance_events'
);

export default CardanoStakingGovernanceEvent;

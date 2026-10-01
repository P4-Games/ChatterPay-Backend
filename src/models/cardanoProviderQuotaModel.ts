import { type Document, model, Schema } from 'mongoose';

/**
 * Requests spent against one provider credential in one quota day.
 *
 * Shared by every instance: each request is reserved with a conditional `$inc` here before it is
 * sent, so the count is the same whichever Cloud Run instance asks. The `_id` names the credential
 * by a fingerprint of the key, never by the key itself.
 *
 * Counts requests sent by this backend only. A consumer of the same credential outside it would not
 * appear here, so `total` is a floor on what the provider has billed, not the provider's own figure.
 */
export interface ICardanoProviderQuota extends Document<string> {
  /** `<scope>|<window>`. */
  _id: string;
  /** `<kind>:<host>:<key fingerprint>`. */
  scope: string;
  /** The quota day, `YYYY-MM-DD` after applying the configured offset from UTC. */
  window: string;
  total: number;
  /** Requests by priority: `critical`, `interactive`, `pending`, `background`. */
  byPriority: Record<string, number>;
  /** Requests by endpoint family, e.g. `accounts`, `addresses.utxos`, `txs`. */
  byFamily: Record<string, number>;
  /** Requests by logical origin, e.g. `sync.refresh`, `unattributed`. */
  byOrigin: Record<string, number>;
  /** 429 answers received. */
  rateLimited: number;
  /** Requests this backend refused to send, by the ceiling that refused them. */
  refused: Record<string, number>;
  /** Background work waits until this moment after a 429. */
  backgroundPausedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const cardanoProviderQuotaSchema = new Schema<ICardanoProviderQuota>(
  {
    _id: { type: String, required: true },
    scope: { type: String, required: true },
    window: { type: String, required: true },
    total: { type: Number, required: true, default: 0 },
    byPriority: { type: Schema.Types.Mixed, required: false, default: () => ({}) },
    byFamily: { type: Schema.Types.Mixed, required: false, default: () => ({}) },
    byOrigin: { type: Schema.Types.Mixed, required: false, default: () => ({}) },
    rateLimited: { type: Number, required: false, default: 0 },
    refused: { type: Schema.Types.Mixed, required: false, default: () => ({}) },
    backgroundPausedUntil: { type: Date, required: false, default: null },
    createdAt: { type: Date, required: false },
    updatedAt: { type: Date, required: false }
  },
  // Collections and indexes in this database are administered by hand; see the account model.
  { autoCreate: false, autoIndex: false, _id: false, timestamps: false, versionKey: false }
);

// History by credential, newest day first, for the usage report and for pruning old days.
cardanoProviderQuotaSchema.index({ scope: 1, window: -1 }, { name: 'quota_history' });

const CardanoProviderQuota = model<ICardanoProviderQuota>(
  'CardanoProviderQuota',
  cardanoProviderQuotaSchema,
  'cardano_provider_quota'
);

export default CardanoProviderQuota;

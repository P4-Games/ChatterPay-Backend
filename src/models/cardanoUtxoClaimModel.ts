import { type Document, model, Schema } from 'mongoose';

/**
 * The UTxO claim store, declared so that the migration and the guard can own its index.
 *
 * **This model is not how the collection is read or written.** Every claim is taken, released and
 * inspected through the raw driver in `cardanoUtxoClaimService`, because claiming is an atomic
 * insert on a string `_id` and the whole mechanism is that one insert either wins or collides.
 * What the model is for is the index: the collection's expiry behaviour became load-bearing for
 * staking, and an index that matters that much cannot go on being created lazily by whichever
 * process happens to touch the store first.
 *
 * With it declared here, the collection joins the list the migration builds and the guard verifies,
 * so a deployment whose migration never ran refuses staking operations instead of running them
 * against a store whose expiry is not what this code assumes.
 *
 * The index name is pinned to `expiresAt_1` on purpose. That is the name Mongo generates, and it is
 * the name already on every collection the lazy creation reached. Declaring the same key under a
 * different name would be refused by the server as a conflicting index, on exactly the deployments
 * that already work.
 */
export interface ICardanoUtxoClaim extends Document<string> {
  /** An outpoint, a transaction marker, or a pending-change marker. Unique; that is the mutex. */
  _id: string;
  holder: string;
  /**
   * When the claim stops standing, or `null` for one that does not stop on its own.
   *
   * The TTL monitor only ever selects documents whose field holds a date in the past, so a `null`
   * takes the claim out of its reach entirely — which is what a staking claim needs once a
   * signature exists, because from that moment an expiry would be a release nothing proved.
   */
  expiresAt: Date | null;
}

const cardanoUtxoClaimSchema = new Schema<ICardanoUtxoClaim>(
  {
    _id: { type: String, required: true },
    holder: { type: String, required: true },
    expiresAt: { type: Date, required: false, default: null }
  },
  // The migration owns this collection's indexes. `autoIndex: false` keeps Mongoose from building
  // them in the background at import time, which is what would let a read-only process bring the
  // index into being and a dry run leave a trace it promised not to.
  { autoCreate: false, autoIndex: false, _id: false, versionKey: false }
);

// `expireAfterSeconds: 0` means "expire at the instant the field names", not "expire immediately":
// the monitor compares the stored date against now. A document whose field is null or absent is
// never a candidate, and that is what a pinned staking claim relies on.
cardanoUtxoClaimSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expiresAt_1' });

const CardanoUtxoClaim = model<ICardanoUtxoClaim>(
  'CardanoUtxoClaim',
  cardanoUtxoClaimSchema,
  'cardano_utxo_claims'
);

export default CardanoUtxoClaim;

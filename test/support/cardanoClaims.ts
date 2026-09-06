import mongoose from 'mongoose';

/**
 * Empties the UTxO claim store between tests.
 *
 * The claims are keyed by outpoint and outlive the transfer that took them, which is the whole
 * point of them in production: an output this deployment spent must not be offered again while the
 * provider still lists it as unspent. Fixtures, though, mint the same deterministic transaction
 * hashes in every test — so without this a claim taken by one test makes the next one see an empty
 * wallet, and the failure looks like `CARDANO_INSUFFICIENT_FUNDS` for no visible reason.
 */
export async function resetCardanoUtxoClaims(): Promise<void> {
  await mongoose.connection.db?.collection('cardano_utxo_claims').deleteMany({});
}

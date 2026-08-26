/**
 * Who gets to spend which of the sponsor's outputs, while a transfer is being built.
 *
 * Coin selection is deterministic on purpose — the same inputs must produce the same fee — and for
 * a user's own wallet that is exactly right, because nobody else is spending from it. The sponsor's
 * wallet is the opposite case: every transfer in flight reaches into the same set of outputs, and
 * a deterministic selection means they all reach for the *same* one.
 *
 * The ledger then settles it the only way it can. One transaction lands, the rest are rejected for
 * spending an input that is already gone — and the sponsor's change comes back as a new output that
 * is not spendable until it has the confirmations this deployment requires. So the failure does not
 * clear on a retry: under any sustained traffic, sponsoring denies itself.
 *
 * A lease is what makes the selection disjoint. Each builder claims the outputs it is about to
 * spend, the claim is a document whose `_id` is the outpoint, and the uniqueness of that `_id` is
 * the whole mechanism: two builders racing for the same output, one insert wins. The loser moves to
 * the next output rather than building a transaction that was never going to land.
 *
 * Claims expire on their own. A process that dies between claiming and submitting must not hold an
 * output hostage, and the transaction it would have built carries a TTL of its own — past that, the
 * input is provably free again.
 */

import mongoose from 'mongoose';

import { Logger } from '../../helpers/loggerHelper';
import type { CardanoUtxo } from '../../types/cardanoType';
import { spendableUtxos } from './cardanoTxService';

const COLLECTION = 'cardano_sponsor_utxo_leases';

/**
 * How long a claim stands.
 *
 * Longer than a transaction's own validity window, so a lease never expires while the transaction
 * holding it could still be accepted — releasing it earlier would invite a second builder to spend
 * an output the chain is about to consume.
 */
const LEASE_SECONDS = 1_200;

interface LeaseDoc {
  /** The outpoint: `txHash#index`. Unique by construction, which is what makes the claim atomic. */
  _id: string;
  /** What the lease was taken for, for the operator reading a stuck one. */
  holder: string;
  /** When the claim stops standing. A TTL index removes it. */
  expiresAt: Date;
}

function collection() {
  return mongoose.connection.db!.collection<LeaseDoc>(COLLECTION);
}

/** The outpoint of a UTxO, in the form the lease uses. */
function outpointOf(utxo: CardanoUtxo): string {
  return `${utxo.txHash}#${utxo.outputIndex}`;
}

let indexReady = false;

/**
 * Makes sure expired claims are removed without anybody sweeping them.
 *
 * Created on first use rather than at boot: this collection only matters when sponsoring is on, and
 * a deployment that never sponsors should not be creating collections for it.
 */
async function ensureIndex(): Promise<void> {
  if (indexReady) return;
  await collection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  indexReady = true;
}

/** What a lease attempt produced. */
export interface SponsorLease {
  /** The outputs this caller may spend. Ordered as coin selection wants them. */
  utxos: CardanoUtxo[];
  /** The outpoints to release, once the transfer has settled one way or the other. */
  outpoints: string[];
}

/**
 * Claims enough of the sponsor's outputs to cover an amount.
 *
 * @param utxos - Everything the sponsor address holds.
 * @param cover - Lovelace the claim has to add up to.
 * @param holder - What the claim is for, recorded for diagnosis.
 * @returns The claimed outputs. Empty when nothing could be claimed.
 */
export async function leaseSponsorUtxos(
  utxos: readonly CardanoUtxo[],
  cover: bigint,
  holder: string
): Promise<SponsorLease> {
  await ensureIndex();

  const claimed: CardanoUtxo[] = [];
  const outpoints: string[] = [];
  let total = 0n;

  for (const utxo of spendableUtxos(utxos)) {
    if (total >= cover) break;
    const outpoint = outpointOf(utxo);
    try {
      await collection().insertOne({
        _id: outpoint,
        holder,
        expiresAt: new Date(Date.now() + LEASE_SECONDS * 1000)
      });
    } catch {
      // Somebody else is spending it. Duplicate `_id` is the expected outcome under load, not an
      // error to report: the next output is what this builder wanted anyway.
      continue;
    }
    claimed.push(utxo);
    outpoints.push(outpoint);
    total += utxo.lovelace;
  }

  if (total < cover) {
    // Nothing usable was assembled, so nothing stays claimed: holding a partial set would deny it
    // to the next transfer without buying this one anything.
    await releaseSponsorUtxos(outpoints);
    return { utxos: [], outpoints: [] };
  }

  return { utxos: claimed, outpoints };
}

/**
 * Drops claims, so the outputs are available again before the lease would have expired.
 *
 * Call it when the transfer did not spend them. An output that *was* spent may be released too —
 * the chain has already made it unspendable, and the claim is only about who gets to try.
 *
 * @param outpoints - What to release. An empty list is a no-op.
 */
export async function releaseSponsorUtxos(outpoints: readonly string[]): Promise<void> {
  if (outpoints.length === 0) return;
  try {
    await collection().deleteMany({ _id: { $in: [...outpoints] } });
  } catch (error) {
    // Not worth failing a settled transfer over: the claims expire on their own.
    Logger.warn(
      'releaseSponsorUtxos',
      `could not release ${outpoints.length} lease(s): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

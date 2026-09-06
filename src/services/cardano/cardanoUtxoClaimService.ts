/**
 * Which outputs this deployment has already committed to spending, and which transactions are its
 * own.
 *
 * Cardano has no nonce. What decides that two transfers do not collide is that they spend different
 * outputs — and the only thing that knows which outputs are still unspent is the provider, which
 * reads an indexed chain and is therefore always a block or more behind. Submitting does not change
 * what it reports: the transaction sits in the mempool, the inputs it consumes keep coming back as
 * available, and the next transfer -- built by a deterministic coin selection over the same list --
 * reaches for exactly the same output. The node then rejects it with `All inputs are spent`, which
 * reads like an accident and is really the only possible outcome.
 *
 * So the record of what was spent has to live here rather than be read back from the chain. A claim
 * is a document whose `_id` is the outpoint, and the uniqueness of that `_id` is the entire
 * mechanism: two builders racing for one output, one insert wins and the other moves on. Being a
 * document, it also works across instances, which an in-process set would not.
 *
 * The claim outlives the transfer that took it. That is the part that matters and the part that was
 * missing: releasing on success hands the output straight back to the next transfer, in the exact
 * window where the provider still lists it as unspent. Claims are only released when the
 * transaction provably did not happen, and otherwise expire on their own.
 *
 * The same store records the transactions this deployment submitted, for the opposite reason. An
 * output that a transfer just created -- the sender's change -- has no confirmations yet, and the
 * confirmation rule exists to keep somebody else's deposit from being credited before a rollback
 * could take it away. Change this deployment produced itself is not that, and treating it as such
 * would leave a wallet unable to fund the transfer that follows it.
 */

import mongoose from 'mongoose';

import { Logger } from '../../helpers/loggerHelper';
import type { CardanoUtxo } from '../../types/cardanoType';

const COLLECTION = 'cardano_utxo_claims';

/**
 * How long a claim stands.
 *
 * Longer than a transaction's own validity window, so a claim never expires while the transaction
 * holding it could still be accepted, and long enough to cover the provider catching up: once the
 * spend is indexed, the output stops being offered and the claim stops mattering.
 */
const CLAIM_SECONDS = 1_200;

/**
 * How long a submitted transaction id is remembered.
 *
 * Only needs to outlast the wait for its outputs to be confirmed. Kept at the claim's lifetime so
 * both expire together and there is one number to reason about.
 */
const OWN_TRANSACTION_SECONDS = CLAIM_SECONDS;

/** Marks the documents that record a transaction rather than an outpoint. */
const OWN_TRANSACTION_PREFIX = 'tx:';

/** Marks the documents that describe an output a submitted transaction is about to create. */
const PENDING_CHANGE_PREFIX = 'change:';

interface ClaimDoc {
  /**
   * An outpoint (`txHash#index`), or `tx:<transactionId>`, or `change:<outpoint>`. Unique, which is
   * what makes claiming atomic.
   */
  _id: string;
  /** What took it, for an operator reading a stuck claim. */
  holder: string;
  /** When it stops standing. A TTL index removes it. */
  expiresAt: Date;
  /** Pending change only: the address the output pays. */
  address?: string;
  /** Pending change only: lovelace it carries, as a string because Mongo has no bigint. */
  lovelace?: string;
  /** Pending change only: native assets riding along, quantities as strings for the same reason. */
  assets?: { policyId: string; assetName: string; quantity: string }[];
}

function collection() {
  return mongoose.connection.db!.collection<ClaimDoc>(COLLECTION);
}

/** The outpoint of a UTxO, in the form a claim uses. */
export function outpointOf(utxo: CardanoUtxo): string {
  return `${utxo.txHash}#${utxo.outputIndex}`;
}

let indexReady = false;

/**
 * Makes sure expired claims are removed without anybody sweeping them.
 *
 * Created on first use rather than at boot: a deployment that never moves ADA should not be
 * creating collections for it.
 */
async function ensureIndex(): Promise<void> {
  if (indexReady) return;
  await collection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  indexReady = true;
}

/**
 * Claims a specific set of outputs, all or nothing.
 *
 * All or nothing because a partial claim is worse than none: it denies outputs to the next transfer
 * without letting this one proceed. The caller already knows which outputs its transaction spends —
 * this is not a search for enough of them, it is the commitment to the ones already chosen.
 *
 * @param utxos - Exactly the outputs the built transaction consumes.
 * @param holder - What the claim is for, recorded for diagnosis.
 * @returns The outpoints claimed, or `null` when any of them was already taken.
 */
export async function claimUtxos(
  utxos: readonly CardanoUtxo[],
  holder: string
): Promise<string[] | null> {
  await ensureIndex();

  const taken: string[] = [];
  for (const utxo of utxos) {
    const outpoint = outpointOf(utxo);
    try {
      await collection().insertOne({
        _id: outpoint,
        holder,
        expiresAt: new Date(Date.now() + CLAIM_SECONDS * 1000)
      });
      taken.push(outpoint);
    } catch {
      // Duplicate `_id`: somebody else is spending it. Expected under load, not an error — but this
      // transaction is already built around that output, so it cannot simply skip it.
      await releaseUtxos(taken);
      return null;
    }
  }
  return taken;
}

/**
 * Drops claims, so the outputs can be offered again before the claim would have expired.
 *
 * Only correct when the transaction provably did not reach the chain. On any other outcome — it
 * succeeded, or the submit's fate is unknown — the claim has to stand, because the provider will go
 * on offering those outputs for as long as the spend is unindexed.
 *
 * @param outpoints - What to release. An empty list is a no-op.
 */
export async function releaseUtxos(outpoints: readonly string[]): Promise<void> {
  if (outpoints.length === 0) return;
  try {
    await collection().deleteMany({ _id: { $in: [...outpoints] } });
  } catch (error) {
    // Not worth failing a settled transfer over: claims expire on their own.
    Logger.warn(
      'releaseUtxos',
      `could not release ${outpoints.length} claim(s): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Removes the outputs this deployment has already committed to spending.
 *
 * @param utxos - What the provider reports the address holds.
 * @returns The ones nothing else is spending. On a database failure the input is returned unchanged:
 *   refusing every transfer because the claim store is unreachable is worse than the collision it
 *   protects against, which the chain would reject cleanly anyway.
 */
export async function unclaimedUtxos(
  utxos: readonly CardanoUtxo[]
): Promise<readonly CardanoUtxo[]> {
  if (utxos.length === 0) return utxos;
  try {
    await ensureIndex();
    const outpoints = utxos.map(outpointOf);
    const claimed = await collection()
      .find({ _id: { $in: outpoints } }, { projection: { _id: 1 } })
      .toArray();
    if (claimed.length === 0) return utxos;
    const taken = new Set(claimed.map((doc) => doc._id));
    return utxos.filter((utxo) => !taken.has(outpointOf(utxo)));
  } catch (error) {
    Logger.warn(
      'unclaimedUtxos',
      `claim store unreachable, spending unfiltered: ${error instanceof Error ? error.message : String(error)}`
    );
    return utxos;
  }
}

/**
 * Records a transaction this deployment submitted.
 *
 * What it buys is the right to spend that transaction's outputs before they are confirmed: they are
 * this deployment's own change, not somebody else's deposit.
 *
 * @param transactionId - The submitted transaction's id.
 * @param holder - What produced it, recorded for diagnosis.
 */
export async function recordOwnTransaction(transactionId: string, holder: string): Promise<void> {
  try {
    await ensureIndex();
    await collection().insertOne({
      _id: `${OWN_TRANSACTION_PREFIX}${transactionId}`,
      holder,
      expiresAt: new Date(Date.now() + OWN_TRANSACTION_SECONDS * 1000)
    });
  } catch (error) {
    // A duplicate is harmless (the same transaction resolved twice), and a store that is down only
    // costs the next transfer a wait for confirmations. Neither is worth failing a settled transfer.
    Logger.warn(
      'recordOwnTransaction',
      `could not record ${transactionId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Which of these outputs came from a transaction this deployment submitted.
 *
 * @param utxos - Outputs to classify.
 * @returns The transaction ids, among those the outputs came from, that this deployment produced.
 */
export async function ownTransactionsAmong(
  utxos: readonly CardanoUtxo[]
): Promise<ReadonlySet<string>> {
  if (utxos.length === 0) return new Set();
  try {
    await ensureIndex();
    const ids = [...new Set(utxos.map((utxo) => `${OWN_TRANSACTION_PREFIX}${utxo.txHash}`))];
    const found = await collection()
      .find({ _id: { $in: ids } }, { projection: { _id: 1 } })
      .toArray();
    return new Set(found.map((doc) => doc._id.slice(OWN_TRANSACTION_PREFIX.length)));
  } catch (error) {
    Logger.warn(
      'ownTransactionsAmong',
      `claim store unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
    return new Set();
  }
}

/**
 * Records the change output a submitted transaction is about to create.
 *
 * The provider cannot report it yet -- the transaction is in a mempool, and an unindexed output does
 * not exist as far as any query is concerned. Without this, a wallet that spends its whole balance
 * and gets the remainder back has nothing to spend until a block carries it, so the transfer that
 * follows is told it has no funds while the money is plainly there.
 *
 * The transaction was already submitted when this is called, so the output is as real as the
 * transaction: if that never lands, neither does the change, and the transfer built on it is
 * rejected for spending an input that does not exist. That is a clean failure, not a loss.
 *
 * @param utxo - The output as it will appear on chain: the submitted transaction's id and index.
 * @param address - The address it pays, which is who may spend it.
 * @param holder - What produced it, recorded for diagnosis.
 */
export async function recordPendingChange(
  utxo: CardanoUtxo,
  address: string,
  holder: string
): Promise<void> {
  try {
    await ensureIndex();
    await collection().insertOne({
      _id: `${PENDING_CHANGE_PREFIX}${outpointOf(utxo)}`,
      holder,
      address,
      lovelace: utxo.lovelace.toString(),
      assets: (utxo.assets ?? []).map((asset) => ({
        policyId: asset.policyId,
        assetName: asset.assetName,
        quantity: asset.quantity.toString()
      })),
      expiresAt: new Date(Date.now() + CLAIM_SECONDS * 1000)
    });
  } catch (error) {
    // Costs the next transfer a wait, never correctness.
    Logger.warn(
      'recordPendingChange',
      `could not record change of ${outpointOf(utxo)}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Outputs an address is about to receive from transactions this deployment submitted.
 *
 * @param address - The address to look up.
 * @returns The pending outputs, in the shape a provider would have reported them.
 */
export async function pendingChangeFor(address: string): Promise<CardanoUtxo[]> {
  try {
    await ensureIndex();
    const docs = await collection()
      .find({ address, _id: { $regex: `^${PENDING_CHANGE_PREFIX}` } })
      .toArray();
    return docs.map((doc) => {
      const [txHash, index] = doc._id.slice(PENDING_CHANGE_PREFIX.length).split('#');
      const assets = (doc.assets ?? []).map((asset) => ({
        policyId: asset.policyId,
        assetName: asset.assetName,
        quantity: BigInt(asset.quantity)
      }));
      return {
        txHash,
        outputIndex: Number(index),
        lovelace: BigInt(doc.lovelace ?? '0'),
        holdsOtherAssets: assets.length > 0,
        assets
      };
    });
  } catch (error) {
    Logger.warn(
      'pendingChangeFor',
      `claim store unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

/**
 * Forgets pending change outputs, by the outpoint they were recorded under.
 *
 * A pending output is a promise about a transaction that was submitted, and a promise has to be
 * withdrawn when it turns out to be false: the transaction was rejected, or the output was consumed
 * by something that never went through the claim store. Left in place it is offered to every
 * transfer until it expires, and each one is rejected for spending an input that does not exist.
 *
 * @param outpoints - The outpoints whose pending records should go. An empty list is a no-op.
 */
export async function forgetPendingChange(outpoints: readonly string[]): Promise<void> {
  if (outpoints.length === 0) return;
  try {
    await collection().deleteMany({
      _id: { $in: outpoints.map((outpoint) => `${PENDING_CHANGE_PREFIX}${outpoint}`) }
    });
  } catch (error) {
    Logger.warn(
      'forgetPendingChange',
      `could not forget ${outpoints.length} pending output(s): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

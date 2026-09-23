/**
 * Committing a staking transaction's inputs, and giving them back only when that is provably safe.
 *
 * A built staking transaction names exactly the outputs it spends — the user's and the sponsor's
 * together. Between building and submitting, another instance can build a second transaction around
 * the same outputs; the chain then accepts one and rejects the other, and the rejected one has
 * already consumed a fee reservation and, worse, may have been a registration for a credential the
 * first one also registered. Claiming the outputs is what stops the second build from happening.
 *
 * Three rules, and each of them is the same rule the rest of this domain already follows:
 *
 * - **All or nothing.** A partial claim denies outputs to the next operation without letting this
 *   one proceed.
 * - **Fail closed.** If the claim store cannot be read, no staking input is selected. Transfers
 *   deliberately fail open there; staking does not, because a staking collision does not bounce off
 *   the chain harmlessly.
 * - **Release only on proof.** A claim goes back when the transaction is known not to be on chain,
 *   never because an outcome looked bad. The proof is read from the operation rather than taken as
 *   an argument, so no caller can assert it.
 */

import type { Types } from 'mongoose';

import { Logger } from '../../helpers/loggerHelper';
import CardanoStakingOperation from '../../models/cardanoStakingOperationModel';
import type { CardanoUtxo } from '../../types/cardanoType';
import type { BuiltCardanoStakingTransaction } from './cardanoStakingBuilderService';
import {
  claimsHeldBy,
  claimUtxos,
  outpointOf,
  pinClaims,
  releaseUtxos,
  unclaimedUtxosStrict
} from './cardanoUtxoClaimService';

/**
 * How long a staking claim stands **before anything has been signed**.
 *
 * This window is the one place a bounded expiry is still correct for staking, and it is correct for
 * a specific reason: between claiming the inputs and producing a signature, no transaction exists.
 * Nothing was sent, so nothing can be on chain, so letting the store drop the claim releases inputs
 * that provably nothing is spending. If the process dies here and does not come back for a day, the
 * expiry is the recovery rather than a hazard.
 *
 * The moment a signature exists that stops being true, and the claim is pinned instead — see
 * {@link pinStakingInputs}. An hour is simply longer than any single build takes.
 */
export const STAKING_UNSIGNED_CLAIM_SECONDS = 60 * 60;

/**
 * The holder string a staking operation's claims carry.
 *
 * @param operationId - The operation.
 * @returns Its holder string.
 */
export function stakingClaimHolder(operationId: Types.ObjectId): string {
  return `staking:${operationId.toHexString()}`;
}

/** How a reservation attempt ended. */
export type StakingInputReservationOutcome =
  /** Every output this transaction spends is now held for it. */
  | 'reserved'
  /** Something else already holds one of them. The transaction must be rebuilt, not retried. */
  | 'collision';

/** How a release attempt ended. */
export type StakingInputReleaseOutcome =
  | 'released'
  /** The operation does not carry proof that its transaction never reached the chain. */
  | 'no_absence_proof';

export interface StakingInputReservation {
  outcome: StakingInputReservationOutcome;
  /** The outpoints held, in the order they were claimed. Empty on a collision. */
  outpoints: readonly string[];
}

/**
 * The outputs a staking operation may select from.
 *
 * @param utxos - What the provider reports the address holds.
 * @returns The ones no other operation has committed to.
 * @throws Error `CARDANO_CLAIM_STORE_UNAVAILABLE` when the claim store cannot be read. Refusing to
 *   build is the safe answer here: an unfiltered selection would spend outputs another operation is
 *   already spending.
 */
export async function selectableStakingUtxos(
  utxos: readonly CardanoUtxo[]
): Promise<readonly CardanoUtxo[]> {
  return unclaimedUtxosStrict(utxos);
}

/**
 * Holds every output a built transaction spends, on both sides.
 *
 * Safe to call again for the same operation only after a release: a second call while the first
 * claim stands reports a collision, which is the correct answer — the outputs are held, by this
 * operation, and the transaction already exists.
 *
 * @param built - The transaction whose inputs to hold.
 * @param operationId - The operation the claim belongs to, recorded for diagnosis.
 * @returns Whether the claim was granted, and what it holds.
 */
export async function reserveStakingInputs(
  built: BuiltCardanoStakingTransaction,
  operationId: Types.ObjectId
): Promise<StakingInputReservation> {
  const inputs = [...built.selectedUserUtxos, ...built.selectedSponsorUtxos];
  if (inputs.length === 0) return { outcome: 'reserved', outpoints: [] };

  const claimed = await claimUtxos(
    inputs,
    stakingClaimHolder(operationId),
    STAKING_UNSIGNED_CLAIM_SECONDS
  );
  if (claimed === null) {
    Logger.info(
      'reserveStakingInputs',
      `Cardano staking operation ${operationId.toHexString()} lost a race for its inputs; it has to be rebuilt`
    );
    return { outcome: 'collision', outpoints: [] };
  }

  return { outcome: 'reserved', outpoints: claimed };
}

/**
 * Gives the inputs back, and only on proof that the transaction never reached the chain.
 *
 * An operation whose outcome is merely `rejected`, or still `unknown`, keeps its inputs. Releasing
 * them would let a second transaction spend outputs the first one may yet consume, and the provider
 * goes on offering those outputs for as long as the spend is unindexed.
 *
 * @param operationId - The operation whose inputs are being released.
 * @param outpoints - What it holds.
 * @returns Whether the release happened.
 */
export async function releaseStakingInputs(
  operationId: Types.ObjectId,
  outpoints: readonly string[]
): Promise<StakingInputReleaseOutcome> {
  const operation = await CardanoStakingOperation.findById(operationId).select('absenceProof');
  if (operation === null || operation.absenceProof === null) return 'no_absence_proof';

  // Everything the holder has, not only what the caller remembered. A crash between claiming the
  // inputs and recording them leaves a hold the operation cannot describe, and releasing the short
  // list would leave the rest frozen until the backstop expiry.
  const held = await claimsHeldBy(stakingClaimHolder(operationId));
  await releaseUtxos([...new Set([...outpoints, ...held])]);
  return 'released';
}

/**
 * Puts an operation's claims beyond any automatic expiry.
 *
 * Called at the moment a signature exists and before anything is submitted, which is the moment the
 * inputs stop being provably free. From then on the claim is dropped by an explicit release or not
 * at all: no timer, no index, and nothing that depends on a process still running.
 *
 * Idempotent, and called again from reconciliation so that an operation which was pinned by a
 * process that then died — or one whose pin raced with a crash — is pinned by whatever picks it up
 * next.
 *
 * @param operationId - The operation whose claims to pin.
 * @returns How many claims it holds.
 */
export async function pinStakingInputs(operationId: Types.ObjectId): Promise<number> {
  const holder = stakingClaimHolder(operationId);
  const held = await claimsHeldBy(holder);
  return pinClaims(held, holder);
}

/**
 * Gives back the inputs of an operation that was never signed.
 *
 * This is the one release that does not need the chain, and the reason it is sound is the order the
 * lifecycle works in: inputs are claimed, then the transaction is signed and its bytes stored, and
 * only then is anything submitted. An operation holding claims with no signed bytes therefore never
 * produced a transaction at all — nothing was sent, so nothing can be on chain, and the absence is
 * proved by this backend's own history rather than by a provider that might be lagging.
 *
 * This is what recovers a crash between claiming the inputs and recording them on the operation.
 * That window leaves a hold nothing else can find, because the operation does not know what it
 * took; the claims are found by holder instead.
 *
 * @param operationId - The operation to recover.
 * @returns What happened. `still_signed` when the operation does carry signed bytes, in which case
 *   a transaction may exist and only the chain can settle it.
 */
export async function releaseUnsignedStakingInputs(
  operationId: Types.ObjectId
): Promise<'released' | 'still_signed' | 'nothing_held'> {
  const held = await claimsHeldBy(stakingClaimHolder(operationId));
  if (held.length === 0) return 'nothing_held';

  const operation = await CardanoStakingOperation.findById(operationId).select(
    'signedCborProtected txId'
  );
  // A missing operation is treated as signed, not as unsigned. The claim is the only evidence left,
  // and it does not say which side of the signing step the process died on.
  if (operation === null) return 'still_signed';
  if (operation.signedCborProtected !== null || operation.txId !== null) return 'still_signed';

  await CardanoStakingOperation.updateOne(
    { _id: operationId, signedCborProtected: null, txId: null },
    { $set: { absenceProof: 'never_submitted', chainOutcome: 'rejected', status: 'cancelled' } }
  );
  await releaseUtxos(held);
  return 'released';
}

/**
 * The outpoints a built transaction consumes, in the shape the operation document stores.
 *
 * @param built - The built transaction.
 * @returns One entry per input.
 */
export function outpointsOf(
  built: BuiltCardanoStakingTransaction
): { txHash: string; outputIndex: number }[] {
  return [...built.selectedUserUtxos, ...built.selectedSponsorUtxos].map((utxo) => ({
    txHash: utxo.txHash,
    outputIndex: utxo.outputIndex
  }));
}

/**
 * The claim keys a built transaction's inputs use.
 *
 * @param built - The built transaction.
 * @returns The outpoints, as the claim store keys them.
 */
export function claimKeysOf(built: BuiltCardanoStakingTransaction): string[] {
  return [...built.selectedUserUtxos, ...built.selectedSponsorUtxos].map(outpointOf);
}

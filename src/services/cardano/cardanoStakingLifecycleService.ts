/**
 * Taking one staking operation from "queued" to a transaction on chain, crash by crash.
 *
 * Every step here can be interrupted — the container is replaced mid-flight, the provider times
 * out, Mongo blinks — and the question each step answers is not "did it work" but "what does the
 * next attempt see, and what must it not do". Cardano has no nonce and no replace-by-fee, so a
 * second transaction built for the same intent is a genuinely different transaction that can also
 * land. Everything below exists to make sure a retry either finishes the transaction that already
 * exists or does nothing at all.
 *
 * The order is fixed, and each step is idempotent on its own:
 *
 * 1. **Reserve the fee budget.** Keyed by operation id, so a repeat charges nothing. Before the
 *    build, because over-reserving is recoverable and over-spending is not.
 * 2. **Build.** Pure. Produces the body, its id, and the exact inputs it spends.
 * 3. **Claim the inputs.** All or nothing. A collision means another operation got there first and
 *    this one has to be rebuilt, not retried.
 * 4. **Sign, and store the signed bytes before submitting.** This is the step that makes recovery
 *    possible at all: a process that dies between signing and submitting comes back holding the
 *    exact transaction it was about to send, and can ask the chain about it instead of guessing.
 * 5. **Submit.** Three outcomes, not two — accepted, refused, and *unknown*. An unknown submit is
 *    the dangerous one and is treated as live: the transaction may be propagating.
 * 6. **Reconcile.** Only a lookup settles an unknown, and only a settled absence releases anything.
 *
 * **A retry never builds a different economic transaction.** If the operation already carries signed
 * bytes, the retry resubmits *those*; it does not re-select inputs, re-quote or rebuild. Rebuilding
 * is what turns one intended registration into two paid deposits.
 */

import type { Types } from 'mongoose';

import { Logger } from '../../helpers/loggerHelper';
import CardanoStakingOperation, {
  type CardanoStakingOperationStatus,
  type ICardanoStakingOperation
} from '../../models/cardanoStakingOperationModel';
import type { CardanoProvider } from './cardanoProviderService';
import { CardanoProviderError } from './cardanoProviderService';
import {
  reserveStakingFee,
  type StakingFeeReservationRequest
} from './cardanoStakingBudgetService';
import {
  type BuiltCardanoStakingTransaction,
  buildCardanoStakingTransaction,
  type CardanoStakingPlan
} from './cardanoStakingBuilderService';
import {
  claimKeysOf,
  outpointsOf,
  releaseStakingInputs,
  reserveStakingInputs
} from './cardanoStakingReservationService';
import { encodeSignedTransaction } from './cardanoTxService';
import { outpointOf } from './cardanoUtxoClaimService';

/** How far {@link executeStakingOperation} got. */
export type StakingExecutionOutcome =
  /** Submitted and accepted by the provider. */
  | 'submitted'
  /** Submitted, and the provider's answer did not establish anything. The operation stays live. */
  | 'unknown_submit'
  /** Another operation holds one of the inputs. Rebuild, do not retry. */
  | 'input_collision'
  /** The window has no room. Nothing was built and nothing was claimed. */
  | 'budget_exhausted'
  /** Refused before anything was built: the plan cannot produce a transaction. */
  | 'refused';

export interface StakingExecutionResult {
  outcome: StakingExecutionOutcome;
  operationId: Types.ObjectId;
  transactionId: string | null;
  /** Why it was refused, when it was. */
  reason: string | null;
}

/** Signs the body hash with each key the transaction needs. */
export interface StakingSigner {
  /**
   * @param transactionId - The body hash.
   * @returns One entry per distinct key, public key and signature as hex.
   */
  witnessesFor(transactionId: string): { publicKey: string; signature: string }[];
}

export interface StakingExecutionRequest {
  operation: ICardanoStakingOperation;
  plan: CardanoStakingPlan;
  budget: Omit<StakingFeeReservationRequest, 'amountLovelace' | 'operationId' | 'accountId'>;
  signer: StakingSigner;
  provider: Pick<CardanoProvider, 'submit'>;
  /**
   * Lovelace to hold for the fee before the transaction is built.
   *
   * An estimate on purpose: the exact fee is only known once the body exists, and the window has to
   * be charged before anything is built so that a crash in between over-reserves rather than
   * spending budget nothing recorded. The difference goes back when the operation settles.
   */
  estimatedFeeLovelace: number;
}

/**
 * Moves an operation forward by exactly one step, and records what it did.
 *
 * Safe to call again for the same operation at any point: it reads where the operation actually is
 * and resumes from there rather than starting over.
 *
 * @param request - The operation, its plan, and the collaborators it needs.
 * @returns What happened.
 */
export async function executeStakingOperation(
  request: StakingExecutionRequest
): Promise<StakingExecutionResult> {
  const { operation, plan, signer, provider } = request;
  const operationId = operation._id as Types.ObjectId;

  // Already carries signed bytes: the only correct move is to finish *that* transaction.
  if (operation.signedCborProtected !== null && operation.txId !== null) {
    return resubmit(operation, provider);
  }

  const reservation = await reserveStakingFee({
    ...request.budget,
    accountId: operation.accountId,
    operationId,
    amountLovelace: request.estimatedFeeLovelace
  });
  if (reservation.outcome === 'insufficient_budget' || reservation.outcome === 'invalid_cap') {
    await mark(operationId, 'queued', `budget:${reservation.outcome}`);
    return {
      outcome: 'budget_exhausted',
      operationId,
      transactionId: null,
      reason: reservation.outcome
    };
  }

  let built: BuiltCardanoStakingTransaction;
  try {
    built = buildCardanoStakingTransaction(plan);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await mark(operationId, 'manual_review', reason);
    return { outcome: 'refused', operationId, transactionId: null, reason };
  }

  const claim = await reserveStakingInputs(built, operationId);
  if (claim.outcome === 'collision') {
    // Nothing was signed and nothing was submitted, so the operation goes back to the queue. Its
    // budget reservation stands: releasing it here would need proof the transaction never reached
    // the chain, and there is no transaction yet to prove anything about.
    await mark(operationId, 'queued', 'input_collision');
    return { outcome: 'input_collision', operationId, transactionId: null, reason: null };
  }

  const witnesses = signer.witnessesFor(built.transactionId);
  const signedCbor = encodeSignedTransaction(built.bodyBytes, witnesses);

  // Written **before** the submit, and this is the load-bearing line of the whole module. Without
  // it a process that dies here cannot tell whether the transaction exists, and rebuilding a
  // different one risks a second deposit.
  await CardanoStakingOperation.updateOne(
    { _id: operationId },
    {
      $set: {
        status: 'signed' satisfies CardanoStakingOperationStatus,
        chainOutcome: 'none',
        signedCborProtected: signedCbor,
        txId: built.transactionId,
        ttlSlot: plan.ttlSlot,
        selectedOutpoints: outpointsOf(built),
        networkFeeLovelace: String(built.networkFeeLovelace),
        commercialFeeLovelace: String(built.commercialFeeLovelace),
        actualRegistrationDepositLovelace:
          built.depositLovelace > 0n ? String(built.depositLovelace) : null,
        availableRewardWithdrawalLovelace:
          built.withdrawalLovelace > 0n ? String(built.withdrawalLovelace) : null
      },
      $inc: { attempts: 1 }
    }
  );

  return submit(operationId, built.transactionId, signedCbor, provider);
}

/**
 * Sends a transaction that is already signed and recorded.
 *
 * @param operationId - The operation it belongs to.
 * @param transactionId - Its id.
 * @param signedCbor - The bytes to send, verbatim.
 * @param provider - Where to send them.
 * @returns What happened.
 */
async function submit(
  operationId: Types.ObjectId,
  transactionId: string,
  signedCbor: string,
  provider: Pick<CardanoProvider, 'submit'>
): Promise<StakingExecutionResult> {
  try {
    await provider.submit(signedCbor);
    await CardanoStakingOperation.updateOne(
      { _id: operationId },
      { $set: { status: 'submitted', chainOutcome: 'pending' } }
    );
    return { outcome: 'submitted', operationId, transactionId, reason: null };
  } catch (error) {
    // A refusal is not proof of absence. A node answers "rejected" to a resubmission of a
    // transaction it has already accepted, and a submit that timed out can be refused by the next
    // node asked while the first one propagates it. So every failure here is `unknown`, and only a
    // lookup can settle it.
    const reason = error instanceof CardanoProviderError ? error.failure : 'submit_failed';
    Logger.warn(
      'submitStakingOperation',
      `Cardano staking submit for ${transactionId} did not establish an outcome: ${reason}`
    );
    await CardanoStakingOperation.updateOne(
      { _id: operationId },
      { $set: { status: 'unknown_submit', chainOutcome: 'unknown', errorCode: reason } }
    );
    return { outcome: 'unknown_submit', operationId, transactionId, reason };
  }
}

/**
 * Finishes an operation that was already signed.
 *
 * Resubmits the stored bytes rather than rebuilding, which is what keeps one intent from becoming
 * two transactions.
 *
 * @param operation - The operation, carrying its signed bytes.
 * @param provider - Where to send them.
 * @returns What happened.
 */
async function resubmit(
  operation: ICardanoStakingOperation,
  provider: Pick<CardanoProvider, 'submit'>
): Promise<StakingExecutionResult> {
  return submit(
    operation._id as Types.ObjectId,
    operation.txId as string,
    operation.signedCborProtected as string,
    provider
  );
}

/**
 * Records a step that produced no transaction.
 *
 * @param operationId - The operation.
 * @param status - Where it now stands.
 * @param errorCode - Why.
 */
async function mark(
  operationId: Types.ObjectId,
  status: CardanoStakingOperationStatus,
  errorCode: string
): Promise<void> {
  await CardanoStakingOperation.updateOne(
    { _id: operationId },
    { $set: { status, errorCode }, $inc: { attempts: 1 } }
  );
}

/** What a reconciliation concluded. */
export type StakingReconciliationOutcome =
  | 'confirmed'
  | 'still_pending'
  /** The TTL has passed and the chain does not know the transaction. It can never become valid. */
  | 'absent_past_ttl'
  /** Nothing could be established. The operation stays live and keeps everything it holds. */
  | 'undetermined';

/**
 * Asks the chain what became of a submitted transaction, and settles what can be settled.
 *
 * The only path that frees anything. A transaction is declared absent only when **both** its TTL
 * has passed and a lookup found nothing: past its TTL a Cardano transaction can never become valid,
 * so at that point absence is final rather than merely current.
 *
 * @param operation - The operation to reconcile.
 * @param provider - Where to ask.
 * @param tipSlot - The chain's current slot, from the chain and not from this machine's clock.
 * @returns What was established.
 */
export async function reconcileStakingOperation(
  operation: ICardanoStakingOperation,
  provider: Pick<CardanoProvider, 'statusOf'>,
  tipSlot: number
): Promise<StakingReconciliationOutcome> {
  const operationId = operation._id as Types.ObjectId;
  if (operation.txId === null) return 'undetermined';

  let known: boolean;
  try {
    known = (await provider.statusOf(operation.txId)).known;
  } catch {
    // A provider that cannot answer has not told us the transaction is absent.
    return 'undetermined';
  }

  if (known) {
    await CardanoStakingOperation.updateOne(
      { _id: operationId },
      { $set: { status: 'confirmed', chainOutcome: 'confirmed' } }
    );
    return 'confirmed';
  }

  const ttlPassed = operation.ttlSlot !== null && tipSlot > operation.ttlSlot;
  if (!ttlPassed) return 'still_pending';

  await CardanoStakingOperation.updateOne(
    { _id: operationId },
    {
      $set: {
        status: 'expired_unconfirmed',
        chainOutcome: 'rejected',
        absenceProof: 'ttl_expired_and_absent'
      }
    }
  );

  // Only now, with the proof recorded on the operation, may the inputs go back.
  const released = await releaseStakingInputs(
    operationId,
    operation.selectedOutpoints.map(outpointOf)
  );
  Logger.info(
    'reconcileStakingOperation',
    `Cardano staking operation ${operationId.toHexString()} is absent past its TTL; inputs ${released}`
  );

  return 'absent_past_ttl';
}

/**
 * The claim keys a built transaction holds, for a caller that has to release them by hand.
 *
 * @param built - The built transaction.
 * @returns The outpoints.
 */
export { claimKeysOf };

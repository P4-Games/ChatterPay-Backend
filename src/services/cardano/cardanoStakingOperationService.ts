/**
 * The only way an economic staking operation comes into existence, and what it refuses first.
 *
 * "Economic" here means anything that will become a transaction on chain: a registration, a
 * delegation, a vote delegation, a withdrawal, an exit. Every one of them costs a fee, and several
 * of them move the user's own ada. This module exists so that the preconditions are checked in one
 * place rather than at each call site, because a precondition enforced in four places out of five
 * is not enforced.
 *
 * Three refusals, and the failure each one prevents:
 *
 * - **The schema is not installed.** Uniqueness in this rollout comes entirely from indexes: one
 *   account per stake credential, one live operation per account, one deposit per registration
 *   cycle. Mongo creates a collection implicitly on first insert, without any of them, and the
 *   collections and indexes here are created by hand, so a deployment where that was never done
 *   would accept every write and quietly allow two accounts to claim one deposit. A missing index
 *   is therefore not a performance question here.
 * - **Nothing has read the chain yet.** `onChain.asOf: null` means exactly that — never read. It is
 *   not "registered: false", and it is not "no rewards". Building a registration on it would submit
 *   a certificate for a credential that may already be registered, and building an exit on it would
 *   compute a refund from a deposit nobody has observed.
 * - **No consent, for anything that starts or extends participation.** Leaving is always allowed;
 *   joining on the user's behalf is not.
 */

import { type Types } from 'mongoose';

import { getCardanoStakingConfig } from '../../config/cardanoStakingConfig';
import { Logger } from '../../helpers/loggerHelper';
import CardanoStakingAccount, {
  type ICardanoStakingAccount
} from '../../models/cardanoStakingAccountModel';
import { declaredIndexNames, STAKING_COLLECTIONS } from '../../models/cardanoStakingCollections';
import CardanoStakingOperation, {
  type CardanoStakingOperationKind,
  type ICardanoStakingOperation
} from '../../models/cardanoStakingOperationModel';

/** Why an economic operation was refused. */
export type StakingOperationRefusal =
  | 'indexes_missing'
  | 'no_confirmed_chain_read'
  | 'no_terms_consent'
  | 'opted_out';

export type StakingOperationReadiness =
  | { ok: true }
  | { ok: false; refusal: StakingOperationRefusal; detail: string };

/**
 * Kinds that start or extend the user's participation.
 *
 * Two checks read this list, and they are the two things that may stand in the way of joining: a
 * consent that a deployment requires and does not have, and a decision to leave that the user has
 * already made.
 *
 * Withdrawing, deregistering and exiting are deliberately absent from both. A user must be able to
 * leave whatever the state of a consent record, a reconciliation that has to unwind a registration
 * must not be blocked by one, and a decision to leave must never be a reason to hold on to
 * somebody's money.
 */
const PARTICIPATION_KINDS: readonly CardanoStakingOperationKind[] = [
  'register_and_delegate',
  'redelegate_pool',
  'delegate_vote',
  'register_drep',
  'update_drep',
  'cast_drep_vote'
];

/**
 * Whether the staking schema has been verified in this process.
 *
 * Only a success is remembered. A deployment either has the indexes or it does not, so the answer
 * does not change from one operation to the next and re-reading nine collections before every
 * staking action would be nine round trips for a constant. A *failure* is never cached, so a
 * deployment whose indexes are created while the service is up recovers on the next attempt instead
 * of needing a restart.
 */
let schemaVerified = false;

/**
 * Forgets that the schema was verified.
 *
 * For tests, which drop and rebuild indexes between cases.
 */
export function resetStakingSchemaVerification(): void {
  schemaVerified = false;
}

/**
 * Declared staking indexes that the database does not have.
 *
 * @returns The missing indexes as `collection.index`, empty when every one is in place.
 */
export async function missingStakingIndexes(): Promise<string[]> {
  const missing: string[] = [];

  for (const { model, collection } of STAKING_COLLECTIONS) {
    let present: string[] = [];
    try {
      present = (await model.collection.listIndexes().toArray()).map((index) => String(index.name));
    } catch {
      // The collection does not exist, so none of its indexes do either.
      present = [];
    }

    for (const declared of declaredIndexNames(model)) {
      if (!present.includes(declared)) missing.push(`${collection}.${declared}`);
    }
  }

  return missing;
}

/**
 * Whether an account may have an economic operation created for it right now.
 *
 * @param account - The account the operation would belong to.
 * @param kind - What the operation would do.
 * @returns Readiness, with the reason when it refuses.
 */
export async function checkStakingOperationReadiness(
  account: ICardanoStakingAccount,
  kind: CardanoStakingOperationKind
): Promise<StakingOperationReadiness> {
  if (!schemaVerified) {
    const missing = await missingStakingIndexes();
    if (missing.length > 0) {
      Logger.error(
        'checkStakingOperationReadiness',
        `Cardano staking schema is incomplete; the collections and indexes have to be created by hand before staking runs. Missing: ${missing.join(', ')}`
      );
      return {
        ok: false,
        refusal: 'indexes_missing',
        detail: `missing indexes: ${missing.join(', ')}`
      };
    }
    schemaVerified = true;
  }

  if (account.onChain.asOf === null) {
    return {
      ok: false,
      refusal: 'no_confirmed_chain_read',
      detail: 'onChain.asOf is null: the credential has never been read on chain'
    };
  }

  if (!PARTICIPATION_KINDS.includes(kind)) return { ok: true };

  if (getCardanoStakingConfig().consentRequired && account.termsConsent === null) {
    return {
      ok: false,
      refusal: 'no_terms_consent',
      detail: `${kind} starts or extends participation and no consent is on record`
    };
  }

  // Re-read, and this is the whole point of the check rather than an optimisation.
  //
  // Every caller decided on a snapshot taken earlier — the sweep reads an account, observes it on
  // chain, assembles a plan and only then arrives here — and a user pressing "turn staking off" in
  // that window writes an opt-out that the snapshot cannot know about. Deciding on the stale copy
  // means putting a credential back on chain seconds after its owner asked to take it off, at the
  // sponsor's expense and with a deposit that then has to be recovered again.
  //
  // This is the last point at which that is still catchable: nothing is created, signed or sent
  // before it. Ordering the opt-out write ahead of the exit closes the other half of the same
  // window, and neither half is sufficient alone.
  const current = await CardanoStakingAccount.findById(account._id as Types.ObjectId)
    .select('optOut')
    .lean();
  const optOut = current?.optOut ?? null;
  if (optOut !== null) {
    return {
      ok: false,
      refusal: 'opted_out',
      detail: `${kind} would re-enter a wallet that opted out (${optOut.reason})`
    };
  }

  return { ok: true };
}

/** What an economic operation is being asked to do. */
/**
 * Operation statuses that mean a transaction reached, or may have reached, the chain.
 *
 * What this list is for is counting what ChatterPay has already paid for, so it errs towards
 * counting. `signed` and `unknown_submit` are here because a signed transaction may have been
 * submitted and an unknown one may have landed; `expired_unconfirmed` is here because the attempt
 * was made even where no fee was ultimately taken. `queued`, `executing`, `cancelled` and
 * `rejected` are not: nothing was spent and nothing can land.
 *
 * Counting one attempt too many costs a wallet one sponsored registration it could have had.
 * Counting one too few lets a retry loop spend the sponsor's ada without bound. The second failure
 * is the expensive one, so the ambiguous cases count.
 */
const REACHED_CHAIN_STATUSES = [
  'signed',
  'submitted',
  'unknown_submit',
  'confirmed',
  'expired_unconfirmed',
  'manual_review'
] as const;

/**
 * How many times this credential has been put on chain at ChatterPay's expense, recently.
 *
 * Only registrations. A delegation change or a withdrawal also costs a fee, but neither is a
 * re-entry: what the limit is about is the loop of joining, leaving and joining again, and only the
 * registration reopens it.
 *
 * @param accountId - The staking account.
 * @param windowDays - How far back to look.
 * @param now - The current time, injectable for tests.
 * @returns The count. Zero when the window is zero or negative, since nothing can fall inside it.
 */
export async function countSponsoredRegistrations(
  accountId: Types.ObjectId,
  windowDays: number,
  now: Date = new Date()
): Promise<number> {
  if (!Number.isFinite(windowDays) || windowDays <= 0) return 0;

  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  return CardanoStakingOperation.countDocuments({
    accountId,
    kind: 'register_and_delegate',
    status: { $in: REACHED_CHAIN_STATUSES },
    createdAt: { $gte: since }
  });
}

export interface StakingOperationIntent {
  kind: CardanoStakingOperationKind;
  /** `cron`, or the authenticated channel that asked for it. */
  actor: string;
  /** Unique per network. A retry carrying the same key is the same intent, not a second one. */
  idempotencyKey: string;
  /** Defaults to the account's current cycle. Required when this operation opens a new one. */
  lifecycleId?: string;
  recipientAddress?: string | null;
}

/**
 * Creates an economic operation, or refuses.
 *
 * The operation is created `queued` with `chainOutcome: 'none'`, which the schema reads as **live**:
 * from this moment the account's stake credential is held, and the unique partial index refuses a
 * second one. That is deliberate — the credential is spoken for as soon as an operation exists for
 * it, not only once something has been submitted.
 *
 * @param account - Account the operation belongs to.
 * @param intent - What to do.
 * @returns The created operation.
 * @throws Error `CARDANO_STAKING_REFUSED_<REFUSAL>` when a precondition is not met, and
 *   `CARDANO_STAKING_NO_LIFECYCLE` when neither the intent nor the account names a cycle.
 */
export async function createStakingOperation(
  account: ICardanoStakingAccount,
  intent: StakingOperationIntent
): Promise<ICardanoStakingOperation> {
  const readiness = await checkStakingOperationReadiness(account, intent.kind);
  if (!readiness.ok) {
    throw new Error(`CARDANO_STAKING_REFUSED_${readiness.refusal.toUpperCase()}`);
  }

  const lifecycleId = intent.lifecycleId ?? account.currentLifecycleId;
  if (lifecycleId === null || lifecycleId === undefined) {
    throw new Error('CARDANO_STAKING_NO_LIFECYCLE');
  }

  return CardanoStakingOperation.create({
    accountId: account._id as Types.ObjectId,
    chainId: account.chainId,
    lifecycleId,
    kind: intent.kind,
    actor: intent.actor,
    idempotencyKey: intent.idempotencyKey,
    recipientAddress: intent.recipientAddress ?? null
  });
}

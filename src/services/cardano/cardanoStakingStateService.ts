/**
 * The one state a user is shown, derived rather than assigned.
 *
 * There are two ways to keep a state like this and only one of them survives contact with a chain.
 * Assigning it — writing `submitted` when something is submitted, `active` when something confirms —
 * means every path that touches an operation has to remember to move the account too, and the first
 * one that forgets leaves an account that is registered and delegated sitting on `awaiting_consent`
 * forever. Nothing detects that, because the wrong value is a perfectly valid value.
 *
 * So it is derived instead, from facts that are stored elsewhere and are authoritative: the consent
 * record, the opt-in, the last confirmed snapshot, and whichever operation currently holds the
 * credential. Recomputing it is idempotent and cheap, the sync does it on every pass, and an account
 * whose state is wrong is corrected by the next pass rather than by somebody noticing.
 *
 * The ordering is what encodes the product's meaning, and two of its choices are worth stating.
 *
 * **What is happening beats what is true.** An account being unwound by an exit reads as
 * `exit_submitted`, not as `active`, even though the credential is still registered and still earning
 * at that moment. The user asked to leave; showing them "active" would be answering a different
 * question from the one they asked.
 *
 * **`manual_review` beats everything.** It means an operator is looking at something, and burying it
 * under a cheerful `active` is how a state nobody is watching becomes a state nobody knows about.
 */

import type {
  CardanoStakingAccountState,
  ICardanoStakingAccount
} from '../../models/cardanoStakingAccountModel';
import type {
  CardanoStakingOperationKind,
  CardanoStakingOperationStatus
} from '../../models/cardanoStakingOperationModel';

/** The operation currently holding the credential, as far as this needs to know. */
export interface StakingLiveOperation {
  kind: CardanoStakingOperationKind;
  status: CardanoStakingOperationStatus;
}

/** Kinds that end a registration cycle. */
const EXIT_KINDS: readonly CardanoStakingOperationKind[] = ['deregister', 'exit_and_send_max'];

/** Statuses that mean the transaction is out of our hands. */
const IN_FLIGHT: readonly CardanoStakingOperationStatus[] = ['submitted', 'unknown_submit'];

/** Statuses that mean we are still assembling or signing. */
const PREPARING: readonly CardanoStakingOperationStatus[] = ['queued', 'executing', 'signed'];

/**
 * Whether a wallet clears the bar for enrolment, as the caller already worked out.
 *
 * Passed in rather than recomputed, because the arithmetic needs protocol parameters and an address
 * and this function needs neither. `null` means the caller did not check, which reads as "no opinion"
 * and leaves the state at `awaiting_funds` rather than inventing a conclusion.
 */
export type StakingFundsVerdict = 'sufficient' | 'insufficient' | null;

/**
 * The state to show for an account.
 *
 * @param account - The account, carrying consent, opt-in and the last snapshot.
 * @param live - The operation holding the credential, or `null` when none does.
 * @param funds - Whether the wallet clears the enrolment bar, when the caller knows.
 * @param consentRequired - Whether this deployment requires the terms to have been accepted. Passed
 *   in rather than read here so the derivation stays a pure function of what it is given, and
 *   defaulted to requiring it so a caller that does not know cannot announce a wallet is on its way
 *   in when it is not.
 * @returns The state.
 */
export function deriveStakingAccountState(
  account: ICardanoStakingAccount,
  live: StakingLiveOperation | null,
  funds: StakingFundsVerdict = null,
  consentRequired = true
): CardanoStakingAccountState {
  // First, and not folded in with the rest: an operator is looking at something, and every other
  // branch below would hide that behind a state that reads as normal.
  if (live?.status === 'manual_review') return 'manual_review';

  const onChain = account.onChain;

  if (live !== null && EXIT_KINDS.includes(live.kind)) {
    if (IN_FLIGHT.includes(live.status)) return 'exit_submitted';
    if (PREPARING.includes(live.status)) return 'exit_pending';
  }

  if (live !== null && !EXIT_KINDS.includes(live.kind)) {
    // An account that is already registered and is having something else done to it stays `active`:
    // a vote delegation or a withdrawal does not suspend the position it is operating on.
    if (!onChain.registered) {
      if (IN_FLIGHT.includes(live.status)) return 'submitted';
      if (live.status === 'signed') return 'signing';
      if (PREPARING.includes(live.status)) return 'activation_pending';
    }
  }

  // Registered stays `active` even for a wallet that has decided to leave, because it is: the
  // credential is registered and the stake is earning until the deregistration lands. What the screen
  // needs in order to say something different is the opt-out record itself, which the view carries
  // beside this — a state value cannot express "active, and on the way out" without either lying or
  // growing a variant for every combination.
  if (onChain.registered) return 'active';

  // Not registered, nothing in flight. What is missing decides, and the order is the order the user
  // encounters it in: agree, then switch on, then fund.
  //
  // A wallet that left and has finished leaving reads as `awaiting_consent`, and that is the accurate
  // answer rather than a gap: what it is waiting for *is* a fresh opt-in, which is the only thing that
  // puts it back. The copy the user sees comes from the opt-out record, so "you left on the 3rd" and
  // "start staking" are told apart by the view without the stored state having to encode both.
  // A wallet that left reads this way whatever the deployment's consent setting says, because what
  // it is waiting for really is an explicit opt-in: that is the only thing that puts it back, and
  // automatic enrolment is precisely what an opt-out switched off.
  if ((account.optOut ?? null) !== null) return 'awaiting_consent';

  // Where the terms are not required, never having been asked says nothing about this wallet, so the
  // state falls through to what does say something: whether it has been read, and whether it holds
  // enough. Reporting `awaiting_consent` here would show a wallet the sweep is about to enrol as one
  // that is waiting for the user to do something.
  if (consentRequired) {
    if (account.termsConsent === null) return 'awaiting_consent';
    if (!account.preference.enabled) return 'awaiting_consent';
  }

  // Never read. Not "awaiting funds" — there is no basis for saying anything about the funds — and
  // the sweep refuses to act on it for the same reason.
  if (onChain.asOf === null) return 'reconcile_required';

  return funds === 'sufficient' ? 'activation_pending' : 'awaiting_funds';
}

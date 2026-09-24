/**
 * Deciding what a stake credential needs next, and turning that decision into a buildable plan.
 *
 * Everything upstream of here reads; everything downstream builds, signs and submits. This is the
 * one place that chooses, and it is written so the choice can be examined without a chain, a
 * database or a key: the decision is a pure function of a snapshot, a configuration and a balance.
 *
 * Three rules shape almost every branch.
 *
 * **Nothing is decided without a confirmed read.** `onChain.asOf` being `null` is not "no rewards"
 * and not "not registered" — it is *unknown*, and an economic decision taken on it would be taken on
 * a guess. Every path refuses first and asks questions later.
 *
 * **A credential that is already registered is left registered.** Wallets arrive already staking,
 * because on Cardano the credential belongs to the key and the user may have delegated it years ago
 * somewhere else. Registering again is refused by the ledger, and the only thing attempting it buys
 * is a sponsor fee spent to learn what the snapshot already said.
 *
 * **In Conway, a reward withdrawal requires the credential to have delegated its voting power.**
 * This is the rule that reorders the obvious sequence. A credential that is registered and
 * delegated to a pool but has never delegated a vote — `kind: 'none'`, a real state and not a gap in
 * the data — cannot withdraw at all; the ledger refuses the transaction. So the vote delegation
 * comes first, and until it is settled a withdrawal is not offered rather than being offered and
 * failing. That is why {@link decideAutomaticAction} can answer `delegate_vote` for an account whose
 * user never asked about governance.
 */

import type { CardanoStakingConfig } from '../../config/cardanoStakingConfig';
import type { ICardanoStakingAccount } from '../../models/cardanoStakingAccountModel';
import type { CardanoStakingOperationKind } from '../../models/cardanoStakingOperationModel';
import { assessStakingEnrolment } from './cardanoStakingEligibilityService';
import type {
  CardanoPoolState,
  CardanoStakingProtocolParameters
} from './cardanoStakingProviderService';

/** What the sweep or a request concluded the account needs. */
export type StakingAction = 'none' | CardanoStakingOperationKind;

/** Why nothing is to be done, or why a request cannot be honoured. */
export type StakingDecisionRefusal =
  /** No confirmed on-chain read. Nothing economic may be decided on an unknown. */
  | 'no_confirmed_chain_read'
  /** Staking is off, or its configuration does not hold. */
  | 'staking_disabled'
  /** The user has not accepted the terms, and this action needs them to have. */
  | 'no_terms_consent'
  /** The user has not switched staking on. */
  | 'not_opted_in'
  /**
   * Somebody decided this wallet is out, and nothing puts it back except a fresh opt-in.
   *
   * Distinct from `not_opted_in` because the two have to behave differently. A wallet that was never
   * switched on becomes enrollable the moment it is; a wallet that *left* stays out even though its
   * consent is still on file, its balance still clears the threshold and its address is still on the
   * enrolment list — all three of which otherwise read as reasons to enrol it.
   */
  | 'opted_out'
  /** The wallet does not clear the bar. */
  | 'not_eligible'
  /** Already registered. Registering again is refused by the ledger. */
  | 'already_registered'
  /** Not registered, and this action needs it to be. */
  | 'not_registered'
  /** Nothing to withdraw. */
  | 'no_rewards'
  /** Conway refuses a withdrawal from a credential that has not delegated its vote. */
  | 'vote_delegation_required'
  /** The deposit that would have to be refunded is not known, so an exit cannot be built. */
  | 'deposit_unknown'
  /** An operation is already in flight for this credential. */
  | 'operation_in_flight'
  /** The credential already delegates where it was asked to delegate. */
  | 'already_delegated'
  /** No pool is configured to delegate to. */
  | 'no_pool_configured'
  /** This wallet is not on the list automatic enrolment is confined to. */
  | 'not_allowlisted'
  /**
   * The chain would accept this operation and this deployment cannot produce it.
   *
   * A credential whose keys are not derivable here is read like any other and mutated by nobody. See
   * `cardanoStakingSignerService` for why the two questions are separate.
   */
  | 'signer_unavailable'
  /** The action is not available in this deployment. */
  | 'not_available';

export interface StakingDecision {
  action: StakingAction;
  refusal: StakingDecisionRefusal | null;
  /** Human-readable context for the refusal, when there is any worth carrying. */
  detail: string | null;
}

/**
 * The actions that may not be taken without the user having accepted the terms.
 *
 * Leaving is not among them, and that is deliberate. A user must be able to get their own ada out
 * of a position regardless of what they did or did not accept on the way in, and making an exit
 * conditional on a consent record would strand anyone whose consent was never written — including
 * every wallet that was already staking before this service existed.
 */
const CONSENT_REQUIRED: readonly StakingAction[] = [
  'register_and_delegate',
  'redelegate_pool',
  'delegate_vote',
  'withdraw_rewards',
  'register_drep',
  'update_drep',
  'cast_drep_vote'
];

/**
 * Actions that amount to joining, or to extending participation.
 *
 * Refused for a wallet with a recorded opt-out. What is deliberately **not** here is every way out and
 * every way of getting one's own ada back — `withdraw_rewards`, `deregister`, `exit_and_send_max` —
 * because a decision to leave must never be a reason to hold on to somebody's money.
 */
const REENTRY_KINDS: readonly StakingAction[] = [
  'register_and_delegate',
  'redelegate_pool',
  'delegate_vote',
  'register_drep',
  'update_drep',
  'cast_drep_vote'
];

/** Kinds that exist so the shape is settled and are refused while the flag is off. */
const DREP_OWN_KINDS: readonly StakingAction[] = [
  'register_drep',
  'unregister_drep',
  'update_drep',
  'cast_drep_vote'
];

/** What the decision needs to know beyond the account itself. */
export interface StakingDecisionContext {
  config: CardanoStakingConfig;
  parameters: CardanoStakingProtocolParameters;
  /** The address change returns to, for the minimum-output arithmetic. */
  addressBytes: Uint8Array;
  /** Ada the wallet holds in outputs it can actually spend. */
  spendableLovelace: bigint;
  /** Where the pool it delegates to stands, when it delegates to one and the pool was read. */
  poolState: CardanoPoolState | null;
  /** Whether an operation is already live for this credential. */
  operationInFlight: boolean;
  /**
   * Whether this deployment holds the keys that witness this credential.
   *
   * Required rather than defaulted, and deliberately so: a default of `true` would let any caller
   * that forgot the check declare an unsignable wallet executable, which is the exact failure this
   * field exists to prevent. Resolved by `stakingSignerFor`.
   */
  signerAvailable: boolean;
}

/**
 * What the daily sweep should do with an account, if anything.
 *
 * Answers exactly one action. A credential that needs several things done takes several passes,
 * which is what keeps one transaction from carrying two decisions and makes each of them
 * separately reversible.
 *
 * @param account - The account, carrying its last confirmed snapshot.
 * @param context - Configuration, parameters and what was read about the pool.
 * @returns The action, or `none` with the reason.
 */
export function decideAutomaticAction(
  account: ICardanoStakingAccount,
  context: StakingDecisionContext
): StakingDecision {
  const blocked = commonRefusals(account, context);
  if (blocked !== null) return blocked;

  const onChain = account.onChain;

  // Before the opt-in, the consent, the allowlist and the arithmetic, because each of those on its own
  // reads as a reason to enrol and this is the one fact that outranks all of them. A wallet that left
  // and still has a consent on file, a balance over the threshold and a place on the enrolment list is
  // exactly the wallet that used to get re-enrolled the day after it walked out.
  //
  // One exception, and it is not a weakening: rewards already earned still come back. Leaving is a
  // decision about future participation, not a forfeit of ada that is already the user's.
  if (account.optOut !== null) {
    if (
      onChain.registered &&
      onChain.governanceDelegation !== null &&
      onChain.governanceDelegation.kind !== 'none' &&
      onChain.governanceDelegation.kind !== 'not_registered' &&
      BigInt(onChain.withdrawableRewardsLovelace) > 0n
    ) {
      return act('withdraw_rewards');
    }
    return refuse('opted_out', account.optOut.reason);
  }

  if (!account.preference.enabled) return refuse('not_opted_in');
  if (account.termsConsent === null) return refuse('no_terms_consent');

  if (!onChain.registered) {
    if (context.config.defaultPoolId === null) return refuse('no_pool_configured');
    // The confinement is checked here and not in the eligibility arithmetic, because it is not a
    // statement about the wallet: the wallet may be perfectly enrollable and simply not be one of
    // the ones this deployment has been told to touch yet.
    if (!allowlisted(account, context.config)) return refuse('not_allowlisted');
    const assessment = assessStakingEnrolment(
      context.config,
      context.parameters,
      context.addressBytes,
      context.spendableLovelace
    );
    if (!assessment.eligible) return refuse('not_eligible', assessment.refusal);
    return act('register_and_delegate');
  }

  // Registered already — by this service or by the user somewhere else, which makes no difference
  // to what may be done next. What must not happen is a second registration.

  // Conway first: a credential that has never delegated its vote cannot withdraw anything, so this
  // comes before the withdrawal that the rewards would otherwise call for.
  //
  // Confined, though, and this is the one place where that distinction has teeth. A vote delegation
  // assigns the user's voting power; it is something ChatterPay *initiates*, not something it
  // returns. So the sweep only initiates it for an account this deployment has been told it may
  // enrol. The withdrawal further down is not confined, because that is the user's own money coming
  // back and a rollout setting has no business standing in front of it.
  if (onChain.governanceDelegation === null || onChain.governanceDelegation.kind === 'none') {
    return sweepMayInitiate(account, context.config)
      ? act('delegate_vote')
      : refuse('not_allowlisted', 'delegate_vote');
  }

  // A pool with a retirement on record stops paying. Moving the delegation is the only remedy, and
  // it is the same remedy whether the retirement is scheduled or already in effect.
  if (context.poolState?.retirementScheduled === true) {
    return sweepMayInitiate(account, context.config)
      ? act('redelegate_pool')
      : refuse('not_allowlisted', 'redelegate_pool');
  }

  // Delegated to no pool at all, while registered. Reachable for a credential registered elsewhere
  // and never delegated, and for one whose pool was retired long enough ago to be forgotten.
  if (onChain.poolId === null) {
    if (context.config.defaultPoolId === null) return refuse('no_pool_configured');
    return sweepMayInitiate(account, context.config)
      ? act('redelegate_pool')
      : refuse('not_allowlisted', 'redelegate_pool');
  }

  if (BigInt(onChain.withdrawableRewardsLovelace) > 0n) return act('withdraw_rewards');

  return refuse(null);
}

/**
 * Whether an action a user asked for may be taken.
 *
 * Separate from the sweep because the answers genuinely differ: the sweep decides what is worth
 * doing, a request asks whether something is permitted. An exit is never worth doing on its own and
 * is always permitted; a registration is the reverse.
 *
 * @param account - The account.
 * @param requested - What the user asked for.
 * @param context - Configuration, parameters and what was read about the pool.
 * @returns The action to take, or `none` with the reason it is refused.
 */
export function decideRequestedAction(
  account: ICardanoStakingAccount,
  requested: CardanoStakingOperationKind,
  context: StakingDecisionContext
): StakingDecision {
  const blocked = commonRefusals(account, context);
  if (blocked !== null) return blocked;

  if (DREP_OWN_KINDS.includes(requested) && !context.config.drepOwnEnabled) {
    return refuse('not_available', requested);
  }
  if (CONSENT_REQUIRED.includes(requested) && account.termsConsent === null) {
    return refuse('no_terms_consent');
  }
  // A wallet that left is not re-entered by asking for a participation action. Pressing "delegate my
  // vote" is not an opt-in, and treating it as one would make the recorded decision to leave
  // revocable by any button that happens to need staking to be on. The way back is the opt-in itself.
  if (account.optOut !== null && REENTRY_KINDS.includes(requested)) {
    return refuse('opted_out', account.optOut.reason);
  }

  const onChain = account.onChain;

  switch (requested) {
    case 'register_and_delegate': {
      if (onChain.registered) return refuse('already_registered');
      if (context.config.defaultPoolId === null) return refuse('no_pool_configured');
      // The confinement binds a user asking as well as the sweep. A rollout limited to a handful of
      // test wallets that anybody could opt into by pressing a button is not limited.
      if (!allowlisted(account, context.config)) return refuse('not_allowlisted');
      const assessment = assessStakingEnrolment(
        context.config,
        context.parameters,
        context.addressBytes,
        context.spendableLovelace
      );
      return assessment.eligible
        ? act('register_and_delegate')
        : refuse('not_eligible', assessment.refusal);
    }

    case 'withdraw_rewards': {
      if (!onChain.registered) return refuse('not_registered');
      // The Conway rule, surfaced as its own refusal rather than as "no rewards": the user does have
      // rewards, and what stands between them and the money is a vote delegation nobody mentioned.
      if (onChain.governanceDelegation === null || onChain.governanceDelegation.kind === 'none') {
        return refuse('vote_delegation_required');
      }
      if (BigInt(onChain.withdrawableRewardsLovelace) === 0n) return refuse('no_rewards');
      return act('withdraw_rewards');
    }

    case 'redelegate_pool': {
      if (!onChain.registered) return refuse('not_registered');
      if (context.config.defaultPoolId === null) return refuse('no_pool_configured');
      if (
        onChain.poolId === context.config.defaultPoolId &&
        !context.poolState?.retirementScheduled
      ) {
        return refuse('already_delegated', onChain.poolId);
      }
      return act('redelegate_pool');
    }

    case 'delegate_vote': {
      if (!onChain.registered) return refuse('not_registered');
      return act('delegate_vote');
    }

    case 'deregister':
    case 'exit_and_send_max': {
      if (!onChain.registered) return refuse('not_registered');
      // The refund has to be exact. A deregistration built on a guessed figure does not balance and
      // is refused by the ledger — after a sponsor fee has already been spent to find out.
      if (onChain.depositLovelace === null) return refuse('deposit_unknown');
      // The ledger refuses to deregister a credential whose reward account still holds something, so
      // leaving means emptying it in the same transaction — and Conway refuses that withdrawal from a
      // credential that has not delegated its voting power. Rewards plus no vote delegation is
      // therefore a state that has to be resolved before an exit can be built at all, and saying so
      // is better than offering an exit that the node rejects.
      if (
        BigInt(onChain.withdrawableRewardsLovelace) > 0n &&
        (onChain.governanceDelegation === null || onChain.governanceDelegation.kind === 'none')
      ) {
        return refuse(
          'vote_delegation_required',
          'the reward account must be emptied to deregister'
        );
      }
      return act(requested);
    }

    default:
      return act(requested);
  }
}

/**
 * The refusals that apply whatever is being asked.
 *
 * @param account - The account.
 * @param context - The decision context.
 * @returns A refusal, or `null` when none of these apply.
 */
function commonRefusals(
  account: ICardanoStakingAccount,
  context: StakingDecisionContext
): StakingDecision | null {
  if (!context.config.enabled) return refuse('staking_disabled', context.config.disabledReason);
  // Before the snapshot, because no amount of reading changes the answer. A credential this
  // deployment cannot witness is legible, displayable and immutable: every branch below decides what
  // *should* happen, and none of them can make it happen without a key.
  if (!context.signerAvailable) return refuse('signer_unavailable');
  // The one check that comes before everything else, including "is it registered": without a
  // confirmed read there is no snapshot to reason from, only defaults that happen to look like facts.
  if (account.onChain.asOf === null) return refuse('no_confirmed_chain_read');
  if (context.operationInFlight) return refuse('operation_in_flight');
  return null;
}

/**
 * Whether this wallet is one the enrolment confinement names.
 *
 * @param account - The account.
 * @param config - The staking configuration.
 * @returns `true` when there is no confinement, or when the wallet is named by it.
 */
function allowlisted(account: ICardanoStakingAccount, config: CardanoStakingConfig): boolean {
  if (config.enrolmentAllowlist === null) return true;
  return config.enrolmentAllowlist.includes(account.walletAddress);
}

/**
 * Whether the sweep may start something on this account of its own accord.
 *
 * Two things are true at once and the confinement has to respect both.
 *
 * A rollout limited to a handful of wallets has to actually limit what runs unattended. Registration,
 * vote delegation and re-delegation are all things nobody asked for at the moment they happen, and
 * confining them is the whole point of having a list.
 *
 * But a wallet this deployment *already enrolled* is not a candidate any more, it is a commitment.
 * Dropping it from the list — or widening the list and later narrowing it — must not leave a position
 * ChatterPay opened delegated to a retired pool with nothing coming to fix it. So an account
 * ChatterPay registered stays serviced whatever the list says.
 *
 * Withdrawals and exits never consult this at all. Those return the user's own ada, and a rollout
 * setting is not a reason to hold on to it.
 *
 * @param account - The account.
 * @param config - The staking configuration.
 * @returns `true` when the sweep may initiate an action for this account.
 */
function sweepMayInitiate(account: ICardanoStakingAccount, config: CardanoStakingConfig): boolean {
  if (account.onChain.registrationOrigin === 'chatterpay') return true;
  return allowlisted(account, config);
}

/**
 * A decision to act.
 *
 * @param action - What to do.
 * @returns The decision.
 */
function act(action: StakingAction): StakingDecision {
  return { action, refusal: null, detail: null };
}

/**
 * A decision not to act.
 *
 * @param refusal - Why, or `null` when there is simply nothing to do.
 * @param detail - Extra context worth carrying.
 * @returns The decision.
 */
function refuse(
  refusal: StakingDecisionRefusal | null,
  detail: string | null = null
): StakingDecision {
  return { action: 'none', refusal, detail };
}

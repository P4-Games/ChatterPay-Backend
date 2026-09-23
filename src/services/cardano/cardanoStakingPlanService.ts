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

  if (!account.preference.enabled) return refuse('not_opted_in');
  if (account.termsConsent === null) return refuse('no_terms_consent');

  const onChain = account.onChain;

  if (!onChain.registered) {
    if (context.config.defaultPoolId === null) return refuse('no_pool_configured');
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
  if (onChain.governanceDelegation === null || onChain.governanceDelegation.kind === 'none') {
    return act('delegate_vote');
  }

  // A pool with a retirement on record stops paying. Moving the delegation is the only remedy, and
  // it is the same remedy whether the retirement is scheduled or already in effect.
  if (context.poolState?.retirementScheduled === true) return act('redelegate_pool');

  // Delegated to no pool at all, while registered. Reachable for a credential registered elsewhere
  // and never delegated, and for one whose pool was retired long enough ago to be forgotten.
  if (onChain.poolId === null) {
    if (context.config.defaultPoolId === null) return refuse('no_pool_configured');
    return act('redelegate_pool');
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

  const onChain = account.onChain;

  switch (requested) {
    case 'register_and_delegate': {
      if (onChain.registered) return refuse('already_registered');
      if (context.config.defaultPoolId === null) return refuse('no_pool_configured');
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
  // The one check that comes before everything, including "is it registered": without a confirmed
  // read there is no snapshot to reason from, only defaults that happen to look like facts.
  if (account.onChain.asOf === null) return refuse('no_confirmed_chain_read');
  if (context.operationInFlight) return refuse('operation_in_flight');
  return null;
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

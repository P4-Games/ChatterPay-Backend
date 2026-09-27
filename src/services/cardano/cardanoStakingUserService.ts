/**
 * What a user may see and ask for, and the one rule that shapes every function here.
 *
 * **The wallet is resolved from the identity, never accepted from the caller.** No function in this
 * module takes an address for the wallet being operated on; each one takes a phone number and derives
 * or looks up the wallet that belongs to it. The only address any of them accepts is the *destination*
 * of an exit, which is a recipient and not an authorisation.
 *
 * That is deliberate and it is the difference between a check and a structure. A handler that accepts
 * a wallet and then verifies the caller owns it is one forgotten call away from letting anybody drain
 * anybody; a handler that cannot express "somebody else's wallet" has nothing to forget. The calling
 * routes authenticate the session and look the phone number up themselves, so the browser never
 * supplies it either.
 *
 * Reads and mutations are separated for a second reason. A credential this deployment cannot sign for
 * — a wallet the user brought from elsewhere — is fully readable here and mutable by nothing. See
 * `cardanoStakingSignerService` for why those are two different questions.
 */

import type { Types } from 'mongoose';

import { getCardanoConfig } from '../../config/cardanoConfig';
import { chargesTransferFee, getCardanoFeeConfig } from '../../config/cardanoFeeConfig';
import { loadCardanoStakingConfig } from '../../config/cardanoStakingConfig';
import { SECURITY_PIN_ENABLED } from '../../config/constants';
import { getPhoneNumberFormatted } from '../../helpers/formatHelper';
import { Logger } from '../../helpers/loggerHelper';
import CardanoStakingAccount, {
  type CardanoStakingAccountState,
  type CardanoStakingOptOut,
  type CardanoStakingOptOutReason,
  type ICardanoStakingAccount
} from '../../models/cardanoStakingAccountModel';
import CardanoStakingGovernanceEvent from '../../models/cardanoStakingGovernanceEventModel';
import CardanoStakingOperation, {
  type CardanoStakingOperationKind
} from '../../models/cardanoStakingOperationModel';
import CardanoStakingReward from '../../models/cardanoStakingRewardModel';
import { type IUser, UserModel } from '../../models/userModel';
import { securityService } from '../securityService';
import { chatterPayFeeFor } from './cardanoFeeService';
import {
  type CardanoGovernanceTargetKind,
  governanceTargetCanonical,
  parseGovernanceTarget
} from './cardanoGovernanceTargetService';
import { buildCardanoProvider, type CardanoProvider } from './cardanoProviderService';
import { assembleStakingPlan } from './cardanoStakingAssemblyService';
import {
  assertionIdempotencyKey,
  issuePinGrant,
  pinGrantRequired,
  verifyBffAssertion,
  verifyPinGrant
} from './cardanoStakingAssertionService';
import {
  type CardanoStakingBalance,
  type CardanoStakingBalanceReason,
  resolveStakingBalance
} from './cardanoStakingBalanceService';
import { buildCardanoStakingTransaction } from './cardanoStakingBuilderService';
import {
  executeStakingOperation,
  RECONCILABLE_STATUSES,
  reconcileWhenDue
} from './cardanoStakingLifecycleService';
import { observeStakingAccount } from './cardanoStakingObservationService';
import {
  countSponsoredRegistrations,
  createStakingOperation
} from './cardanoStakingOperationService';
import { decideRequestedAction, type StakingDecisionRefusal } from './cardanoStakingPlanService';
import { buildStakingProvider, type CardanoStakingProvider } from './cardanoStakingProviderService';
import { requestStakingRefresh } from './cardanoStakingRefreshService';
import { selectableStakingUtxos } from './cardanoStakingReservationService';
import { stakingSignerFor } from './cardanoStakingSignerService';
import { deriveStakingAccountState } from './cardanoStakingStateService';

/** The actions a user may ask for through this surface. */
export const USER_REQUESTABLE_ACTIONS: readonly CardanoStakingOperationKind[] = [
  'register_and_delegate',
  'delegate_vote',
  'redelegate_pool',
  'withdraw_rewards',
  'deregister',
  'exit_and_send_max'
];

/** Why a user-facing call was refused. */
export type StakingUserRefusal =
  /** The phone number resolves to no user. */
  | 'user_not_found'
  /** Cardano or staking is off in this deployment. */
  | 'staking_disabled'
  /** No staking account exists yet for this wallet. */
  | 'no_staking_account'
  /** The security gate did not allow the operation, or could not be consulted. */
  | 'security_gate'
  /**
   * The request carried no valid proof that a session was authenticated for it.
   *
   * Holding the internal token is not enough for a staking mutation: the request has to be signed by
   * the BFF, over this user and this action. See `cardanoStakingAssertionService`.
   */
  | 'assertion'
  /** No valid PIN grant for this exact operation. */
  | 'pin_grant'
  /** The action is not one a user may ask for. */
  | 'action_not_allowed'
  /**
   * The governance target is missing, malformed, unreadable, or supplied for an action without one.
   *
   * Separate from `action_not_allowed` because the two are different things for a caller to fix: the
   * action was permitted and what it was aimed at was not usable.
   */
  | 'governance_target'
  /** The decision refused it. Carries the decision's own reason. */
  | 'refused'
  /** The plan could not be assembled. Carries the assembly's reason. */
  | 'not_assembled'
  /** It was submitted and the outcome is not yet established, or it could not be started. */
  | 'not_started';

/** One reward credit, as the user sees it. */
export interface StakingRewardView {
  epoch: number;
  lovelace: string;
  sourceType: string | null;
  observedAt: Date;
}

/** One operation, as the user sees it. */
export interface StakingOperationView {
  kind: CardanoStakingOperationKind;
  status: string;
  chainOutcome: string;
  txId: string | null;
  networkFeeLovelace: string | null;
  createdAt: Date | null;
  /** Whether the chain may still change this. Shown as informative rather than final. */
  settled: boolean;
}

/**
 * The balance as an HTTP response carries it.
 *
 * Identical to `CardanoStakingBalance` except that every lovelace figure is a decimal string. The
 * conversion happens here, at the edge, rather than in the resolver: the arithmetic upstream needs
 * `bigint` because a lovelace figure can exceed what a JavaScript number holds exactly, and
 * `JSON.stringify` throws on a bigint rather than formatting it. A figure that reaches the
 * serialiser unconverted is not a wrong number on screen, it is a 500 on a read-only endpoint.
 *
 * The `unavailable` shape still carries no amounts. That is the property the resolver exists for and
 * it survives the conversion: a zero in that position reads as "the wallet is empty" to anybody who
 * does not check `availability`.
 */
export type StakingBalanceView =
  | {
      availability: 'complete' | 'stale';
      reason: CardanoStakingBalanceReason | null;
      economicallyUsable: boolean;
      utxoLovelace: string;
      spendableLovelace: string;
      userOwnedRefundableDepositLovelace: string;
      withdrawableRewardsLovelace: string;
      pendingRewardsLovelace: string;
      totalAdaLovelace: string;
      asOf: Date | null;
    }
  | {
      availability: 'unavailable';
      reason: CardanoStakingBalanceReason;
      economicallyUsable: false;
    };

/**
 * Converts a balance for transport.
 *
 * @param balance - The balance as the resolver produced it.
 * @returns The same balance with its figures as strings.
 */
function balanceView(balance: CardanoStakingBalance): StakingBalanceView {
  if (balance.availability === 'unavailable') {
    return {
      availability: 'unavailable',
      reason: balance.reason,
      economicallyUsable: false
    };
  }

  return {
    availability: balance.availability,
    reason: balance.reason,
    economicallyUsable: balance.economicallyUsable,
    utxoLovelace: String(balance.utxoLovelace),
    spendableLovelace: String(balance.spendableLovelace),
    userOwnedRefundableDepositLovelace: String(balance.userOwnedRefundableDepositLovelace),
    withdrawableRewardsLovelace: String(balance.withdrawableRewardsLovelace),
    pendingRewardsLovelace: String(balance.pendingRewardsLovelace),
    totalAdaLovelace: String(balance.totalAdaLovelace),
    asOf: balance.asOf
  };
}

/** What the staking screen needs, in one read. */
export interface StakingUserView {
  walletAddress: string;
  rewardAddress: string;
  state: CardanoStakingAccountState;
  optedIn: boolean;
  /**
   * The recorded decision to be out, when there is one.
   *
   * Carried separately from `optedIn` because the screen has to say which of the two it is: a wallet
   * that was never switched on offers to join, and one that left says so and offers to come back.
   */
  optOut: CardanoStakingOptOut | null;
  termsVersion: string | null;
  /** The version this deployment currently asks for, so a change of terms is visible. */
  currentTermsVersion: string;
  /**
   * Whether this deployment requires the terms to have been accepted before enrolling a wallet.
   *
   * A product setting, not a credential: it says which flow the screen is in. False means enrolment
   * is automatic and there is nothing for the user to accept, so a screen offering to join would be
   * offering a step that does not exist.
   */
  consentRequired: boolean;
  /** The balance a wallet must hold before automatic enrolment considers it, in lovelace. */
  minimumEnrolmentLovelace: string;
  registered: boolean;
  registrationOrigin: string;
  poolId: string | null;
  governanceDelegation: unknown;
  balance: StakingBalanceView;
  /** Whether this deployment can sign for the credential at all. */
  signable: boolean;
  /**
   * Whether an authorisation for this user verifies a PIN.
   *
   * True only when `SECURITY_PIN_ENABLED` is on and the user has a PIN set. The screen asks for the
   * PIN when this is true and not otherwise; `pin_status` alone cannot tell it, because it knows
   * nothing about the switch.
   */
  pinRequired: boolean;
  /** When the user's PIN stops being blocked, or `null` when it is not blocked. */
  pinBlockedUntil: Date | null;
  /** Each requestable action, and `null` or the reason it is refused. */
  actions: Record<string, StakingDecisionRefusal | null>;
  rewards: StakingRewardView[];
  operations: StakingOperationView[];
  lastSyncAt: Date | null;
}

/**
 * What the security service reported about a refused PIN.
 *
 * Carried beside a `security_gate` refusal so the screen can say how many attempts are left or until
 * when the PIN is blocked, as the bot does from the same service.
 */
export interface StakingPinRefusal {
  remainingAttempts: number | null;
  blockedUntil: Date | null;
}

export type StakingUserResult<T> =
  | { ok: true; data: T }
  | { ok: false; refusal: StakingUserRefusal; detail: string; pin?: StakingPinRefusal };

/**
 * The actions that mean the user is leaving.
 *
 * Both of them end participation, so both record the decision before they build anything. A withdrawal
 * is not here: taking your rewards out is not leaving, and treating it as such would take a wallet out
 * of staking every time it collected.
 */
const LEAVING_ACTIONS: readonly CardanoStakingOperationKind[] = ['deregister', 'exit_and_send_max'];

/** How many rows the history surfaces carry. */
const HISTORY_LIMIT = 50;

/**
 * The account a phone number owns, with the user it belongs to.
 *
 * The lookup goes phone number → user → account, and never the other way. There is no code path here
 * that starts from an address.
 *
 * @param phoneNumber - The authenticated user's phone number.
 * @returns The pair, or a refusal.
 */
async function resolveOwn(
  phoneNumber: string
): Promise<StakingUserResult<{ user: IUser; account: ICardanoStakingAccount }>> {
  const formatted = getPhoneNumberFormatted(phoneNumber);
  const user = await UserModel.findOne({ phone_number: formatted }).exec();
  if (user === null) {
    return { ok: false, refusal: 'user_not_found', detail: 'no user for that phone number' };
  }

  const { chainId } = getCardanoConfig();
  const account = await CardanoStakingAccount.findOne({ userId: user._id, chainId }).exec();
  if (account === null) {
    return {
      ok: false,
      refusal: 'no_staking_account',
      detail: 'no staking account on this network'
    };
  }

  return { ok: true, data: { user, account } };
}

/** Collaborators a read can be given instead of building its own. For tests. */
export interface StakingReadDependencies {
  base?: CardanoProvider;
  staking?: CardanoStakingProvider;
  now?: Date;
}

/**
 * Settles the account's live operation, if it has one and it is due for a lookup.
 *
 * The dashboard's half of reconciliation. It goes through {@link reconcileWhenDue}, the same entry
 * point and the same policy the sweep uses, so a screen cannot settle anything the sweep would not:
 * three confirmations to confirm, readings spread over the policy's slots to conclude absence, and a
 * provider failure settles nothing. The spacing is claimed in Mongo, so a refresh loop, two tabs or
 * two instances make at most one lookup per interval between them.
 *
 * Only `signed`, `submitted` and `unknown_submit` are looked up. `queued` and `executing` have no
 * transaction on chain yet, and `manual_review` waits for a person; those are shown as stored.
 *
 * An account with no such operation costs nothing here: one indexed Mongo read and no provider call.
 *
 * On confirmation the credential is re-read without its reward history, so the registration, pool
 * and vote delegation on screen match the chain, and the account is marked for a full refresh by the
 * sweep. Balances and rewards are not assumed to have moved with it.
 *
 * @param account - The account.
 * @param intervalMs - The network's spacing between lookups for one operation.
 * @param base - The transfer provider: tip and transaction lookup.
 * @param staking - The staking provider, for the post-confirmation read.
 * @param now - The clock.
 * @returns Whether the stored account changed and should be read again.
 */
export async function settleLiveOperation(
  account: ICardanoStakingAccount,
  intervalMs: number,
  base: Pick<CardanoProvider, 'tip' | 'statusOf'>,
  staking: Pick<CardanoStakingProvider, 'stakeAccount' | 'rewardHistory' | 'registrationHistory'>,
  now: Date = new Date()
): Promise<boolean> {
  const accountId = account._id as Types.ObjectId;
  const live = await CardanoStakingOperation.findOne({
    accountId,
    status: { $in: RECONCILABLE_STATUSES }
  })
    .sort({ createdAt: -1 })
    .select('_id')
    .lean<{ _id: Types.ObjectId } | null>();
  if (live === null) return false;

  const due = await reconcileWhenDue(live._id, base, intervalMs, now);
  if (due.outcome === 'confirmed') {
    await requestStakingRefresh({ accountIds: [accountId] }, 'operation_confirmed', now);
    const fresh = await CardanoStakingAccount.findById(accountId).exec();
    if (fresh !== null) {
      await observeStakingAccount(fresh, staking, now, { includeRewardHistory: false });
    }
    return true;
  }
  if (due.outcome === 'absent_past_ttl' || due.outcome === 'reorg_suspected') {
    await requestStakingRefresh({ accountIds: [accountId] }, 'operation_settled', now);
    return true;
  }
  return false;
}

/** What a screen polling a pending operation needs, without the balance or the actions. */
export interface StakingOperationStatusView {
  state: CardanoStakingAccountState;
  registered: boolean;
  poolId: string | null;
  governanceDelegation: unknown;
  /** The newest operation, live or not, or `null` when the account has none. */
  operation: StakingOperationView | null;
  /** When the snapshot above was read from the chain. */
  asOf: Date | null;
}

/**
 * The light read for a screen waiting on an operation.
 *
 * Settles the live operation when it is due, exactly as {@link getStakingView} does, and returns the
 * operation and the on-chain position — and nothing else. No UTxOs, no protocol parameters, no pool
 * state and no reward history are read, so polling this costs at most one throttled lookup per
 * interval, and nothing at all when no operation is live.
 *
 * @param phoneNumber - The authenticated user's phone number.
 * @param deps - Providers and clock, for tests.
 * @returns The status, or a refusal.
 */
export async function getStakingOperationStatus(
  phoneNumber: string,
  deps: StakingReadDependencies = {}
): Promise<StakingUserResult<StakingOperationStatusView>> {
  const cardano = getCardanoConfig();
  if (!cardano.enabled) {
    return { ok: false, refusal: 'staking_disabled', detail: cardano.disabledReason };
  }

  const own = await resolveOwn(phoneNumber);
  if (!own.ok) return own;

  const config = await loadCardanoStakingConfig(own.data.account.chainId);
  const now = deps.now ?? new Date();
  const changed = await settleLiveOperation(
    own.data.account,
    config.operationStatusCheckIntervalMs,
    deps.base ?? buildCardanoProvider(),
    deps.staking ?? stakingProvider(),
    now
  );
  const account = changed
    ? ((await CardanoStakingAccount.findById(own.data.account._id).exec()) ?? own.data.account)
    : own.data.account;

  const latest = await CardanoStakingOperation.findOne({ accountId: account._id })
    .sort({ createdAt: -1 })
    .lean();
  const live = LIVE_STATUSES.includes(latest?.status ?? 'confirmed') ? latest : null;

  return {
    ok: true,
    data: {
      state: deriveStakingAccountState(
        account,
        live === null ? null : { kind: live.kind, status: live.status },
        null,
        config.consentRequired
      ),
      registered: account.onChain.registered,
      poolId: account.onChain.poolId,
      governanceDelegation: account.onChain.governanceDelegation,
      operation: latest === null ? null : operationView(latest),
      asOf: account.onChain.asOf
    }
  };
}

/** Statuses a screen shows as still in progress. */
const LIVE_STATUSES: readonly string[] = [
  'queued',
  'executing',
  'signed',
  'submitted',
  'unknown_submit',
  'manual_review'
];

/**
 * One operation, as a screen shows it.
 *
 * @param operation - The stored operation.
 * @returns The view.
 */
function operationView(operation: {
  kind: CardanoStakingOperationKind;
  status: string;
  chainOutcome: string;
  txId: string | null;
  networkFeeLovelace: string | null;
}): StakingOperationView {
  return {
    kind: operation.kind,
    status: operation.status,
    chainOutcome: operation.chainOutcome,
    txId: operation.txId,
    networkFeeLovelace: operation.networkFeeLovelace,
    createdAt: (operation as { createdAt?: Date }).createdAt ?? null,
    // An unsettled operation is shown as informative, never as a figure to act on: the chain may
    // still change it, and a screen that presents `pending` as done is a screen that lies briefly.
    settled: operation.chainOutcome === 'confirmed' || operation.chainOutcome === 'rejected'
  };
}

/**
 * The staking screen for the authenticated user's own wallet.
 *
 * Read-only, and it works for a wallet this deployment cannot sign for: the position is shown, and
 * every action reports `signer_unavailable` instead.
 *
 * A live operation is settled first when it is due (see {@link settleLiveOperation}), so an action
 * started from the dashboard shows `pending` straight away and its confirmation without waiting for
 * the sweep.
 *
 * @param phoneNumber - The authenticated user's phone number.
 * @param deps - Providers and clock, for tests.
 * @returns The view, or a refusal.
 */
export async function getStakingView(
  phoneNumber: string,
  deps: StakingReadDependencies = {}
): Promise<StakingUserResult<StakingUserView>> {
  const cardano = getCardanoConfig();
  if (!cardano.enabled) {
    return { ok: false, refusal: 'staking_disabled', detail: cardano.disabledReason };
  }

  const own = await resolveOwn(phoneNumber);
  if (!own.ok) return own;
  const { user } = own.data;

  const config = await loadCardanoStakingConfig(own.data.account.chainId);
  const base = deps.base ?? buildCardanoProvider();
  const staking = deps.staking ?? stakingProvider();

  const changed = await settleLiveOperation(
    own.data.account,
    config.operationStatusCheckIntervalMs,
    base,
    staking,
    deps.now ?? new Date()
  );
  const account = changed
    ? ((await CardanoStakingAccount.findById(own.data.account._id).exec()) ?? own.data.account)
    : own.data.account;

  const balance = await resolveStakingBalance(account, account.walletAddress, base);
  const signer = stakingSignerFor(account, user);

  // Everything the decision needs, gathered once and reused for every action. A screen that asked the
  // provider the same four questions per button would spend its quota on rendering.
  const parameters = await staking.stakingProtocolParameters();
  const utxos = await selectableStakingUtxos(await base.utxosFor(account.walletAddress));
  const spendable = utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
  const poolState =
    account.onChain.poolId === null ? null : await staking.poolState(account.onChain.poolId);
  const live = await CardanoStakingOperation.findOne({
    accountId: account._id as Types.ObjectId,
    status: {
      $in: ['queued', 'executing', 'signed', 'submitted', 'unknown_submit', 'manual_review']
    }
  })
    .sort({ createdAt: -1 })
    .lean();

  const context = {
    config,
    parameters,
    addressBytes: signer.available ? signer.material.user.addressBytes : new Uint8Array(),
    spendableLovelace: spendable,
    poolState,
    operationInFlight: live !== null && live.status !== 'manual_review',
    signerAvailable: signer.available,
    sponsoredRegistrationsInWindow: await countSponsoredRegistrations(
      account._id as Types.ObjectId,
      config.sponsorWindowDays
    )
  };

  const actions: Record<string, StakingDecisionRefusal | null> = {};
  for (const action of USER_REQUESTABLE_ACTIONS) {
    actions[action] = decideRequestedAction(account, action, context).refusal;
  }

  const enrolment = actions.register_and_delegate ?? null;

  const [rewards, operations, pin] = await Promise.all([
    CardanoStakingReward.find({ accountId: account._id })
      .sort({ epoch: -1 })
      .limit(HISTORY_LIMIT)
      .lean(),
    CardanoStakingOperation.find({ accountId: account._id })
      .sort({ createdAt: -1 })
      .limit(HISTORY_LIMIT)
      .lean(),
    stakingPinRequirement(phoneNumber)
  ]);

  return {
    ok: true,
    data: {
      walletAddress: account.walletAddress,
      rewardAddress: account.rewardAddress,
      state: deriveStakingAccountState(
        account,
        live === null ? null : { kind: live.kind, status: live.status },
        // Taken from the decision that was just made for this account rather than left unanswered.
        // Without it every unregistered wallet reads `awaiting_funds`, including one that clears the
        // threshold and is about to be enrolled — which tells the user to send ada they already have.
        // Only these two refusals say anything about the balance; the rest leave no opinion.
        enrolment === null ? 'sufficient' : enrolment === 'not_eligible' ? 'insufficient' : null,
        config.consentRequired
      ),
      optedIn: account.preference.enabled,
      // Normalised: a document written before the field existed carries no `optOut` at all, and the
      // screen must read that as no decision rather than as a wallet that left.
      optOut: account.optOut ?? null,
      termsVersion: account.termsConsent?.version ?? null,
      currentTermsVersion: config.termsVersion,
      consentRequired: config.consentRequired,
      minimumEnrolmentLovelace: String(config.minimumEnrolmentLovelace),
      registered: account.onChain.registered,
      registrationOrigin: account.onChain.registrationOrigin,
      poolId: account.onChain.poolId,
      governanceDelegation: account.onChain.governanceDelegation,
      balance: balanceView(balance),
      signable: signer.available,
      pinRequired: pin.required,
      pinBlockedUntil: pin.blockedUntil,
      actions,
      rewards: rewards.map((reward) => ({
        epoch: reward.epoch,
        lovelace: reward.amountLovelace,
        sourceType: reward.sourceType,
        observedAt: reward.observedAt
      })),
      operations: operations.map((operation) => operationView(operation)),
      lastSyncAt: account.lastSyncAt
    }
  };
}

/**
 * Records the user's acceptance of the terms and their opt-in.
 *
 * Both at once, because they are one decision in the product even though they are two fields: a
 * consent with the switch off stakes nothing, and a switch on without a consent is exactly what the
 * sweep refuses to act on.
 *
 * @param phoneNumber - The authenticated user's phone number.
 * @param accept - `true` to join, `false` to switch off.
 * @param source - Where the acceptance came from, recorded verbatim.
 * @returns The stored preference, or a refusal.
 */
export async function setStakingConsent(
  phoneNumber: string,
  accept: boolean,
  source: string
): Promise<StakingUserResult<{ optedIn: boolean; termsVersion: string | null }>> {
  // Which account this is about is decided by the chain id, and the chain id comes from the
  // configuration. Reading it before anything is written is what keeps an opt-out from landing on
  // an account inferred from a network this deployment could not resolve.
  const cardano = getCardanoConfig();
  if (!cardano.enabled) {
    return { ok: false, refusal: 'staking_disabled', detail: cardano.disabledReason };
  }

  const own = await resolveOwn(phoneNumber);
  if (!own.ok) return own;
  const { account } = own.data;

  const config = await loadCardanoStakingConfig(account.chainId);
  const now = new Date();

  if (!accept) {
    // Switching off is not a withdrawal of consent, and the record is kept. A position that is
    // already on chain does not disappear because the switch moved, and the consent is what says the
    // user agreed to the terms it was opened under.
    //
    // It *is* a recorded decision to be out, though, and that is a separate fact from the flag. The
    // flag alone would leave the wallet indistinguishable from one nobody ever switched on, and the
    // sweep enrols those the moment a consent and a balance line up — both of which are still true
    // here.
    await recordOptOut(account, 'user_request', source);
    return {
      ok: true,
      data: { optedIn: false, termsVersion: account.termsConsent?.version ?? null }
    };
  }

  // Opting in is the direction that needs the settings to be there, and it needs them for a reason
  // the opt-out does not have: what gets written is a consent stamped with the terms version this
  // network is running. A disabled configuration answers `''` for that version, and a consent
  // stamped with nothing is a record that says the user agreed to something unidentifiable — while
  // the same write clears an opt-out they had asked for.
  if (!config.enabled) {
    return { ok: false, refusal: 'staking_disabled', detail: config.disabledReason };
  }

  await CardanoStakingAccount.updateOne(
    { _id: account._id },
    {
      $set: {
        'preference.enabled': true,
        'preference.updatedAt': now,
        termsConsent: { version: config.termsVersion, acceptedAt: now, source },
        // Fixed when the cycle opens and never rewritten while it lasts, so a settings change cannot
        // reassign ownership of a deposit that is already on chain.
        financingMode: account.financingMode ?? 'user',
        currentLifecycleId: account.currentLifecycleId ?? `${String(account._id)}:${now.getTime()}`
      },
      // The one thing that clears a recorded opt-out, and it has to be explicit. Nothing else puts a
      // wallet back in: not a balance arriving, not a sync, not a reconciliation, and not a request
      // for some other action that happens to need staking to be on.
      $unset: { optOut: '' },
      $inc: { 'preference.version': 1 }
    }
  );

  return { ok: true, data: { optedIn: true, termsVersion: config.termsVersion } };
}

/**
 * Records that this wallet is out, and switches staking off.
 *
 * Two writes, in this order, and the order is the point. The opt-out record goes in first because it
 * is the durable decision; a process that dies between the two leaves a wallet that the sweep refuses,
 * which is the residue that matches what the user asked for. The flag alone would not survive the next
 * time a consent and a balance line up.
 *
 * Idempotent. A retry finds the record already there and leaves its timestamp alone, so the moment the
 * decision was taken does not drift forward every time somebody presses the button again.
 *
 * @param account - The account, as read.
 * @param reason - Why it is out.
 * @param source - Where the decision came from.
 */
async function recordOptOut(
  account: ICardanoStakingAccount,
  reason: CardanoStakingOptOutReason,
  source: string
): Promise<void> {
  const now = new Date();

  // Conditional on there being none: the filter is the condition, so two concurrent requests cannot
  // both write one and the first one's timestamp stands.
  await CardanoStakingAccount.updateOne(
    { _id: account._id, optOut: null },
    {
      $set: {
        optOut: {
          at: now,
          reason,
          source: source.slice(0, 60),
          preferenceVersion: account.preference.version
        }
      }
    }
  );

  await CardanoStakingAccount.updateOne(
    { _id: account._id },
    {
      $set: { 'preference.enabled': false, 'preference.updatedAt': now },
      $inc: { 'preference.version': 1 }
    }
  );
}

/** What a started action reports back. */
export interface StakingActionStarted {
  action: CardanoStakingOperationKind;
  operationId: string;
  txId: string | null;
  outcome: string;
}

/**
 * Takes an action the user asked for, on their own wallet.
 *
 * The sequence is fixed and each step can refuse: the security gate, then the decision, then the
 * assembly, then the execution. Nothing is created until all three earlier steps have passed, so a
 * refusal leaves no operation row and no claimed input behind.
 *
 * @param phoneNumber - The authenticated user's phone number.
 * @param action - What they asked for.
 * @param options - The exit destination and where the request came from.
 * @returns What was started, or a refusal.
 */
export async function requestStakingAction(
  phoneNumber: string,
  action: CardanoStakingOperationKind,
  options: {
    recipientAddress?: string | null;
    actor: string;
    /** Signed by the BFF over this user, this action and this governance target. */
    bffAssertion?: string | null;
    /** Issued by `authorizeStakingAction` after the PIN verified for this action and target. */
    pinGrant?: string | null;
    /**
     * Where a vote delegation sends the voting power, as the request carried it.
     *
     * Taken as `unknown` and validated here rather than by the route, so that the one place which
     * decides whether an action may be taken is also the place which decides whether what it is aimed
     * at can be read. A route that pre-parsed it would be a second validator to keep in step.
     */
    governanceTarget?: unknown;
  }
): Promise<StakingUserResult<StakingActionStarted>> {
  if (!USER_REQUESTABLE_ACTIONS.includes(action)) {
    return { ok: false, refusal: 'action_not_allowed', detail: action };
  }

  // Before the assertion, because the assertion is bound to the target: there is nothing to verify
  // against until the target has been read, and an unreadable one is refused either way.
  const parsedTarget = parseGovernanceTarget(options.governanceTarget, action);
  if (!parsedTarget.ok) {
    return {
      ok: false,
      refusal: 'governance_target',
      detail: `${parsedTarget.refusal}: ${parsedTarget.detail}`
    };
  }
  const target = parsedTarget.target;

  const cardano = getCardanoConfig();
  if (!cardano.enabled) {
    return { ok: false, refusal: 'staking_disabled', detail: cardano.disabledReason };
  }

  const recipient = options.recipientAddress ?? null;
  const expectation = {
    sub: phoneNumber,
    act: action,
    rcp: recipient,
    gov: governanceTargetCanonical(target)
  };

  // Before the gate and before any read. Both of these say *who is asking and for what*, and there is
  // no reason to look anything up on behalf of a request that has not established that.
  const asserted = verifyBffAssertion(options.bffAssertion ?? null, expectation);
  if (!asserted.ok) {
    return {
      ok: false,
      refusal: 'assertion',
      detail: `${asserted.rejection}: ${asserted.detail}`
    };
  }

  let grantNonce: string | null = null;
  if (pinGrantRequired()) {
    const granted = verifyPinGrant(options.pinGrant ?? null, expectation);
    if (!granted.ok) {
      return { ok: false, refusal: 'pin_grant', detail: `${granted.rejection}: ${granted.detail}` };
    }
    grantNonce = granted.claims.nonce;
  }

  const gate = await stakingSecurityGate(phoneNumber);
  if (!gate.allowed) {
    return {
      ok: false,
      refusal: 'security_gate',
      detail: gate.reason,
      pin:
        gate.blockedUntil === null
          ? undefined
          : { remainingAttempts: null, blockedUntil: gate.blockedUntil }
    };
  }

  const own = await resolveOwn(phoneNumber);
  if (!own.ok) return own;
  const { user, account } = own.data;

  const config = await loadCardanoStakingConfig(account.chainId);
  const base = buildCardanoProvider();
  const staking = stakingProvider();

  const signer = stakingSignerFor(account, user);
  const utxos = signer.available
    ? await selectableStakingUtxos(await base.utxosFor(account.walletAddress))
    : [];
  const spendable = utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);

  const decision = decideRequestedAction(account, action, {
    config,
    parameters: await staking.stakingProtocolParameters(),
    addressBytes: signer.available ? signer.material.user.addressBytes : new Uint8Array(),
    spendableLovelace: spendable,
    poolState:
      account.onChain.poolId === null ? null : await staking.poolState(account.onChain.poolId),
    operationInFlight: await hasLiveOperation(account._id as Types.ObjectId),
    signerAvailable: signer.available,
    sponsoredRegistrationsInWindow: await countSponsoredRegistrations(
      account._id as Types.ObjectId,
      config.sponsorWindowDays
    ),
    // Only the request path knows what the delegation is aimed at, so only the request path can be
    // told that the credential already delegates there. The sweep passes none and is unaffected.
    governanceTarget: target
  });

  if (decision.action === 'none') {
    return {
      ok: false,
      refusal: 'refused',
      detail: `${decision.refusal ?? 'nothing_to_do'}${decision.detail === null ? '' : `: ${decision.detail}`}`
    };
  }

  const provider = {
    tip: () => base.tip(),
    utxosFor: (address: string) => base.utxosFor(address),
    submit: (cborHex: string) => base.submit(cborHex),
    stakingProtocolParameters: () => staking.stakingProtocolParameters(),
    stakeAccount: (reward: string) => staking.stakeAccount(reward)
  };

  const assembly = await assembleStakingPlan({
    account,
    user,
    action,
    provider,
    recipientAddress: recipient,
    // Left out entirely rather than passed as `undefined` for an action with no target, so the
    // assembler's own default - abstaining, which is what the sweep delegates - stays the default.
    ...(target === null ? {} : { drep: target.drep })
  });
  if (assembly.outcome === 'refused') {
    return {
      ok: false,
      refusal: 'not_assembled',
      detail: `${assembly.refusal}: ${assembly.detail}`
    };
  }

  // Recorded **before** anything is created, signed or sent, and this is the line that closes the
  // re-enrolment hole. The dangerous window is between a deregistration confirming and the account
  // being marked as out: in it the credential is unregistered while the consent, the balance and the
  // allowlist all still say "enrol this", and the next sweep does exactly that — spending a sponsor
  // fee to undo what the user just asked for. Writing the decision first means there is no such
  // window, at the cost of a wallet that is marked out after an attempt that failed to build, which is
  // both the safe residue and one explicit opt-in away from being undone.
  if (LEAVING_ACTIONS.includes(action)) {
    await recordOptOut(account, 'user_exit', options.actor);
  }

  const operation = await createStakingOperation(account, {
    kind: action,
    actor: options.actor,
    // From the grant's nonce when there is one, so a replayed grant collides with the unique index on
    // `(chainId, idempotencyKey)` rather than starting a second operation. Without a grant there is
    // nothing to be single-use about, and the key falls back to being merely unique.
    // Without a grant the key is merely unique, and the target belongs in it anyway: it is what
    // distinguishes two operations that would otherwise read as the same intent.
    idempotencyKey:
      grantNonce === null
        ? `user:${String(account._id)}:${action}:${target?.canonical ?? '-'}:${Date.now()}`
        : assertionIdempotencyKey(grantNonce),
    recipientAddress: options.recipientAddress ?? null,
    governanceTarget: target?.kind ?? null,
    // The canonical CIP-129 form, never the spelling the request used: a record that stored one of
    // three spellings per row could not tell two rows about the same DRep from two about different
    // ones.
    governanceDrepIdCip129: target?.idCip129 ?? null
  });

  const execution = await executeStakingOperation({
    operation,
    plan: assembly.plan,
    signer: assembly.signer,
    provider: { submit: (cborHex: string) => base.submit(cborHex) },
    estimatedFeeLovelace: assembly.estimatedFeeLovelace,
    budget: {
      chainId: cardano.chainId,
      window: new Date().toISOString().slice(0, 10),
      capLovelace: String(config.feeDailyCapLovelace),
      lifecycleId: operation.lifecycleId,
      kind: action
    }
  });

  const started = execution.outcome === 'submitted' || execution.outcome === 'unknown_submit';
  if (!started) {
    return {
      ok: false,
      refusal: 'not_started',
      detail: `${execution.outcome}${execution.reason === null ? '' : `: ${execution.reason}`}`
    };
  }

  return {
    ok: true,
    data: {
      action,
      operationId: String(operation._id),
      txId: execution.transactionId,
      outcome: execution.outcome
    }
  };
}

/** What an authorisation produced. */
export interface StakingAuthorization {
  grant: string;
  expiresAt: Date;
  action: CardanoStakingOperationKind;
  /**
   * The governance target the grant is good for, or `null` when the action has none.
   *
   * Echoed back rather than left implicit: the caller has to present the same target with the action,
   * and a response that named only the action would let a screen believe a grant is more general than
   * it is.
   */
  governanceTarget: CardanoGovernanceTargetKind | null;
}

/**
 * Verifies the PIN for one specific operation and issues a grant for it.
 *
 * This is what makes the PIN specific to an operation rather than a fact about a session. The PIN is
 * checked here, and what the caller gets back is bound by signature to this user, this action and this
 * destination — so it cannot be presented for a different action, and it cannot be used twice, because
 * its nonce becomes the operation's idempotency key.
 *
 * The BFF assertion is required here too. Issuing a grant is not a read: a caller that could ask for
 * one on somebody else's behalf would be able to brute-force their PIN.
 *
 * `SECURITY_PIN_ENABLED` governs the PIN check, and a deployment with the switch off gets a grant
 * without one. That is the same rule the gate and `pinGrantRequired` follow; the assertion is required
 * either way.
 *
 * @param phoneNumber - The authenticated user's phone number.
 * @param action - The action being authorised.
 * @param options - The PIN, the exit destination, the BFF assertion, and where the request came from.
 * @returns The grant, or a refusal.
 */
export async function authorizeStakingAction(
  phoneNumber: string,
  action: CardanoStakingOperationKind,
  options: {
    /** Empty when the user has no PIN set, in which case none is verified. */
    pin: string;
    recipientAddress?: string | null;
    bffAssertion?: string | null;
    actor: string;
    /** Where the vote delegation being authorised sends the voting power. */
    governanceTarget?: unknown;
  }
): Promise<StakingUserResult<StakingAuthorization>> {
  if (!USER_REQUESTABLE_ACTIONS.includes(action)) {
    return { ok: false, refusal: 'action_not_allowed', detail: action };
  }

  // The same gate the action endpoint carries, and read before the PIN for the reason that endpoint
  // reads it before the security gate: a grant is only ever spent on a mutation, so issuing one
  // while the family is off buys nothing, and checking a PIN on the way is a PIN check nobody asked
  // for.
  const cardano = getCardanoConfig();
  if (!cardano.enabled) {
    return { ok: false, refusal: 'staking_disabled', detail: cardano.disabledReason };
  }

  // Read here too, and by the same function: the grant is bound to the target, so a target the action
  // endpoint would refuse must not be able to buy a grant.
  const parsedTarget = parseGovernanceTarget(options.governanceTarget, action);
  if (!parsedTarget.ok) {
    return {
      ok: false,
      refusal: 'governance_target',
      detail: `${parsedTarget.refusal}: ${parsedTarget.detail}`
    };
  }
  const target = parsedTarget.target;

  const recipient = options.recipientAddress ?? null;
  const expectation = {
    sub: phoneNumber,
    act: action,
    rcp: recipient,
    gov: governanceTargetCanonical(target)
  };

  const asserted = verifyBffAssertion(options.bffAssertion ?? null, expectation);
  if (!asserted.ok) {
    return {
      ok: false,
      refusal: 'assertion',
      detail: `${asserted.rejection}: ${asserted.detail}`
    };
  }

  // The account is resolved before the PIN is checked, so a call about a user with no staking account
  // does not become a way to test PINs against the security service.
  const own = await resolveOwn(phoneNumber);
  if (!own.ok) return own;

  // The PIN switch governs this step the way it governs `stakingSecurityGate`,
  // `securityService.getOperationGate` and `pinGrantRequired`. Issuing the grant without a PIN when the
  // switch is off adds no capability: `requestStakingAction` does not require a grant then, so a caller
  // that can reach this can already mutate without presenting one.
  //
  // With the switch on, the user's own PIN decides, by the rule the bot applies before a transfer: a
  // blocked PIN refuses, an active one is verified, and a user who never set one continues without it.
  // The grant is issued in all three allowed cases, because the action endpoint requires it whenever
  // the switch is on.
  if (SECURITY_PIN_ENABLED) {
    const checked = await checkStakingPin(phoneNumber, options.pin, options.actor);
    if (!checked.ok) return checked;
  } else {
    // A decision somebody wrote down, logged every time it is taken, so it cannot be a gap nobody
    // remembers opening.
    Logger.warn(
      'authorizeStakingAction',
      `Cardano staking ${action} authorised without verifying a PIN: SECURITY_PIN_ENABLED is false`
    );
  }

  const issued = issuePinGrant(phoneNumber, action, recipient, governanceTargetCanonical(target));
  if (issued === null) {
    return { ok: false, refusal: 'pin_grant', detail: 'not_configured' };
  }

  return {
    ok: true,
    data: {
      grant: issued.grant,
      expiresAt: issued.expiresAt,
      action,
      governanceTarget: target?.kind ?? null
    }
  };
}

/** A staking position as a conversation needs it: figures and facts, no controls. */
export interface StakingChatSummary {
  /** Whether this wallet is staking at all. */
  staking: boolean;
  state: CardanoStakingAccountState;
  /** `false` when the chain could not be read. Every amount below is then absent. */
  figuresKnown: boolean;
  totalAdaLovelace: string | null;
  utxoLovelace: string | null;
  depositLovelace: string | null;
  withdrawableRewardsLovelace: string | null;
  pendingRewardsLovelace: string | null;
  poolId: string | null;
  voteDelegation: string;
  /** True when rewards exist and Conway will not let them be withdrawn yet. */
  rewardsBlockedByGovernance: boolean;
  /** True when the user has left and only a fresh opt-in brings them back. */
  optedOut: boolean;
  lastReadAt: Date | null;
}

/**
 * The staking position, for a channel that can only ask questions.
 *
 * Deliberately a different surface from {@link getStakingView} rather than a subset of it. What is
 * missing is the `actions` map, and its absence is the design: a channel that receives a list of
 * permitted operations is a channel somebody will eventually wire a button to. This one carries
 * figures and facts and nothing that reads as an offer.
 *
 * The wallet comes from the phone number, as everywhere else here, so a caller cannot ask about
 * somebody else's position by naming it.
 *
 * @param phoneNumber - The authenticated channel user's phone number.
 * @returns The summary, or a refusal.
 */
export async function getStakingChatSummary(
  phoneNumber: string
): Promise<StakingUserResult<StakingChatSummary>> {
  const cardano = getCardanoConfig();
  if (!cardano.enabled) {
    return { ok: false, refusal: 'staking_disabled', detail: cardano.disabledReason };
  }

  const own = await resolveOwn(phoneNumber);
  if (!own.ok) return own;
  const { account } = own.data;

  const balance = await resolveStakingBalance(
    account,
    account.walletAddress,
    buildCardanoProvider()
  );

  const live = await CardanoStakingOperation.findOne({
    accountId: account._id as Types.ObjectId,
    status: {
      $in: ['queued', 'executing', 'signed', 'submitted', 'unknown_submit', 'manual_review']
    }
  })
    .sort({ createdAt: -1 })
    .lean();

  const delegation = account.onChain.governanceDelegation;
  const voteDelegated =
    delegation !== null && delegation.kind !== 'none' && delegation.kind !== 'not_registered';
  const known = balance.availability !== 'unavailable';

  return {
    ok: true,
    data: {
      staking: account.onChain.registered,
      state: deriveStakingAccountState(
        account,
        live === null ? null : { kind: live.kind, status: live.status },
        null,
        (await loadCardanoStakingConfig(account.chainId)).consentRequired
      ),
      // The one thing a chat answer must never get wrong: an unreadable balance has to be absent, not
      // zero. "You have no rewards" and "we could not check" are different answers to give somebody.
      figuresKnown: known,
      totalAdaLovelace: known ? String(balance.totalAdaLovelace) : null,
      utxoLovelace: known ? String(balance.utxoLovelace) : null,
      depositLovelace: known ? String(balance.userOwnedRefundableDepositLovelace) : null,
      withdrawableRewardsLovelace: known ? String(balance.withdrawableRewardsLovelace) : null,
      pendingRewardsLovelace: known ? String(balance.pendingRewardsLovelace) : null,
      poolId: account.onChain.poolId,
      voteDelegation: delegation?.kind ?? 'none',
      rewardsBlockedByGovernance:
        account.onChain.registered &&
        !voteDelegated &&
        BigInt(account.onChain.withdrawableRewardsLovelace) > 0n,
      optedOut: (account.optOut ?? null) !== null,
      lastReadAt: account.onChain.asOf
    }
  };
}

/** What an exit would move. Every figure in lovelace, as a string, because these can be large. */
export interface StakingExitQuote {
  /**
   * The ada sitting in the wallet's own outputs.
   *
   * Not the user's balance, and the distinction is the reason this field exists separately: calling
   * it the balance reads as "everything you have", which is short by exactly the deposit and makes
   * the net figure below look like it came from nowhere.
   */
  utxoLovelace: string;
  /** The registration deposit the ledger returns when the credential is deregistered. */
  refundLovelace: string;
  /** What the user owns before any fee: the outputs plus the deposit coming back. */
  grossLovelace: string;
  /** What the transaction costs the chain. */
  networkFeeLovelace: string;
  /**
   * Who pays it, which for a staking exit is always the sponsor.
   *
   * Carried rather than left to be inferred, because a fee shown next to an amount is read as
   * subtracted from it, and this one is not: the arithmetic below is gross minus the commercial
   * fee, with the network fee coming out of ChatterPay's own inputs. The type has one member
   * because the assembly refuses outright when no sponsor is available, so there is no shape of
   * this quote in which the user pays. Should that ever change, the type changes with it and
   * every screen reading the field is told by the compiler.
   */
  networkFeePaidBy: 'sponsor';
  /** What ChatterPay charges, on the same schedule a transfer of the same ada would pay. */
  commercialFeeLovelace: string;
  /** What actually arrives at the destination. */
  netLovelace: string;
}

/**
 * What sending everything would actually send.
 *
 * Built, not estimated. The transaction is assembled and balanced exactly as the real one would be —
 * same inputs, same certificates, same fee arithmetic — and then thrown away. An estimate would be a
 * second implementation of the balancing rules, and the one number a user is asked to agree to is the
 * worst place for two implementations to disagree.
 *
 * Nothing is created, claimed, signed or submitted. The plan is assembled and built in memory; no
 * operation row exists afterwards and no input is held, so a user who opens the dialog and changes
 * their mind leaves no trace.
 *
 * The commercial fee comes from the same function the transfer path uses, with `isAda` passed rather
 * than inferred from a ticker: a deployment whose catalogue row is named `tADA` would otherwise fall
 * through to a price lookup and quote a fee of zero.
 *
 * @param phoneNumber - The authenticated user's phone number.
 * @param recipientAddress - Where the exit would send.
 * @returns The quote, or a refusal — including every refusal the exit itself would give, so the dialog
 *   reports "you cannot leave yet" before asking for a PIN rather than after.
 */
export async function quoteStakingExit(
  phoneNumber: string,
  recipientAddress: string
): Promise<StakingUserResult<StakingExitQuote>> {
  const cardano = getCardanoConfig();
  if (!cardano.enabled) {
    return { ok: false, refusal: 'staking_disabled', detail: cardano.disabledReason };
  }

  const own = await resolveOwn(phoneNumber);
  if (!own.ok) return own;
  const { user, account } = own.data;

  const config = await loadCardanoStakingConfig(account.chainId);
  const base = buildCardanoProvider();
  const staking = stakingProvider();

  const signer = stakingSignerFor(account, user);
  const utxos = signer.available
    ? await selectableStakingUtxos(await base.utxosFor(account.walletAddress))
    : [];
  const spendable = utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);

  const decision = decideRequestedAction(account, 'exit_and_send_max', {
    config,
    parameters: await staking.stakingProtocolParameters(),
    addressBytes: signer.available ? signer.material.user.addressBytes : new Uint8Array(),
    spendableLovelace: spendable,
    poolState:
      account.onChain.poolId === null ? null : await staking.poolState(account.onChain.poolId),
    operationInFlight: await hasLiveOperation(account._id as Types.ObjectId),
    signerAvailable: signer.available,
    sponsoredRegistrationsInWindow: await countSponsoredRegistrations(
      account._id as Types.ObjectId,
      config.sponsorWindowDays
    )
  });
  if (decision.action === 'none') {
    return { ok: false, refusal: 'refused', detail: decision.refusal ?? 'nothing_to_do' };
  }

  const feeConfig = getCardanoFeeConfig();
  // The same schedule a transfer of the same ada would pay, and nothing bespoke. `isAda` is stated
  // rather than read off a ticker.
  // `isAda` being stated is also what makes the quote unfailable here: an ADA fee converts straight
  // to lovelace and consults no price, so there is no outage this call can run into.
  const feeQuote = chargesTransferFee(feeConfig)
    ? await chatterPayFeeFor(feeConfig, 'ADA', 6, false, true)
    : { ok: true as const, units: 0n };
  const commercialFeeLovelace = feeQuote.ok ? feeQuote.units : 0n;

  const assembly = await assembleStakingPlan({
    account,
    user,
    action: 'exit_and_send_max',
    provider: {
      tip: () => base.tip(),
      utxosFor: (address: string) => base.utxosFor(address),
      stakingProtocolParameters: () => staking.stakingProtocolParameters(),
      stakeAccount: (reward: string) => staking.stakeAccount(reward)
    },
    recipientAddress,
    commercialFeeLovelace
  });
  if (assembly.outcome === 'refused') {
    return {
      ok: false,
      refusal: 'not_assembled',
      detail: `${assembly.refusal}: ${assembly.detail}`
    };
  }

  let built: ReturnType<typeof buildCardanoStakingTransaction>;
  try {
    built = buildCardanoStakingTransaction(assembly.plan);
  } catch (error) {
    // A plan that cannot be balanced is not a quote of zero. It is a reason the exit cannot happen, and
    // the builder's own code says which rule it broke.
    return {
      ok: false,
      refusal: 'not_assembled',
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  return {
    ok: true,
    data: {
      utxoLovelace: String(spendable),
      refundLovelace: String(built.refundLovelace),
      // The two together, because that is what leaving is worth before anybody charges for it. The
      // outputs alone understate it by the deposit, which the user paid and is getting back.
      grossLovelace: String(spendable + built.refundLovelace),
      networkFeeLovelace: String(built.networkFeeLovelace),
      networkFeePaidBy: 'sponsor',
      commercialFeeLovelace: String(built.commercialFeeLovelace),
      netLovelace: String(built.recipientLovelace)
    }
  };
}

/**
 * How long a DRep name read from its metadata is reused.
 *
 * A name changes only when the DRep publishes a new document, and on Blockfrost every read costs one
 * provider call per DRep, so without this the governance tab would spend a call per listed DRep on
 * every load.
 */
const DREP_NAME_TTL_MS = 6 * 60 * 60 * 1000;

/** Entries above which the name cache is emptied rather than grown. */
const DREP_NAME_CACHE_LIMIT = 1_000;

const drepNameCache = new Map<string, { name: string | null; readAt: number }>();

/**
 * The published names of the given DReps, from the cache where it is fresh and from the provider
 * otherwise.
 *
 * A failed read leaves the names it could not get out of the answer and out of the cache, so the
 * next listing asks again. A DRep that published no name is cached as `null`, which is an answer.
 *
 * @param provider - The staking provider.
 * @param ids - Canonical identifiers.
 * @returns The name of each DRep whose metadata was read, `null` for one that published none.
 */
async function drepNames(
  provider: CardanoStakingProvider,
  ids: readonly string[]
): Promise<ReadonlyMap<string, string | null>> {
  const now = Date.now();
  const stale = ids.filter((id) => {
    const cached = drepNameCache.get(id);
    return cached === undefined || now - cached.readAt > DREP_NAME_TTL_MS;
  });

  if (stale.length > 0) {
    try {
      const read = await provider.drepNames(stale);
      if (drepNameCache.size + read.size > DREP_NAME_CACHE_LIMIT) drepNameCache.clear();
      for (const [id, name] of read) drepNameCache.set(id, { name, readAt: now });
    } catch (error) {
      Logger.warn(
        'listGovernanceOptions',
        `Could not read DRep names: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const names = new Map<string, string | null>();
  for (const id of ids) {
    const cached = drepNameCache.get(id);
    if (cached !== undefined) names.set(id, cached.name);
  }
  return names;
}

/**
 * The governance options a user can delegate their vote to.
 *
 * Read-only. Nothing here registers a DRep or casts a vote; those kinds exist in the model so the
 * shape is settled and are refused while the flag is off.
 *
 * Each DRep carries the name it published in its metadata, or `null`. DReps with a name are listed
 * first, each group in the order the chain gave it: a user picks a representative by name, and a
 * list that opens on bare identifiers gives nothing to pick by. Within a group nothing is ranked,
 * because ChatterPay does not recommend a representative.
 *
 * @param limit - How many to list.
 * @returns The options.
 */
export async function listGovernanceOptions(
  limit = 20
): Promise<StakingUserResult<{ predefined: string[]; dreps: unknown[] }>> {
  const cardano = getCardanoConfig();
  if (!cardano.enabled) {
    return { ok: false, refusal: 'staking_disabled', detail: cardano.disabledReason };
  }

  try {
    const provider = stakingProvider();
    const dreps = (await provider.listDReps(limit)).filter((drep) => drep.status === 'active');
    const names = await drepNames(
      provider,
      dreps.map((drep) => drep.idCip129)
    );
    // Mapped rather than passed through: `votingPowerLovelace` is a bigint and would throw in the
    // serialiser, which is a 500 on a read-only endpoint with nothing else wrong with it.
    const listed = dreps.map((drep) => ({
      idCip129: drep.idCip129,
      idCip105: drep.idCip105,
      name: names.get(drep.idCip129) ?? null,
      credential: drep.credential,
      status: drep.status,
      votingPowerLovelace:
        drep.votingPowerLovelace === null ? null : String(drep.votingPowerLovelace)
    }));
    return {
      ok: true,
      data: {
        // Abstaining is the default and the neutral choice, and it is a real delegation on chain
        // rather than the absence of one — which is what unblocks a withdrawal under Conway.
        predefined: ['always_abstain', 'always_no_confidence'],
        dreps: [
          ...listed.filter((drep) => drep.name !== null),
          ...listed.filter((drep) => drep.name === null)
        ]
      }
    };
  } catch (error) {
    Logger.warn(
      'listGovernanceOptions',
      `Could not list DReps: ${error instanceof Error ? error.message : String(error)}`
    );
    return {
      ok: true,
      data: { predefined: ['always_abstain', 'always_no_confidence'], dreps: [] }
    };
  }
}

/**
 * The governance history of the user's own credential.
 *
 * @param phoneNumber - The authenticated user's phone number.
 * @returns The events, newest first.
 */
export async function getGovernanceHistory(
  phoneNumber: string
): Promise<StakingUserResult<{ events: unknown[] }>> {
  const own = await resolveOwn(phoneNumber);
  if (!own.ok) return own;

  const events = await CardanoStakingGovernanceEvent.find({ accountId: own.data.account._id })
    .sort({ requestedAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();

  return { ok: true, data: { events } };
}

/**
 * Whether an operation may proceed, failing **closed** when the gate cannot be consulted.
 *
 * The shared `getOperationGate` answers `allowed: true` both when everything is fine and when it
 * could not tell, and the caller cannot distinguish the two. That trade is defensible for the paths
 * that already depend on it and it is not defensible for an operation that deregisters a credential
 * or moves a whole balance, so this reads the status itself and treats a failure as a refusal.
 *
 * `SECURITY_PIN_ENABLED` being off is still honoured. That is a deployment's explicit decision rather
 * than a failure, and overriding it would make staking unusable in every environment where the PIN is
 * deliberately off — including the one this is tested in.
 *
 * A user with no PIN set is allowed. The PIN is optional per user, and the bot lets such a user
 * operate without one; refusing here would make staking the only operation that requires it.
 *
 * @param phoneNumber - The user.
 * @returns Whether to proceed, why not, and until when a blocked PIN stays blocked.
 */
async function stakingSecurityGate(
  phoneNumber: string
): Promise<{ allowed: boolean; reason: string; blockedUntil: Date | null }> {
  if (!SECURITY_PIN_ENABLED) return { allowed: true, reason: '', blockedUntil: null };

  try {
    const status = await securityService.getSecurityStatus(phoneNumber);
    // `getSecurityStatus` reports `blocked` only while `blocked_until` is in the future.
    if (status.pin_status === 'blocked') {
      return { allowed: false, reason: 'pin_blocked', blockedUntil: status.blocked_until };
    }
    return { allowed: true, reason: '', blockedUntil: null };
  } catch (error) {
    Logger.error(
      'stakingSecurityGate',
      `Refusing a staking mutation because the security gate could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { allowed: false, reason: 'gate_unavailable', blockedUntil: null };
  }
}

/** A refusal, whatever the result type of the call it ends. */
type StakingUserRefused = Extract<StakingUserResult<never>, { ok: false }>;

/**
 * Checks the user's own PIN for an authorisation, with the PIN switch on.
 *
 * The rule the bot applies before a transfer: a blocked PIN refuses, a PIN that is set is verified, and
 * a user who never set one continues without it. Fails closed when the status cannot be read, as
 * {@link stakingSecurityGate} does.
 *
 * An empty PIN from a user who has one is refused without reaching `verifyPin`, so it does not count as
 * a failed attempt: it means the screen did not ask, not that the user got it wrong.
 *
 * @param phoneNumber - The user.
 * @param pin - What the user typed, or an empty string when the screen did not ask.
 * @param actor - Where the request came from, recorded on a failed attempt.
 * @returns `ok`, or the refusal with what the security service reported.
 */
async function checkStakingPin(
  phoneNumber: string,
  pin: string,
  actor: string
): Promise<{ ok: true } | StakingUserRefused> {
  let status: Awaited<ReturnType<typeof securityService.getSecurityStatus>>;
  try {
    status = await securityService.getSecurityStatus(phoneNumber);
  } catch (error) {
    Logger.error(
      'checkStakingPin',
      `Refusing a staking authorisation because the PIN status could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { ok: false, refusal: 'security_gate', detail: 'gate_unavailable' };
  }

  if (status.pin_status === 'not_set') return { ok: true };

  if (status.pin_status === 'blocked') {
    return {
      ok: false,
      refusal: 'security_gate',
      detail: 'blocked',
      pin: { remainingAttempts: null, blockedUntil: status.blocked_until }
    };
  }

  if (pin.trim() === '') {
    return { ok: false, refusal: 'security_gate', detail: 'pin_required' };
  }

  const verified = await securityService.verifyPin(phoneNumber, pin, actor);
  if (verified.ok) return { ok: true };

  // The status travels and the PIN never does. The failed-attempt counter is the security service's
  // to keep; what it reported about it is passed on so the screen can show it.
  return {
    ok: false,
    refusal: 'security_gate',
    detail: verified.status,
    pin: {
      remainingAttempts: verified.remaining_attempts ?? null,
      blockedUntil: verified.blocked_until ?? null
    }
  };
}

/**
 * Whether the screen asks this user for a PIN before an authorisation.
 *
 * Mirrors {@link checkStakingPin}: no PIN is asked for with the switch off or from a user who has none.
 * When the status cannot be read the answer is `true`, so the screen asks and the authorisation, which
 * fails closed on the same read, decides.
 *
 * @param phoneNumber - The user.
 * @returns Whether a PIN is required, and until when it is blocked.
 */
async function stakingPinRequirement(
  phoneNumber: string
): Promise<{ required: boolean; blockedUntil: Date | null }> {
  if (!SECURITY_PIN_ENABLED) return { required: false, blockedUntil: null };

  try {
    const status = await securityService.getSecurityStatus(phoneNumber);
    return {
      required: status.pin_status !== 'not_set',
      blockedUntil: status.pin_status === 'blocked' ? status.blocked_until : null
    };
  } catch (error) {
    Logger.warn(
      'stakingPinRequirement',
      `PIN status could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
    return { required: true, blockedUntil: null };
  }
}

/**
 * Whether an operation already holds this credential.
 *
 * @param accountId - The account.
 * @returns `true` when one is live.
 */
async function hasLiveOperation(accountId: Types.ObjectId): Promise<boolean> {
  const live = await CardanoStakingOperation.countDocuments({
    accountId,
    status: { $in: ['queued', 'executing', 'signed', 'submitted', 'unknown_submit'] }
  });
  return live > 0;
}

/**
 * The staking read surface for the configured provider.
 *
 * @returns The provider.
 */
function stakingProvider(): CardanoStakingProvider {
  const config = getCardanoConfig();
  return buildStakingProvider(
    config.providerKind,
    config.providerUrl,
    config.providerTimeoutMs,
    config.providerApiKey
  );
}

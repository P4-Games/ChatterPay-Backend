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
import { getCardanoStakingConfig } from '../../config/cardanoStakingConfig';
import { SECURITY_PIN_ENABLED } from '../../config/constants';
import { getPhoneNumberFormatted } from '../../helpers/formatHelper';
import { Logger } from '../../helpers/loggerHelper';
import CardanoStakingAccount, {
  type CardanoStakingAccountState,
  type ICardanoStakingAccount
} from '../../models/cardanoStakingAccountModel';
import CardanoStakingGovernanceEvent from '../../models/cardanoStakingGovernanceEventModel';
import CardanoStakingOperation, {
  type CardanoStakingOperationKind
} from '../../models/cardanoStakingOperationModel';
import CardanoStakingReward from '../../models/cardanoStakingRewardModel';
import { type IUser, UserModel } from '../../models/userModel';
import { securityService } from '../securityService';
import { buildCardanoProvider } from './cardanoProviderService';
import { assembleStakingPlan } from './cardanoStakingAssemblyService';
import { type CardanoStakingBalance, resolveStakingBalance } from './cardanoStakingBalanceService';
import { executeStakingOperation } from './cardanoStakingLifecycleService';
import { createStakingOperation } from './cardanoStakingOperationService';
import { decideRequestedAction, type StakingDecisionRefusal } from './cardanoStakingPlanService';
import { buildStakingProvider, type CardanoStakingProvider } from './cardanoStakingProviderService';
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
  /** The action is not one a user may ask for. */
  | 'action_not_allowed'
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

/** What the staking screen needs, in one read. */
export interface StakingUserView {
  walletAddress: string;
  rewardAddress: string;
  state: CardanoStakingAccountState;
  optedIn: boolean;
  termsVersion: string | null;
  /** The version this deployment currently asks for, so a change of terms is visible. */
  currentTermsVersion: string;
  registered: boolean;
  registrationOrigin: string;
  poolId: string | null;
  governanceDelegation: unknown;
  balance: CardanoStakingBalance;
  /** Whether this deployment can sign for the credential at all. */
  signable: boolean;
  /** Each requestable action, and `null` or the reason it is refused. */
  actions: Record<string, StakingDecisionRefusal | null>;
  rewards: StakingRewardView[];
  operations: StakingOperationView[];
  lastSyncAt: Date | null;
}

export type StakingUserResult<T> =
  | { ok: true; data: T }
  | { ok: false; refusal: StakingUserRefusal; detail: string };

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

/**
 * The staking screen for the authenticated user's own wallet.
 *
 * Read-only, and it works for a wallet this deployment cannot sign for: the position is shown, and
 * every action reports `signer_unavailable` instead.
 *
 * @param phoneNumber - The authenticated user's phone number.
 * @returns The view, or a refusal.
 */
export async function getStakingView(
  phoneNumber: string
): Promise<StakingUserResult<StakingUserView>> {
  const cardano = getCardanoConfig();
  if (!cardano.enabled) {
    return { ok: false, refusal: 'staking_disabled', detail: cardano.disabledReason };
  }

  const own = await resolveOwn(phoneNumber);
  if (!own.ok) return own;
  const { user, account } = own.data;

  const config = getCardanoStakingConfig();
  const base = buildCardanoProvider();
  const staking = stakingProvider();

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
    signerAvailable: signer.available
  };

  const actions: Record<string, StakingDecisionRefusal | null> = {};
  for (const action of USER_REQUESTABLE_ACTIONS) {
    actions[action] = decideRequestedAction(account, action, context).refusal;
  }

  const [rewards, operations] = await Promise.all([
    CardanoStakingReward.find({ accountId: account._id })
      .sort({ epoch: -1 })
      .limit(HISTORY_LIMIT)
      .lean(),
    CardanoStakingOperation.find({ accountId: account._id })
      .sort({ createdAt: -1 })
      .limit(HISTORY_LIMIT)
      .lean()
  ]);

  return {
    ok: true,
    data: {
      walletAddress: account.walletAddress,
      rewardAddress: account.rewardAddress,
      state: deriveStakingAccountState(
        account,
        live === null ? null : { kind: live.kind, status: live.status },
        null
      ),
      optedIn: account.preference.enabled,
      termsVersion: account.termsConsent?.version ?? null,
      currentTermsVersion: config.termsVersion,
      registered: account.onChain.registered,
      registrationOrigin: account.onChain.registrationOrigin,
      poolId: account.onChain.poolId,
      governanceDelegation: account.onChain.governanceDelegation,
      balance,
      signable: signer.available,
      actions,
      rewards: rewards.map((reward) => ({
        epoch: reward.epoch,
        lovelace: reward.amountLovelace,
        sourceType: reward.sourceType,
        observedAt: reward.observedAt
      })),
      operations: operations.map((operation) => ({
        kind: operation.kind,
        status: operation.status,
        chainOutcome: operation.chainOutcome,
        txId: operation.txId,
        networkFeeLovelace: operation.networkFeeLovelace,
        createdAt: (operation as { createdAt?: Date }).createdAt ?? null,
        // An unsettled operation is shown as informative, never as a figure to act on: the chain may
        // still change it, and a screen that presents `pending` as done is a screen that lies briefly.
        settled: operation.chainOutcome === 'confirmed' || operation.chainOutcome === 'rejected'
      })),
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
  const own = await resolveOwn(phoneNumber);
  if (!own.ok) return own;
  const { account } = own.data;

  const config = getCardanoStakingConfig();
  const now = new Date();

  if (!accept) {
    // Switching off is not a withdrawal of consent, and the record is kept. A position that is
    // already on chain does not disappear because the switch moved, and the consent is what says the
    // user agreed to the terms it was opened under.
    await CardanoStakingAccount.updateOne(
      { _id: account._id },
      {
        $set: { 'preference.enabled': false, 'preference.updatedAt': now },
        $inc: { 'preference.version': 1 }
      }
    );
    return {
      ok: true,
      data: { optedIn: false, termsVersion: account.termsConsent?.version ?? null }
    };
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
      $inc: { 'preference.version': 1 }
    }
  );

  return { ok: true, data: { optedIn: true, termsVersion: config.termsVersion } };
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
  options: { recipientAddress?: string | null; actor: string }
): Promise<StakingUserResult<StakingActionStarted>> {
  if (!USER_REQUESTABLE_ACTIONS.includes(action)) {
    return { ok: false, refusal: 'action_not_allowed', detail: action };
  }

  const cardano = getCardanoConfig();
  if (!cardano.enabled) {
    return { ok: false, refusal: 'staking_disabled', detail: cardano.disabledReason };
  }

  const gate = await stakingSecurityGate(phoneNumber);
  if (!gate.allowed) return { ok: false, refusal: 'security_gate', detail: gate.reason };

  const own = await resolveOwn(phoneNumber);
  if (!own.ok) return own;
  const { user, account } = own.data;

  const config = getCardanoStakingConfig();
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
    signerAvailable: signer.available
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
    recipientAddress: options.recipientAddress ?? null
  });
  if (assembly.outcome === 'refused') {
    return {
      ok: false,
      refusal: 'not_assembled',
      detail: `${assembly.refusal}: ${assembly.detail}`
    };
  }

  const operation = await createStakingOperation(account, {
    kind: action,
    actor: options.actor,
    idempotencyKey: `user:${String(account._id)}:${action}:${Date.now()}`,
    recipientAddress: options.recipientAddress ?? null
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

/**
 * The governance options a user can delegate their vote to.
 *
 * Read-only. Nothing here registers a DRep or casts a vote; those kinds exist in the model so the
 * shape is settled and are refused while the flag is off.
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
    const dreps = await stakingProvider().listDReps(limit);
    return {
      ok: true,
      data: {
        // Abstaining is the default and the neutral choice, and it is a real delegation on chain
        // rather than the absence of one — which is what unblocks a withdrawal under Conway.
        predefined: ['always_abstain', 'always_no_confidence'],
        dreps: dreps.filter((drep) => drep.status === 'active')
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
 * @param phoneNumber - The user.
 * @returns Whether to proceed, and why not.
 */
async function stakingSecurityGate(
  phoneNumber: string
): Promise<{ allowed: boolean; reason: string }> {
  if (!SECURITY_PIN_ENABLED) return { allowed: true, reason: '' };

  try {
    const status = await securityService.getSecurityStatus(phoneNumber);
    if (status.pin_status === 'not_set') {
      return { allowed: false, reason: 'security_pin_setup' };
    }
    if (
      status.pin_status === 'blocked' &&
      status.blocked_until !== undefined &&
      status.blocked_until !== null &&
      status.blocked_until > new Date()
    ) {
      return { allowed: false, reason: 'pin_blocked' };
    }
    return { allowed: true, reason: '' };
  } catch (error) {
    Logger.error(
      'stakingSecurityGate',
      `Refusing a staking mutation because the security gate could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { allowed: false, reason: 'gate_unavailable' };
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

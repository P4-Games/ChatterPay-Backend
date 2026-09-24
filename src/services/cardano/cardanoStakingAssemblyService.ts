/**
 * Turning a decision into a transaction that can actually be built.
 *
 * `cardanoStakingPlanService` decides *what* an account needs, from a snapshot, with no chain and no
 * keys. This module is the other half: it gathers everything the builder needs and refuses when any
 * of it is missing. The split matters because the two fail for unrelated reasons — a decision fails
 * on rules, an assembly fails on availability — and a refusal that cannot say which of the two it is
 * cannot be acted on.
 *
 * Three things are re-read here rather than taken from the snapshot, and each one is a transaction
 * the ledger would otherwise reject.
 *
 * **The reward balance.** A withdrawal has to name the reward account's *exact* balance. Not an
 * approximation and not a maximum: the ledger compares the figure in the transaction with the one in
 * its own state and refuses anything else. A snapshot read at the last sync is a day old, and a
 * rewards payout at any epoch boundary since then makes it wrong. So the balance is read at assembly
 * time and the plan carries what the chain says now.
 *
 * **Whether the credential is registered.** The decision was taken on a snapshot; between the
 * snapshot and here, the user may have registered the credential from another wallet. Building the
 * registration anyway spends a sponsor fee to be told what a second read would have said for free.
 *
 * **The deposit.** For a registration it comes from the protocol parameters in force this epoch,
 * never from configuration. For an exit it comes from what was *actually paid*, which is a different
 * number as soon as governance changes the parameter — and Cardano refunds what was deposited.
 *
 * Nothing here writes, claims an input or reserves budget. It returns a plan and a signer, and the
 * lifecycle decides whether to use them.
 */

import { getCardanoConfig } from '../../config/cardanoConfig';
import {
  type CardanoStakingConfig,
  getCardanoStakingConfig
} from '../../config/cardanoStakingConfig';
import { Logger } from '../../helpers/loggerHelper';
import type { ICardanoStakingAccount } from '../../models/cardanoStakingAccountModel';
import type { CardanoStakingOperationKind } from '../../models/cardanoStakingOperationModel';
import type { IUser } from '../../models/userModel';
import type { CardanoUtxo } from '../../types/cardanoType';
import {
  decodeCardanoAddress,
  paymentCredential,
  stakeCredentialHex
} from './cardanoAddressService';
import { bytesToHex } from './cardanoCborService';
import type { CardanoDRepTarget } from './cardanoCertificateService';
import type { CardanoProvider } from './cardanoProviderService';
import type {
  CardanoStakingOperationShape,
  CardanoStakingPlan
} from './cardanoStakingBuilderService';
import type { StakingSigner } from './cardanoStakingLifecycleService';
import type { CardanoStakingProvider } from './cardanoStakingProviderService';
import { selectableStakingUtxos } from './cardanoStakingReservationService';
import {
  stakingSignerFor,
  stakingSignerOver,
  stakingSponsorFor
} from './cardanoStakingSignerService';

/**
 * Lovelace held against the fee window before anything is built.
 *
 * An over-estimate on purpose. The real fee is only known once a body exists, and the window has to
 * be charged first so that a crash in between over-reserves rather than spending budget nothing
 * recorded; the difference is returned when the operation settles. A staking transaction runs a few
 * hundred bytes with three witnesses, which is well under a tenth of this on Preprod parameters.
 */
export const STAKING_FEE_ESTIMATE_LOVELACE = 500_000;

/** The default vote delegation, when the caller names none. */
const DEFAULT_DREP: CardanoDRepTarget = { kind: 'always_abstain' };

/** What assembly needs to read. */
export type StakingAssemblyProvider = Pick<CardanoProvider, 'tip' | 'utxosFor'> &
  Pick<CardanoStakingProvider, 'stakingProtocolParameters' | 'stakeAccount'>;

/** Why a decided action could not be assembled into a buildable plan. */
export type StakingAssemblyRefusal =
  /** The action has no transaction shape: nothing here builds a DRep of our own. */
  | 'unsupported_action'
  /** This deployment does not hold the keys for the credential. */
  | 'signer_unavailable'
  /** No sponsor is available to pay the network fee. */
  | 'sponsor_unavailable'
  /** The sponsor holds nothing spendable. */
  | 'sponsor_empty'
  /** The user's address holds no output this operation may select. */
  | 'no_spendable_inputs'
  /** A chain read failed, so the figures the transaction needs are unknown. */
  | 'provider_unavailable'
  /** The claim store could not be read, so selecting inputs could double-spend another operation. */
  | 'claim_store_unavailable'
  /** No pool to delegate to. */
  | 'no_pool_configured'
  /** The refundable deposit is not known, so an exit cannot balance. */
  | 'deposit_unknown'
  /** The exit has nowhere to send what is left. */
  | 'recipient_invalid'
  /** The chain says registered and the action assumed otherwise. */
  | 'already_registered'
  /** The chain says not registered and the action assumed otherwise. */
  | 'not_registered'
  /** The rewards the decision was taken on are no longer there. */
  | 'no_rewards'
  /** Conway refuses a withdrawal, and therefore an exit that has to empty the account, without one. */
  | 'vote_delegation_required';

export interface StakingAssemblyRequest {
  account: ICardanoStakingAccount;
  /** The user the credential is derived from. */
  user: IUser;
  /** What was decided. */
  action: CardanoStakingOperationKind;
  provider: StakingAssemblyProvider;
  /** Where an exit sends what is left. Required for `exit_and_send_max` and ignored otherwise. */
  recipientAddress?: string | null;
  /** ChatterPay's commercial fee on an exit, from the existing fee service. */
  commercialFeeLovelace?: bigint;
  /** Vote delegation target. Defaults to abstaining, which participates in nothing. */
  drep?: CardanoDRepTarget;
  /** Overrides the environment's staking configuration. For tests. */
  config?: CardanoStakingConfig;
}

export type StakingAssemblyResult =
  | {
      outcome: 'assembled';
      plan: CardanoStakingPlan;
      signer: StakingSigner;
      /** Lovelace to hold against the fee window before building. */
      estimatedFeeLovelace: number;
    }
  | { outcome: 'refused'; refusal: StakingAssemblyRefusal; detail: string };

/** The transaction shape each action is built as, or `null` when it has none. */
const SHAPE_OF: Partial<Record<CardanoStakingOperationKind, CardanoStakingOperationShape>> = {
  register_and_delegate: 'register_and_delegate',
  redelegate_pool: 'redelegate_pool',
  delegate_vote: 'delegate_vote',
  withdraw_rewards: 'withdraw_rewards',
  deregister: 'deregister',
  exit_and_send_max: 'exit_and_send_max'
};

/**
 * Builds the plan for a decided action, or says what is missing.
 *
 * @param request - The account, the action, and where to read from.
 * @returns The plan and a signer over the keys it needs, or a refusal.
 */
export async function assembleStakingPlan(
  request: StakingAssemblyRequest
): Promise<StakingAssemblyResult> {
  const { account, user, provider } = request;
  const shape = SHAPE_OF[request.action];
  if (shape === undefined) return refuse('unsupported_action', request.action);

  const config = request.config ?? getCardanoStakingConfig();

  // The signer first, before a single chain call. A credential this deployment cannot witness is not
  // going to become signable further down, and asking a provider four questions to arrive at the
  // same refusal spends quota to learn nothing.
  const signerAvailability = stakingSignerFor(account, user);
  if (!signerAvailability.available) {
    return refuse(
      'signer_unavailable',
      `${signerAvailability.reason}: ${signerAvailability.detail}`
    );
  }
  const material = signerAvailability.material;

  const sponsorAvailability = stakingSponsorFor();
  if (!sponsorAvailability.available) {
    return refuse(
      'sponsor_unavailable',
      `${sponsorAvailability.reason}: ${sponsorAvailability.detail}`
    );
  }
  const sponsor = sponsorAvailability.account;

  let reads: ChainReads;
  try {
    reads = await readChain(provider, account);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    Logger.warn(
      'assembleStakingPlan',
      `Cardano staking assembly could not read the chain: ${detail}`
    );
    return refuse('provider_unavailable', detail);
  }

  // Re-checked against what was just read, not against the snapshot the decision used. The window
  // between the two is a whole sync interval wide, and a registration that happened inside it is
  // exactly the case that costs a fee to discover the expensive way.
  if (request.action === 'register_and_delegate' && reads.registered) {
    return refuse('already_registered', 'the chain reports the credential registered');
  }
  if (request.action !== 'register_and_delegate' && !reads.registered) {
    return refuse('not_registered', 'the chain reports the credential unregistered');
  }

  let userUtxos: readonly CardanoUtxo[];
  let sponsorUtxos: readonly CardanoUtxo[];
  try {
    userUtxos = await selectableStakingUtxos(await provider.utxosFor(account.walletAddress));
    sponsorUtxos = await selectableStakingUtxos(await provider.utxosFor(sponsor.address));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail === 'CARDANO_CLAIM_STORE_UNAVAILABLE')
      return refuse('claim_store_unavailable', detail);
    return refuse('provider_unavailable', detail);
  }

  // A withdrawal is the one shape that can run without the user contributing an input: the sponsor
  // pays the fee and the rewards arrive from the reward account. Everything else spends the user's
  // outputs, and a deposit cannot come from nowhere.
  if (userUtxos.length === 0 && request.action !== 'withdraw_rewards') {
    return refuse('no_spendable_inputs', `${account.walletAddress} has no selectable output`);
  }
  if (sponsorUtxos.length === 0) {
    return refuse('sponsor_empty', `${sponsor.address} has no selectable output`);
  }

  const amounts = resolveAmounts(request, config, reads);
  if ('refusal' in amounts) return refuse(amounts.refusal, amounts.detail);

  const { ttlSlots } = getCardanoConfig();

  const plan: CardanoStakingPlan = {
    shape,
    parameters: reads.parameters,
    ttlSlot: reads.tipSlot + ttlSlots,

    userAddressBytes: material.user.addressBytes,
    userUtxos,
    userPaymentKeyHash: bytesToHex(paymentCredential(material.user.publicKey)),
    userStakeKeyHash: stakeCredentialHex(material.user.stakePublicKey),
    stakeCredential: { type: 'key_hash', hashHex: account.stakeCredentialHex },
    rewardAddress: account.rewardAddress,

    sponsorAddressBytes: sponsor.addressBytes,
    sponsorUtxos,
    sponsorPaymentKeyHash: bytesToHex(paymentCredential(sponsor.publicKey)),

    ...amounts.plan
  };

  return {
    outcome: 'assembled',
    plan,
    signer: stakingSignerOver(material, sponsorAvailability.walletId),
    estimatedFeeLovelace: STAKING_FEE_ESTIMATE_LOVELACE
  };
}

/** What one round of reads established. */
interface ChainReads {
  tipSlot: number;
  parameters: Awaited<ReturnType<CardanoStakingProvider['stakingProtocolParameters']>>;
  registered: boolean;
  /** The reward account's balance right now, which is the only figure a withdrawal may name. */
  withdrawableRewardsLovelace: bigint;
  /** Whether the credential has delegated its voting power, which Conway requires for a withdrawal. */
  voteDelegated: boolean;
}

/**
 * Reads everything the plan's figures come from, in one place.
 *
 * @param provider - Where to read.
 * @param account - The account being assembled for.
 * @returns The readings.
 * @throws Whatever the provider throws. Classified by the caller.
 */
async function readChain(
  provider: StakingAssemblyProvider,
  account: ICardanoStakingAccount
): Promise<ChainReads> {
  const [tip, parameters, stakeAccount] = await Promise.all([
    provider.tip(),
    provider.stakingProtocolParameters(),
    provider.stakeAccount(account.rewardAddress)
  ]);

  const kind = stakeAccount.governanceDelegation.kind;
  return {
    tipSlot: tip.slot,
    parameters,
    registered: stakeAccount.registered,
    withdrawableRewardsLovelace: stakeAccount.withdrawableRewardsLovelace,
    voteDelegated: kind !== 'none' && kind !== 'not_registered'
  };
}

/** The amount fields of a plan, or why they cannot be resolved. */
type ResolvedAmounts =
  | { plan: Partial<CardanoStakingPlan> }
  | { refusal: StakingAssemblyRefusal; detail: string };

/**
 * The amounts and targets one shape needs.
 *
 * @param request - The assembly request.
 * @param config - Staking configuration, for the pool.
 * @param reads - What the chain says right now.
 * @returns The plan fields, or a refusal.
 */
function resolveAmounts(
  request: StakingAssemblyRequest,
  config: CardanoStakingConfig,
  reads: ChainReads
): ResolvedAmounts {
  const drep = request.drep ?? DEFAULT_DREP;

  switch (request.action) {
    case 'register_and_delegate': {
      if (config.defaultPoolId === null) return { refusal: 'no_pool_configured', detail: '' };
      // The deposit comes from this epoch's parameters and from nowhere else. It is governable, it
      // changes without anything restarting, and a certificate that names a stale figure does not
      // balance.
      return {
        plan: {
          depositLovelace: reads.parameters.stakeAddressDeposit,
          poolId: config.defaultPoolId,
          drep
        }
      };
    }

    case 'redelegate_pool': {
      if (config.defaultPoolId === null) return { refusal: 'no_pool_configured', detail: '' };
      return { plan: { poolId: config.defaultPoolId } };
    }

    case 'delegate_vote':
      return { plan: { drep } };

    case 'withdraw_rewards': {
      if (!reads.voteDelegated) return { refusal: 'vote_delegation_required', detail: '' };
      if (reads.withdrawableRewardsLovelace <= 0n) {
        return { refusal: 'no_rewards', detail: 'the reward account is empty as of this read' };
      }
      return { plan: { withdrawalLovelace: reads.withdrawableRewardsLovelace } };
    }

    case 'deregister':
    case 'exit_and_send_max': {
      const recorded = request.account.onChain.depositLovelace;
      if (recorded === null) {
        return {
          refusal: 'deposit_unknown',
          detail: 'the deposit actually paid at registration is not on record'
        };
      }

      // The ledger refuses to deregister a credential whose reward account still holds something, so
      // an exit has to empty it in the same transaction — and Conway refuses that withdrawal unless
      // the credential has delegated its voting power. An account with rewards and no vote delegation
      // therefore cannot leave until the delegation settles, which is a state to report rather than a
      // transaction to attempt. Carrying the delegation certificate in the same body might resolve it
      // and is not done here: whether the withdrawal is validated before or after the certificates
      // applies is a ledger detail this has not been tested against a node.
      if (reads.withdrawableRewardsLovelace > 0n && !reads.voteDelegated) {
        return {
          refusal: 'vote_delegation_required',
          detail:
            'the reward account must be emptied to deregister, and Conway blocks the withdrawal'
        };
      }

      const amounts: Partial<CardanoStakingPlan> = {
        refundLovelace: BigInt(recorded),
        withdrawalLovelace: reads.withdrawableRewardsLovelace
      };

      if (request.action === 'deregister') return { plan: amounts };

      const recipient = (request.recipientAddress ?? '').trim();
      const decoded = recipient === '' ? null : decodeCardanoAddress(recipient);
      if (decoded === null)
        return { refusal: 'recipient_invalid', detail: 'no usable destination' };

      return {
        plan: {
          ...amounts,
          recipientAddressBytes: decoded.payload,
          commercialFeeLovelace: request.commercialFeeLovelace ?? 0n
        }
      };
    }

    default:
      return { refusal: 'unsupported_action', detail: request.action };
  }
}

/**
 * A refusal.
 *
 * @param refusal - Why.
 * @param detail - What is diagnosable about it.
 * @returns The result.
 */
function refuse(refusal: StakingAssemblyRefusal, detail: string): StakingAssemblyResult {
  return { outcome: 'refused', refusal, detail };
}

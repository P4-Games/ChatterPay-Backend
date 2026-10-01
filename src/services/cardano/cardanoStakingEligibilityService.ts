/**
 * Whether a wallet can be enrolled, and whether this deployment is allowed to enrol it automatically.
 *
 * Two different questions, and keeping them apart is the point of the module.
 *
 * The first is about the wallet: does it hold enough ada to register a stake credential and still
 * have a usable output afterwards. That has a hard floor, and the floor is arithmetic over protocol
 * parameters read from the chain — the registration deposit, the minimum an output must carry to
 * exist, and enough left over that the wallet is not emptied to the last lovelace by its own
 * enrolment.
 *
 * The second is about the configuration: the product sets a threshold, and that threshold is a
 * decision about what is worth doing rather than about what is possible. It can sit anywhere above
 * the floor. What it must never do is sit **below** it, because then automatic enrolment would
 * select wallets that cannot pay, build transactions for them, and have those transactions refused
 * by the ledger after a sponsor fee has already been reserved and spent.
 *
 * So a configured threshold below the chain's floor does not get quietly raised. It turns automatic
 * enrolment off and says why. Raising it silently would hide a misconfiguration behind behaviour
 * that looks correct, and the configured number is somebody's decision — the right response to a
 * decision that no longer holds is to stop and report, not to substitute one.
 *
 * This is also the check that the Preprod gate is for: the floor cannot be known without reading a
 * real chain, so until a real run has produced real parameters, the threshold is unvalidated and
 * {@link stakingEnrolmentReadiness} is what says so.
 */

import type { CardanoStakingConfig } from '../../config/cardanoStakingConfig';
import type { CardanoStakingProtocolParameters } from './cardanoStakingProviderService';
import { minimumAdaFor } from './cardanoTxService';

/**
 * Lovelace left over, beyond the deposit and a surviving output, before enrolment is worth doing.
 *
 * Not a ledger rule. It exists because a wallet enrolled at the exact arithmetic minimum has a
 * balance of zero afterwards and cannot pay for anything at all — including, eventually, its own
 * exit, if the sponsor's budget is exhausted when it asks. One ada is the margin that keeps an
 * enrolment from being the last thing a wallet can do.
 */
const ENROLMENT_HEADROOM_LOVELACE = 1_000_000n;

/** Why a wallet cannot be enrolled, or why automatic enrolment is not allowed. */
export type StakingEnrolmentRefusal =
  /** The configured threshold is below what the chain makes possible. */
  | 'threshold_below_chain_floor'
  /** Staking is switched off, or misconfigured. */
  | 'staking_disabled'
  /** The wallet holds less than the configured threshold. */
  | 'below_threshold'
  /** The wallet holds less than the chain's own floor, whatever the threshold says. */
  | 'below_chain_floor';

/** What the chain makes possible, and what the configuration asks for. */
export interface StakingEnrolmentReadiness {
  /** Whether automatic enrolment may run at all. */
  allowed: boolean;
  refusal: StakingEnrolmentRefusal | null;
  /** The least a wallet could hold and still be enrolled, derived from live parameters. */
  chainFloorLovelace: bigint;
  /** What the configuration asks for. */
  configuredThresholdLovelace: bigint;
  /** What a wallet is actually measured against: the configuration, never below the floor. */
  effectiveThresholdLovelace: bigint;
}

/**
 * The least a wallet can hold and still complete an enrolment.
 *
 * Derived rather than configured, and derived from parameters read this epoch rather than from a
 * remembered number: the deposit is governable, and the cost of an output that has to keep existing
 * moves with `coinsPerUtxoByte`.
 *
 * @param parameters - Protocol parameters as read from the chain.
 * @param addressBytes - The address change returns to. Its bytes, not its length: the minimum an
 *   output must carry is computed from the serialized output, and the address is most of it.
 * @returns The floor, in lovelace.
 */
export function stakingChainFloorLovelace(
  parameters: CardanoStakingProtocolParameters,
  addressBytes: Uint8Array
): bigint {
  // The deposit leaves the wallet and comes back only on deregistration; the change output has to
  // clear its own minimum to exist at all; and the headroom is what keeps enrolment from being the
  // last thing the wallet can afford.
  return (
    parameters.stakeAddressDeposit +
    minimumAdaFor(addressBytes, [], parameters.coinsPerUtxoByte) +
    ENROLMENT_HEADROOM_LOVELACE
  );
}

/**
 * Whether automatic enrolment may run, given what the chain says and what was configured.
 *
 * @param config - The staking configuration.
 * @param parameters - Protocol parameters as read from the chain.
 * @param addressBytes - The address change returns to.
 * @returns What is allowed, and the two thresholds side by side so a caller can report both.
 */
export function stakingEnrolmentReadiness(
  config: CardanoStakingConfig,
  parameters: CardanoStakingProtocolParameters,
  addressBytes: Uint8Array
): StakingEnrolmentReadiness {
  const chainFloorLovelace = stakingChainFloorLovelace(parameters, addressBytes);
  const configuredThresholdLovelace = config.minimumEnrolmentLovelace;

  if (!config.enabled) {
    return {
      allowed: false,
      refusal: 'staking_disabled',
      chainFloorLovelace,
      configuredThresholdLovelace,
      effectiveThresholdLovelace: chainFloorLovelace
    };
  }

  if (configuredThresholdLovelace < chainFloorLovelace) {
    // Reported, not corrected. A threshold that no longer clears the chain's floor is a decision
    // that has stopped holding, and substituting one silently would enrol wallets somebody meant to
    // exclude — while looking, from the outside, as though the configuration were being honoured.
    return {
      allowed: false,
      refusal: 'threshold_below_chain_floor',
      chainFloorLovelace,
      configuredThresholdLovelace,
      effectiveThresholdLovelace: chainFloorLovelace
    };
  }

  return {
    allowed: true,
    refusal: null,
    chainFloorLovelace,
    configuredThresholdLovelace,
    effectiveThresholdLovelace: configuredThresholdLovelace
  };
}

/** Whether one wallet clears the bar. */
export interface StakingEnrolmentAssessment {
  eligible: boolean;
  refusal: StakingEnrolmentRefusal | null;
  readiness: StakingEnrolmentReadiness;
}

/**
 * Whether a given wallet may be enrolled automatically.
 *
 * @param config - The staking configuration.
 * @param parameters - Protocol parameters as read from the chain.
 * @param addressBytes - The address change returns to.
 * @param spendableLovelace - What the wallet holds in outputs it can actually spend. Ada locked
 *   behind native assets does not count: it cannot pay a deposit without moving the tokens too.
 * @returns Whether it is eligible, and why not when it is not.
 */
export function assessStakingEnrolment(
  config: CardanoStakingConfig,
  parameters: CardanoStakingProtocolParameters,
  addressBytes: Uint8Array,
  spendableLovelace: bigint
): StakingEnrolmentAssessment {
  const readiness = stakingEnrolmentReadiness(config, parameters, addressBytes);
  if (!readiness.allowed) return { eligible: false, refusal: readiness.refusal, readiness };

  if (spendableLovelace < readiness.chainFloorLovelace) {
    return { eligible: false, refusal: 'below_chain_floor', readiness };
  }
  if (spendableLovelace < readiness.effectiveThresholdLovelace) {
    return { eligible: false, refusal: 'below_threshold', readiness };
  }
  return { eligible: true, refusal: null, readiness };
}

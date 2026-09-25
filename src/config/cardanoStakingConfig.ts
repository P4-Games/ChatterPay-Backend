/**
 * What this network was told about staking, and the line between a setting and a chain rule.
 *
 * That line is the whole reason this module is separate from `cardanoConfig`. Two numbers here look
 * alike and are not:
 *
 * - The **registration deposit** is a protocol parameter. It is governable, it changes at an epoch
 *   boundary without anything restarting, and a transaction built from a stale copy of it does not
 *   balance and is refused outright. It is never configured here and never hardcoded anywhere; it
 *   is read from the chain for every build.
 * - The **enrolment threshold** is a product decision. It says how much ada a wallet should hold
 *   before ChatterPay offers to stake it at all, and the answer depends on what ChatterPay is
 *   willing to spend on fees and on how small a position is worth the user's attention — not on
 *   anything the ledger enforces.
 *
 * **Every setting here comes from the network's own document**, `blockchains.staking`, and
 * from nowhere else. There is no environment fallback: a deployment that operates two Cardano
 * networks needs a pool, a threshold and a budget per network, and a process-wide variable cannot
 * express that — it would apply Preprod's pool to Mainnet. What stays in the environment is what is
 * not a setting: the Scheduler and BFF secrets, the provider credentials, the signing material and
 * the database URI.
 *
 * Reading fails closed. A network with no `staking` subdocument, or with one that is missing what
 * decides money, comes back disabled with a reason rather than with defaults: a deployment that
 * meant to configure a threshold and silently got one instead would be enrolling wallets it meant
 * to exclude.
 */

import type { CardanoAllowlistedPool, CardanoGovernanceDefault } from '../models/blockchainModel';
import { mongoBlockchainService } from '../services/mongo/mongoBlockchainService';
import { getCardanoConfig } from './cardanoConfig';

/** Why staking is not available, when it is not. */
export type CardanoStakingDisabledReason =
  | ''
  /** The network document has no `staking` section, or the network itself is not in the database. */
  | 'settings_missing'
  /** The staking flag is off. */
  | 'flag_off'
  /** No pool was configured, so there is nothing to delegate to. */
  | 'pool_missing'
  /** The configured pool is not on the network's own allowlist, or is listed but disabled. */
  | 'pool_not_allowlisted'
  /** A stored amount is not a usable figure. */
  | 'threshold_invalid'
  /** The terms version is missing, so a consent could not be stamped with anything. */
  | 'terms_missing';

export interface CardanoStakingConfig {
  /** Whether staking is usable at all. A conclusion, not the flag. */
  enabled: boolean;
  disabledReason: CardanoStakingDisabledReason;
  /** The network these settings were read from. */
  chainId: number;
  /**
   * Ada a wallet must hold before automatic enrolment is offered, in lovelace.
   *
   * A product setting. See the note at the top of this file for why it is not a constant, and
   * `cardanoStakingEligibilityService` for the chain-derived floor it is checked against.
   */
  minimumEnrolmentLovelace: bigint;
  /** The pool automatic enrolment delegates to. */
  defaultPoolId: string | null;
  /** The pools this network may delegate to, as stored. */
  allowlistedPools: readonly CardanoAllowlistedPool[];
  /** Version stamped on a consent, so a change of terms is visible per user. */
  termsVersion: string;
  /**
   * Whether a wallet must have accepted the terms before anything enrols it.
   *
   * Off by default, which makes staking automatic: a wallet that was never asked is treated as one
   * that agreed, and the sweep enrols it on the technical and economic checks alone. Nothing else
   * about those checks changes — the allowlist, the minimum balance, the signer, the
   * sponsored-entry limit and the on-chain state all still apply.
   *
   * What this never weakens is an explicit opt-out. Consent is the absence of a decision; an opt-out
   * is a decision, and no setting turns one into the other.
   */
  consentRequired: boolean;
  /** What ChatterPay will spend on staking network fees per window. */
  feeDailyCapLovelace: bigint;
  /**
   * Whether this network may register a DRep of its own and vote directly.
   *
   * Off, and the models and operation kinds exist only so the shape is settled. Turning it on is a
   * product decision that has not been made; nothing routes to those kinds while it is false.
   */
  drepOwnEnabled: boolean;
  /** Whether the governance surface is offered on this network at all. */
  governanceEnabled: boolean;
  /**
   * DReps a user may delegate to, or `null` for no restriction.
   *
   * Empty on the document means no restriction, unlike `allowlistedPools`: narrowing who may
   * represent a user is ChatterPay choosing their governance, which is a different thing from
   * picking a default pool.
   */
  allowlistedDReps: readonly string[] | null;
  /** Vote delegation a newly registered credential starts with. */
  defaultGovernance: CardanoGovernanceDefault;
  /**
   * Addresses automatic enrolment is confined to, or `null` for no confinement.
   *
   * Stored as a list, and an empty one means no confinement — which is what keeps staking automatic
   * by default. Confinement during a rollout is expressed by naming the addresses.
   */
  enrolmentAllowlist: readonly string[] | null;
  /**
   * How many times ChatterPay will pay to put the same credential back on chain in one window.
   *
   * Registering a stake credential costs a network fee, and the sponsor pays it. The deposit is the
   * user's and comes back to them, so the only party out of pocket when a wallet joins, leaves and
   * is funded again is ChatterPay — and nothing about that loop is abusive enough to notice, which
   * is what makes a limit the right instrument rather than an alarm.
   *
   * It bounds **entry only**. Withdrawing rewards, deregistering and leaving with the balance are
   * never counted and never refused by it: a limit that could strand somebody's ada inside a
   * position they are trying to leave would be a far worse failure than the cost it saves.
   *
   * Zero means no sponsored registration at all, which is a usable state while a rollout is
   * prepared. It is deliberately not read as "unlimited".
   */
  maxSponsoredRegistrationsPerWindow: number;
  /** How far back that count reaches, in days. */
  sponsorWindowDays: number;
  /** Whether a scheduler run may act, or only observe and record. */
  sweepExecutionEnabled: boolean;
  /** Ceiling on wallets one scheduler run may touch. */
  maxWalletsPerRun: number;
  /** Ceiling on provider calls one scheduler run may make. */
  maxProviderRequestsPerRun: number;
}

/** Stand-in figures for a configuration that is off. Never used: `enabled` is false alongside them. */
const DISABLED_AMOUNTS = {
  minimumEnrolmentLovelace: 0n,
  feeDailyCapLovelace: 0n,
  maxSponsoredRegistrationsPerWindow: 0,
  sponsorWindowDays: 30,
  maxWalletsPerRun: 0,
  maxProviderRequestsPerRun: 0
} as const;

/**
 * A configuration that refuses everything, with the reason it refuses.
 *
 * @param chainId - The network that was asked for.
 * @param disabledReason - Why it is off.
 * @returns The refusing configuration.
 */
function disabled(
  chainId: number,
  disabledReason: CardanoStakingDisabledReason
): CardanoStakingConfig {
  return {
    enabled: false,
    disabledReason,
    chainId,
    defaultPoolId: null,
    allowlistedPools: [],
    termsVersion: '',
    consentRequired: false,
    drepOwnEnabled: false,
    governanceEnabled: false,
    allowlistedDReps: null,
    defaultGovernance: 'always_abstain',
    enrolmentAllowlist: null,
    sweepExecutionEnabled: false,
    ...DISABLED_AMOUNTS
  };
}

/**
 * Reads a stored lovelace amount.
 *
 * @param raw - The decimal string as stored. Lovelace, never ada: the figures these are compared
 *   against come off the chain in lovelace, and a unit conversion in the middle is a rounding error
 *   waiting for a threshold to sit on.
 * @returns The amount, or `null` when it is absent or not a whole non-negative number.
 */
function readLovelace(raw: unknown): bigint | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  return BigInt(text);
}

/**
 * Reads a stored count.
 *
 * @param raw - The value as stored.
 * @returns The count, or `null` when it is absent or not a whole non-negative number. Zero is kept:
 *   it is a meaningful setting — "sponsor nothing" — and turning it into a default would switch a
 *   rollout's brake off without saying so.
 */
function readCount(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

/**
 * Whether the configured pool is one this network may actually delegate to.
 *
 * An empty allowlist places no restriction, which is the state a network starts in. A non-empty one
 * is a decision, and a default pool outside it is a misconfiguration rather than an exception: the
 * list exists precisely to say which pools are allowed.
 *
 * @param poolId - The configured default pool.
 * @param pools - The network's allowlist.
 * @returns Whether the pool may be used.
 */
function poolAllowed(poolId: string, pools: readonly CardanoAllowlistedPool[]): boolean {
  if (pools.length === 0) return true;
  return pools.some((pool) => pool.poolId === poolId && pool.enabled);
}

/**
 * Reads the staking configuration for a network.
 *
 * Asynchronous because the settings live in the network's document, and read on every call rather
 * than cached: a change to a pool, a threshold or the sponsor budget has to take effect when it is
 * made, not when the next deployment happens. Callers that iterate — the sweep, above all — read it
 * once and pass it down instead of reading it per wallet.
 *
 * @param chainId - The network to read. Defaults to the deployment's active Cardano network.
 * @returns The configuration, with `enabled` false and `disabledReason` set whenever anything it
 *   needs is missing or unusable.
 */
export async function loadCardanoStakingConfig(chainId?: number): Promise<CardanoStakingConfig> {
  const network = chainId ?? getCardanoConfig().chainId;

  const document = await mongoBlockchainService.getBlockchain(network);
  const staking = document?.staking;
  if (!staking) return disabled(network, 'settings_missing');

  const minimumEnrolmentLovelace = readLovelace(staking.minimumUserAdaForEnrollmentLovelace);
  const feeDailyCapLovelace = readLovelace(staking.dailySponsorFeeBudgetLovelace);
  const maxSponsoredRegistrationsPerWindow = readCount(
    staking.maxSponsoredRegistrationsPerAccountRollingWindow
  );
  const sponsorWindowDays = readCount(staking.sponsorRollingWindowDays);
  const maxWalletsPerRun = readCount(staking.maxWalletsPerRun);
  const maxProviderRequestsPerRun = readCount(staking.maxProviderRequestsPerRun);
  const defaultPoolId = (staking.defaultPoolId ?? '').trim() || null;
  const allowlistedPools = staking.allowlistedPools ?? [];
  const termsVersion = (staking.termsVersion ?? '').trim();

  const amountsUsable =
    minimumEnrolmentLovelace !== null &&
    feeDailyCapLovelace !== null &&
    maxSponsoredRegistrationsPerWindow !== null &&
    sponsorWindowDays !== null &&
    maxWalletsPerRun !== null &&
    maxProviderRequestsPerRun !== null;

  const disabledReason: CardanoStakingDisabledReason = !staking.enabled
    ? 'flag_off'
    : !amountsUsable
      ? 'threshold_invalid'
      : termsVersion === ''
        ? 'terms_missing'
        : defaultPoolId === null
          ? 'pool_missing'
          : !poolAllowed(defaultPoolId, allowlistedPools)
            ? 'pool_not_allowlisted'
            : '';

  if (disabledReason !== '') return disabled(network, disabledReason);

  return {
    enabled: true,
    disabledReason: '',
    chainId: network,
    minimumEnrolmentLovelace: minimumEnrolmentLovelace ?? 0n,
    defaultPoolId,
    allowlistedPools,
    termsVersion,
    // Stored as a boolean, and read as one: automatic staking is the default, and a network that
    // wants a gate says so in its own document.
    consentRequired: staking.consentRequired === true,
    feeDailyCapLovelace: feeDailyCapLovelace ?? 0n,
    drepOwnEnabled: staking.drepOwnEnabled === true,
    governanceEnabled: staking.governanceEnabled === true,
    allowlistedDReps: (staking.allowlistedDReps ?? []).length > 0 ? staking.allowlistedDReps : null,
    defaultGovernance: staking.defaultGovernance ?? 'always_abstain',
    enrolmentAllowlist:
      (staking.enrolmentAllowlist ?? []).length > 0 ? staking.enrolmentAllowlist : null,
    maxSponsoredRegistrationsPerWindow: maxSponsoredRegistrationsPerWindow ?? 0,
    sponsorWindowDays: sponsorWindowDays ?? 30,
    sweepExecutionEnabled: staking.sweepExecutionEnabled === true,
    maxWalletsPerRun: maxWalletsPerRun ?? 0,
    maxProviderRequestsPerRun: maxProviderRequestsPerRun ?? 0
  };
}

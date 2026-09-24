/**
 * What this deployment was told about staking, and the line between a setting and a chain rule.
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
 * Writing the threshold as a constant would quietly turn the second into the first. It would survive
 * a deposit increase unchanged and start enrolling wallets that cannot cover the deposit, which
 * fails as a refused transaction after a fee has already been spent. So it is configured, it has a
 * documented starting value, and `cardanoStakingEligibilityService` checks it against the chain's
 * own floor before any automatic enrolment is allowed. A threshold below that floor disables
 * automatic enrolment rather than being silently raised: the configured number is somebody's
 * decision, and overriding it without saying so is worse than refusing.
 */

import {
  CARDANO_STAKING_CONSENT_REQUIRED,
  CARDANO_STAKING_DEFAULT_POOL_ID,
  CARDANO_STAKING_DREP_OWN_ENABLED,
  CARDANO_STAKING_ENABLED,
  CARDANO_STAKING_ENROLMENT_ALLOWLIST,
  CARDANO_STAKING_FEE_DAILY_CAP_ADA,
  CARDANO_STAKING_MAX_SPONSORED_REGISTRATIONS,
  CARDANO_STAKING_MIN_ENROLMENT_ADA,
  CARDANO_STAKING_SPONSOR_WINDOW_DAYS,
  CARDANO_STAKING_TERMS_VERSION
} from './constants';

/** Lovelace in one ada. */
const LOVELACE_PER_ADA = 1_000_000n;

/**
 * Where the enrolment threshold starts, in ada.
 *
 * Five is a starting point, not a derivation. On Preprod the registration deposit is 2 ada and a
 * minimum output is well under one, so five leaves room for the deposit, an output that still
 * exists after it, and a position large enough to earn something visible. It is expected to be
 * revisited against a real Preprod run, and it is configurable precisely so that revisiting it does
 * not mean a deployment.
 */
const DEFAULT_MIN_ENROLMENT_ADA = 5;

/** Where the daily sponsor fee budget starts, in ada. */
const DEFAULT_FEE_DAILY_CAP_ADA = 50;

/** The terms version recorded against a consent when none is configured. */
const DEFAULT_TERMS_VERSION = 'v1';

/** Why staking is not available, when it is not. */
export type CardanoStakingDisabledReason =
  | ''
  /** The staking flag is off. */
  | 'flag_off'
  /** No pool was configured, so there is nothing to delegate to. */
  | 'pool_missing'
  /** The configured threshold is not a usable amount. */
  | 'threshold_invalid';

export interface CardanoStakingConfig {
  /** Whether staking is usable at all. A conclusion, not the flag. */
  enabled: boolean;
  disabledReason: CardanoStakingDisabledReason;
  /**
   * Ada a wallet must hold before automatic enrolment is offered, in lovelace.
   *
   * A product setting. See the note at the top of this file for why it is not a constant, and
   * `cardanoStakingEligibilityService` for the chain-derived floor it is checked against.
   */
  minimumEnrolmentLovelace: bigint;
  /** The pool automatic enrolment delegates to. */
  defaultPoolId: string | null;
  /** Version stamped on a consent, so a change of terms is visible per user. */
  termsVersion: string;
  /**
   * Whether a wallet must have accepted the terms before anything enrols it.
   *
   * With this off, staking is automatic: a wallet that was never asked is treated as one that
   * agreed, and the sweep enrols it on the technical and economic checks alone. Nothing else about
   * those checks changes — the allowlist, the minimum balance, the signer, the sponsored-entry limit
   * and the on-chain state all still apply, and they become the whole of what bounds a rollout.
   *
   * What this never weakens is an explicit opt-out. Consent is the absence of a decision; an opt-out
   * is a decision, and no setting turns one into the other.
   */
  consentRequired: boolean;
  /** What ChatterPay will spend on staking network fees per window. */
  feeDailyCapLovelace: bigint;
  /**
   * Whether this deployment may register a DRep of its own and vote directly.
   *
   * Off, and the models and operation kinds exist only so the shape is settled. Turning it on is a
   * product decision that has not been made; nothing routes to those kinds while it is false.
   */
  drepOwnEnabled: boolean;
  /**
   * Addresses automatic enrolment is confined to, or `null` for no confinement.
   *
   * A list that is **present and empty is not the same as absent**. Configuring an empty list means
   * "enrol nobody", which is a usable state while a rollout is being prepared; leaving the setting
   * out entirely means "no confinement". Collapsing the two would turn a typo in the setting into an
   * unrestricted sweep across every wallet in the database.
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
}

/** Sponsored registrations allowed per window when nothing is configured. */
const DEFAULT_MAX_SPONSORED_REGISTRATIONS = 2;

/** Length of that window, in days, when nothing is configured. */
const DEFAULT_SPONSOR_WINDOW_DAYS = 30;

/**
 * Reads a whole-number setting.
 *
 * @param raw - The configured value.
 * @param fallback - What to use when it is absent or unusable.
 * @returns The number. A negative value falls back rather than being clamped to zero, because zero
 *   is a meaningful setting here — it means "sponsor nothing" — and silently turning a typo into it
 *   would switch enrolment off across a deployment without saying so.
 */
function readCount(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Reads an ada amount into lovelace.
 *
 * @param raw - The configured value, in ada.
 * @param fallbackAda - What to use when it is absent.
 * @returns The amount in lovelace, or `null` when the value is present and unusable — which is a
 *   misconfiguration to report rather than a reason to fall back on the default. A deployment that
 *   set a threshold and got the default instead would be staking wallets it meant to exclude.
 */
function adaToLovelace(raw: string, fallbackAda: number): bigint | null {
  const text = raw.trim();
  if (text === '') return BigInt(fallbackAda) * LOVELACE_PER_ADA;
  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  // Rounded rather than truncated, and through a string, so that a configured `1.1` does not become
  // 1_099_999 by way of a binary fraction.
  const lovelace = Math.round(parsed * Number(LOVELACE_PER_ADA));
  return Number.isSafeInteger(lovelace) ? BigInt(lovelace) : null;
}

/**
 * Resolves the staking configuration from the environment.
 *
 * Read as a function rather than frozen at import, so tests can drive it without reloading modules.
 *
 * @returns The configuration, with `enabled` false and `disabledReason` set whenever anything it
 *   needs is missing or unusable.
 */
export function getCardanoStakingConfig(): CardanoStakingConfig {
  const flagOn = CARDANO_STAKING_ENABLED.trim().toLowerCase() === 'true';
  const defaultPoolId = CARDANO_STAKING_DEFAULT_POOL_ID.trim() || null;
  const minimumEnrolmentLovelace = adaToLovelace(
    CARDANO_STAKING_MIN_ENROLMENT_ADA,
    DEFAULT_MIN_ENROLMENT_ADA
  );
  const feeDailyCapLovelace = adaToLovelace(
    CARDANO_STAKING_FEE_DAILY_CAP_ADA,
    DEFAULT_FEE_DAILY_CAP_ADA
  );

  const disabledReason: CardanoStakingDisabledReason = !flagOn
    ? 'flag_off'
    : minimumEnrolmentLovelace === null || feeDailyCapLovelace === null
      ? 'threshold_invalid'
      : defaultPoolId === null
        ? 'pool_missing'
        : '';

  return {
    enabled: disabledReason === '',
    disabledReason,
    // The defaults stand in when a value was unusable, so the shape is always complete; the family
    // stays off through `disabledReason`, so none of it is ever used.
    minimumEnrolmentLovelace:
      minimumEnrolmentLovelace ?? BigInt(DEFAULT_MIN_ENROLMENT_ADA) * LOVELACE_PER_ADA,
    defaultPoolId,
    termsVersion: CARDANO_STAKING_TERMS_VERSION.trim() || DEFAULT_TERMS_VERSION,
    // Anything but an explicit `false` requires it, so a typo in the setting fails towards asking
    // people rather than towards enrolling them.
    consentRequired: CARDANO_STAKING_CONSENT_REQUIRED.trim().toLowerCase() !== 'false',
    feeDailyCapLovelace:
      feeDailyCapLovelace ?? BigInt(DEFAULT_FEE_DAILY_CAP_ADA) * LOVELACE_PER_ADA,
    drepOwnEnabled: CARDANO_STAKING_DREP_OWN_ENABLED.trim().toLowerCase() === 'true',
    enrolmentAllowlist: readAllowlist(CARDANO_STAKING_ENROLMENT_ALLOWLIST),
    maxSponsoredRegistrationsPerWindow: readCount(
      CARDANO_STAKING_MAX_SPONSORED_REGISTRATIONS,
      DEFAULT_MAX_SPONSORED_REGISTRATIONS
    ),
    sponsorWindowDays: readCount(CARDANO_STAKING_SPONSOR_WINDOW_DAYS, DEFAULT_SPONSOR_WINDOW_DAYS)
  };
}

/**
 * Reads the enrolment allowlist.
 *
 * The distinction this makes is between a setting that was never given and one that was given as
 * nothing. Only an entirely absent setting means "no confinement"; a setting present but holding no
 * usable address means "nobody", because the alternative is that a stray comma opens the sweep to
 * every wallet there is.
 *
 * @param raw - The configured value: addresses separated by commas, whitespace, or both.
 * @returns The addresses, or `null` when the setting is absent.
 */
function readAllowlist(raw: string): readonly string[] | null {
  if (raw.trim() === '') return null;
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Authenticating the scheduler that calls the staking sync endpoint.
 *
 * This endpoint is the one route here that a browser never reaches and a machine always does. Neither
 * of the two mechanisms the rest of the product uses fits it. `Origin` is set by browsers, absent from
 * every server-to-server call and forgeable by anything that is not a browser, so it answers "did a
 * page ask for this" — a useful question about a page and no question at all about a cron job. The
 * shared product token fits even worse: it is held by the web routes and by the bot, so accepting it
 * here would mean every component holding it could start a run that spends sponsor fees.
 *
 * So this route has a credential of its own: one high-entropy secret, presented as a bearer token,
 * known to this deployment and to the schedule, and to nothing else. It proves the caller is the
 * schedule rather than proving who a human is, which is exactly the claim a cron delivery can make.
 *
 * Three properties are worth stating because each one is a way this could go quietly wrong:
 *
 * **Unconfigured means closed.** A deployment with no secret set verifies nothing, and reading that
 * as "allow" would turn a forgotten variable into an open endpoint that starts transactions.
 *
 * **A weak secret is refused, not accepted.** A bearer credential is a password with no rate limit in
 * front of it, so the only thing making it safe is its length. A short value is treated as a
 * misconfiguration rather than honoured, because a secret nobody checked is how a placeholder ends up
 * in production.
 *
 * **Reusing a product token is refused.** Pointing this variable at the frontend or bot token would
 * silently undo the separation above, and it is an easy thing to do while copying environment files.
 *
 * The comparison is timing safe over digests, so neither the value nor its length leaks through how
 * long a rejection takes.
 */

import { createHash, timingSafeEqual } from 'crypto';

import {
  CARDANO_STAKING_SYNC_SECRET,
  CHATIZALO_TOKEN,
  FRONTEND_TOKEN
} from '../../config/constants';

/**
 * The shortest secret this accepts.
 *
 * Thirty-two characters is not a cryptographic threshold; it is the point past which a value is
 * obviously generated rather than typed. Anything a person invented is shorter than this.
 */
export const MINIMUM_SYNC_SECRET_LENGTH = 32;

/** Why a call was not accepted. */
export type SyncCredentialRejection =
  /** No secret is configured in this deployment, so nobody is authorised. */
  | 'not_configured'
  /** A secret is configured and is too short to be one. */
  | 'secret_too_short'
  /** The configured secret is a token the rest of the product already holds. */
  | 'secret_reused'
  /** The request carried no bearer credential. */
  | 'missing_credential'
  /** It carried one and it is not the configured secret. */
  | 'credential_mismatch';

export type SyncCredentialVerification =
  | { ok: true }
  | { ok: false; rejection: SyncCredentialRejection };

/**
 * The credential out of an `Authorization` header.
 *
 * @param header - The raw header, if there was one.
 * @returns The bearer value, or an empty string when the header is absent or is not a bearer one.
 */
export function bearerCredential(header: string | undefined): string {
  if (typeof header !== 'string') return '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match === null ? '' : match[1].trim();
}

/**
 * Whether two secrets match, without the comparison timing saying how nearly.
 *
 * Digests rather than the values themselves: `timingSafeEqual` throws on a length mismatch, so
 * comparing raw strings would leak the secret's length through that exception.
 *
 * @param presented - What the caller sent.
 * @param configured - What this deployment expects.
 * @returns True when they are the same value.
 */
function secretsMatch(presented: string, configured: string): boolean {
  const left = createHash('sha256').update(presented, 'utf8').digest();
  const right = createHash('sha256').update(configured, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * Whether the configured secret is usable at all.
 *
 * Checked on every call rather than at startup on purpose: the answer is reported to the caller, and
 * an operator configuring a schedule against a fresh deployment gets told which of the two mistakes
 * they made. It names no value and reveals nothing an attacker can use — knowing that a deployment
 * has no secret does not help anybody guess one, and the alternative is an operator facing a bare 401
 * with no way to tell a wrong secret from an unset one.
 *
 * @param configured - The configured secret, already trimmed.
 * @returns The rejection, or null when the configuration is sound.
 */
function configurationFault(configured: string): SyncCredentialRejection | null {
  if (configured === '') return 'not_configured';
  if (configured.length < MINIMUM_SYNC_SECRET_LENGTH) return 'secret_too_short';

  const productTokens = [FRONTEND_TOKEN, CHATIZALO_TOKEN]
    .map((token) => (typeof token === 'string' ? token.trim() : ''))
    .filter((token) => token !== '');

  if (productTokens.some((token) => token === configured)) return 'secret_reused';

  return null;
}

/**
 * Verifies the credential on a call to the staking sync endpoint.
 *
 * @param authorization - The request's `Authorization` header, if any.
 * @returns Whether the call is authorised, and why not when it is not.
 */
export function verifyStakingSyncCredential(
  authorization: string | undefined
): SyncCredentialVerification {
  const configured = CARDANO_STAKING_SYNC_SECRET.trim();

  // The deployment's own state comes first. A configuration that authorises nobody refuses every
  // caller for the same reason, whatever they presented, and saying so is more useful than a
  // mismatch that a correctly configured scheduler would read as "my secret is wrong".
  const fault = configurationFault(configured);
  if (fault !== null) return { ok: false, rejection: fault };

  const presented = bearerCredential(authorization);
  if (presented === '') return { ok: false, rejection: 'missing_credential' };

  return secretsMatch(presented, configured)
    ? { ok: true }
    : { ok: false, rejection: 'credential_mismatch' };
}

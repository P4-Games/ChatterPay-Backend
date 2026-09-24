/**
 * Two signed assertions, and why one is not enough.
 *
 * Everything user-facing in this repository authenticates the same way: the caller presents a shared
 * internal token and names a user in the body. That works because the only thing holding the token is
 * a Next.js route that resolved the session itself — but the *backend* cannot tell that. It sees a
 * valid token and a name, and it has no way to distinguish the route that authenticated somebody from
 * anything else that got hold of the token and picked a phone number.
 *
 * For a transfer that risk is already accepted. For an operation that deregisters a credential or
 * moves a whole balance it should not be, so staking mutations carry proof of two separate things that
 * are easy to conflate:
 *
 * **Who authenticated the user.** The BFF assertion. Signed by the Next.js route with a secret the
 * browser never sees, over the phone number *it* resolved from the session cookie plus the exact action
 * being asked for. Holding the internal token is no longer enough to name a user; you also have to be
 * able to sign as the BFF, and what you sign is bound to one action for one person.
 *
 * **Whether the user authorised this operation.** The PIN grant. Issued by the backend only after the
 * PIN verifies, and bound to the same action. This is what makes the PIN specific to an operation
 * rather than a fact about a session: a grant for `withdraw_rewards` cannot be presented for
 * `exit_and_send_max`, because the action is inside the signature.
 *
 * Both are short-lived HMAC assertions over a canonical payload. Neither is a session, neither can be
 * refreshed, and neither is stored — the only state involved is the nonce, which becomes the
 * operation's idempotency key so that a replay collides with a unique index instead of running twice.
 *
 * The keys are separate on purpose. The grant key is derived from the PIN key with its own label, so a
 * grant cannot be turned into a PIN hash or the reverse; the BFF key is its own configured secret,
 * because the party that holds it is a different party.
 */

import crypto from 'crypto';

import {
  CARDANO_STAKING_ASSERTION_REQUIRED,
  CARDANO_STAKING_BFF_SECRET,
  SECURITY_PIN_ENABLED,
  SECURITY_PIN_HMAC_KEY
} from '../../config/constants';
import { getPhoneNumberFormatted } from '../../helpers/formatHelper';
import { Logger } from '../../helpers/loggerHelper';
import type { CardanoStakingOperationKind } from '../../models/cardanoStakingOperationModel';

/** How long a BFF assertion is accepted. Long enough for one request, short enough not to be a token. */
const BFF_TTL_SECONDS = 120;

/** How long a PIN grant lasts: one operation, entered and confirmed by a person. */
const GRANT_TTL_SECONDS = 5 * 60;

/** Clock skew tolerated between the two processes. */
const CLOCK_TOLERANCE_SECONDS = 30;

/** The label that separates the grant key from the PIN key it is derived from. */
const GRANT_KEY_LABEL = 'cardano-staking-operation-grant';

/** What both assertions are signed over. */
export interface StakingAssertionClaims {
  /** Format version, so a change of shape cannot be replayed as the old one. */
  v: 1;
  /** The phone number, formatted. Whose position this is about. */
  sub: string;
  /** The exact action. Inside the signature, so an assertion cannot be moved to another one. */
  act: CardanoStakingOperationKind;
  /** An exit's destination, or `null`. Inside the signature, so the money cannot be redirected. */
  rcp: string | null;
  /** Unique per assertion. Becomes the operation's idempotency key, which is what makes it single-use. */
  nonce: string;
  iat: number;
  exp: number;
}

/** What an assertion is checked against. */
export interface StakingAssertionExpectation {
  sub: string;
  act: CardanoStakingOperationKind;
  rcp: string | null;
}

/** Why an assertion was not accepted. */
export type StakingAssertionRejection =
  /** No secret is configured, so nothing can be verified. */
  | 'not_configured'
  /** None was presented. */
  | 'missing'
  /** Not a readable assertion. */
  | 'malformed'
  /** The signature does not verify. */
  | 'bad_signature'
  /** Past its expiry, or issued in the future. */
  | 'expired'
  /** Verified, and about a different user, action or destination than the request. */
  | 'mismatched';

export type StakingAssertionVerification =
  | { ok: true; claims: StakingAssertionClaims }
  | { ok: false; rejection: StakingAssertionRejection; detail: string };

/**
 * Whether mutations must carry a BFF assertion.
 *
 * Defaults to **required**. A deployment that has not provisioned the secret yet can set the flag to
 * `false` explicitly, which is a decision somebody has to write down rather than a gap that happens to
 * be open — and every call that takes that path says so in the log.
 *
 * @returns `true` when an assertion is mandatory.
 */
export function bffAssertionRequired(): boolean {
  return CARDANO_STAKING_ASSERTION_REQUIRED.trim().toLowerCase() !== 'false';
}

/**
 * Whether a PIN grant must accompany a mutation.
 *
 * Tied to the PIN switch, because the grant exists to carry a PIN verification. A deployment that has
 * deliberately turned the PIN off has nothing for the grant to prove, and demanding one anyway would
 * make staking unusable in every environment where the PIN is off — including the one this is tested
 * in. That is the same reasoning the operation gate uses, and it is a decision, not an oversight.
 *
 * @returns `true` when a grant is mandatory.
 */
export function pinGrantRequired(): boolean {
  return SECURITY_PIN_ENABLED;
}

/**
 * The key a BFF assertion is signed with.
 *
 * @returns The secret, or `null` when none is configured.
 */
function bffKey(): string | null {
  const secret = CARDANO_STAKING_BFF_SECRET.trim();
  return secret === '' ? null : secret;
}

/**
 * The key a PIN grant is signed with.
 *
 * Derived from the PIN key rather than configured separately, so there is no second secret to
 * provision and no chance of the two being the same value. The label is what separates them: a grant
 * signature and a PIN hash are computed under keys that cannot be derived from one another.
 *
 * @returns The key, or `null` when the PIN key is not configured.
 */
function grantKey(): string | null {
  if (!SECURITY_PIN_HMAC_KEY) return null;
  return crypto.createHmac('sha256', SECURITY_PIN_HMAC_KEY).update(GRANT_KEY_LABEL).digest('hex');
}

/**
 * Serialises the claims the way both sides must agree on.
 *
 * Fixed field order, and a delimiter that cannot appear in any field: the phone number is digits, the
 * action is from a closed set, the nonce is hex, and an address is bech32. Signing a JSON object
 * instead would make the signature depend on key order and on how each runtime spells a number.
 *
 * @param claims - The claims.
 * @returns The canonical string.
 */
function canonical(claims: StakingAssertionClaims): string {
  return [
    claims.v,
    claims.sub,
    claims.act,
    claims.rcp ?? '-',
    claims.nonce,
    claims.iat,
    claims.exp
  ].join('|');
}

/**
 * Signs claims with a key.
 *
 * @param claims - What to sign.
 * @param key - The key.
 * @returns The assertion: payload and signature, both base64url.
 */
function sign(claims: StakingAssertionClaims, key: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', key).update(canonical(claims)).digest('base64url');
  return `${payload}.${signature}`;
}

/**
 * Verifies an assertion and checks it is about the request being made.
 *
 * @param assertion - What was presented.
 * @param key - The key it should be signed with, or `null` when none is configured.
 * @param expected - What the request is actually asking for.
 * @param now - The clock, injectable for tests.
 * @returns The verification.
 */
function verify(
  assertion: string | null,
  key: string | null,
  expected: StakingAssertionExpectation,
  now: Date
): StakingAssertionVerification {
  if (key === null) {
    return { ok: false, rejection: 'not_configured', detail: 'no signing key is configured' };
  }
  if (assertion === null || assertion.trim() === '') {
    return { ok: false, rejection: 'missing', detail: 'no assertion presented' };
  }

  const parts = assertion.trim().split('.');
  if (parts.length !== 2) {
    return { ok: false, rejection: 'malformed', detail: 'not a two-part assertion' };
  }

  let claims: StakingAssertionClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, rejection: 'malformed', detail: 'unreadable payload' };
  }

  // The version is checked before the signature is trusted for anything: a payload of a different
  // shape would be compared field by field against fields that mean something else.
  if (claims.v !== 1) {
    return { ok: false, rejection: 'malformed', detail: 'unexpected assertion version' };
  }
  if (
    typeof claims.sub !== 'string' ||
    typeof claims.act !== 'string' ||
    typeof claims.nonce !== 'string' ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number'
  ) {
    return { ok: false, rejection: 'malformed', detail: 'missing claims' };
  }

  const expectedSignature = crypto
    .createHmac('sha256', key)
    .update(canonical(claims))
    .digest('base64url');
  const presented = Buffer.from(parts[1], 'base64url');
  const computed = Buffer.from(expectedSignature, 'base64url');
  if (
    presented.length !== computed.length ||
    !crypto.timingSafeEqual(new Uint8Array(presented), new Uint8Array(computed))
  ) {
    return { ok: false, rejection: 'bad_signature', detail: 'signature does not verify' };
  }

  const seconds = Math.floor(now.getTime() / 1000);
  if (claims.exp + CLOCK_TOLERANCE_SECONDS < seconds) {
    return { ok: false, rejection: 'expired', detail: 'assertion has expired' };
  }
  if (claims.iat - CLOCK_TOLERANCE_SECONDS > seconds) {
    return { ok: false, rejection: 'expired', detail: 'assertion was issued in the future' };
  }

  // The bindings. Each of these is the reason a claim is inside the signature rather than beside it:
  // a mismatch here is an assertion being reused for something it was not issued for.
  if (getPhoneNumberFormatted(claims.sub) !== getPhoneNumberFormatted(expected.sub)) {
    return { ok: false, rejection: 'mismatched', detail: 'the assertion is about another user' };
  }
  if (claims.act !== expected.act) {
    return { ok: false, rejection: 'mismatched', detail: 'the assertion is for another action' };
  }
  if ((claims.rcp ?? null) !== (expected.rcp ?? null)) {
    return {
      ok: false,
      rejection: 'mismatched',
      detail: 'the assertion names another destination'
    };
  }

  return { ok: true, claims };
}

/**
 * Builds claims for an action.
 *
 * @param sub - The phone number.
 * @param act - The action.
 * @param rcp - An exit's destination, or `null`.
 * @param ttlSeconds - How long it lasts.
 * @param now - The clock.
 * @returns The claims, with a fresh nonce.
 */
function claimsFor(
  sub: string,
  act: CardanoStakingOperationKind,
  rcp: string | null,
  ttlSeconds: number,
  now: Date
): StakingAssertionClaims {
  const seconds = Math.floor(now.getTime() / 1000);
  return {
    v: 1,
    sub: getPhoneNumberFormatted(sub),
    act,
    rcp: rcp ?? null,
    nonce: crypto.randomBytes(16).toString('hex'),
    iat: seconds,
    exp: seconds + ttlSeconds
  };
}

/**
 * Signs a BFF assertion.
 *
 * Exported for the tests and for any server-side caller that legitimately stands in for the BFF. The
 * BFF itself signs with the same canonical form in its own process; that duplication is deliberate,
 * because the alternative is the backend minting assertions about users nobody authenticated.
 *
 * @param sub - The phone number the caller authenticated.
 * @param act - The action being asked for.
 * @param rcp - An exit's destination, or `null`.
 * @param now - The clock.
 * @returns The assertion, or `null` when no secret is configured.
 */
export function signBffAssertion(
  sub: string,
  act: CardanoStakingOperationKind,
  rcp: string | null = null,
  now: Date = new Date()
): string | null {
  const key = bffKey();
  if (key === null) return null;
  return sign(claimsFor(sub, act, rcp, BFF_TTL_SECONDS, now), key);
}

/**
 * Verifies a BFF assertion against the request it accompanies.
 *
 * @param assertion - What was presented.
 * @param expected - What the request is asking for.
 * @param now - The clock.
 * @returns The verification.
 */
export function verifyBffAssertion(
  assertion: string | null,
  expected: StakingAssertionExpectation,
  now: Date = new Date()
): StakingAssertionVerification {
  return verify(assertion, bffKey(), expected, now);
}

/**
 * Issues a PIN grant for one operation.
 *
 * Only ever called after the PIN has verified. Nothing in this module checks the PIN; the caller does,
 * and this exists so that the result of that check is something the next request can present and the
 * backend can re-verify without trusting the request to tell the truth about it.
 *
 * @param sub - The phone number whose PIN verified.
 * @param act - The action it was verified for.
 * @param rcp - An exit's destination, or `null`.
 * @param now - The clock.
 * @returns The grant and when it expires, or `null` when no key is configured.
 */
export function issuePinGrant(
  sub: string,
  act: CardanoStakingOperationKind,
  rcp: string | null = null,
  now: Date = new Date()
): { grant: string; expiresAt: Date; nonce: string } | null {
  const key = grantKey();
  if (key === null) {
    Logger.error(
      'cardanoStakingAssertionService',
      'Cannot issue a staking PIN grant: SECURITY_PIN_HMAC_KEY is not configured'
    );
    return null;
  }

  const claims = claimsFor(sub, act, rcp, GRANT_TTL_SECONDS, now);
  return {
    grant: sign(claims, key),
    expiresAt: new Date(claims.exp * 1000),
    nonce: claims.nonce
  };
}

/**
 * Verifies a PIN grant against the request it accompanies.
 *
 * @param grant - What was presented.
 * @param expected - What the request is asking for.
 * @param now - The clock.
 * @returns The verification.
 */
export function verifyPinGrant(
  grant: string | null,
  expected: StakingAssertionExpectation,
  now: Date = new Date()
): StakingAssertionVerification {
  return verify(grant, grantKey(), expected, now);
}

/**
 * The idempotency key an assertion's nonce produces.
 *
 * This is what makes an assertion single-use without any storage of its own. The operations collection
 * already has a unique index on `(chainId, idempotencyKey)`, so a replayed grant tries to create a
 * second operation with a key that exists and is refused by the database rather than by a check
 * somebody has to remember to write.
 *
 * @param nonce - The assertion's nonce.
 * @returns The key.
 */
export function assertionIdempotencyKey(nonce: string): string {
  return `grant:${nonce}`;
}

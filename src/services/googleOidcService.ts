/**
 * Verifying a Google-issued OIDC identity token.
 *
 * This is what stands in front of an endpoint a scheduler calls and a browser never does. The header
 * check every other route relies on is the wrong instrument for that: `Origin` is set by browsers,
 * absent from server-to-server calls, and trivially forged by anything that is not a browser. It
 * answers "did a page ask for this", which is a useful question about a page and no question at all
 * about a cron job.
 *
 * An OIDC token answers a different one: Google asserts, with a signature, which identity is calling.
 * Four things have to hold and all four are checked here, because dropping any one of them leaves a
 * hole shaped exactly like the check that was dropped.
 *
 * **The signature**, against Google's published keys. Without it the token is a string the caller
 * wrote. The keys are fetched and cached rather than pinned, because Google rotates them.
 *
 * **The issuer.** A correctly signed token from somewhere else is a correctly signed token.
 *
 * **The audience.** This is the one that is easy to skip and expensive to skip. Google will mint a
 * valid, correctly signed identity token for *any* audience anybody asks for, so a token minted for
 * some other service is a real Google token that proves a real identity — and if the audience is not
 * checked, replaying it here works. The audience is what binds a token to this endpoint.
 *
 * **The identity.** Signed, from Google, for this endpoint, and belonging to a principal this
 * deployment was told to accept. Otherwise any Google account on earth can call it.
 *
 * Unconfigured means closed. A deployment with no audience and no principals verifies nothing, and
 * treating that as "allow" would turn a missing setting into an open endpoint.
 */

import axios from 'axios';
import {
  createPublicKey,
  type JsonWebKey,
  type KeyObject,
  verify as verifySignature
} from 'crypto';

import { Logger } from '../helpers/loggerHelper';

/** Where Google publishes the keys its identity tokens are signed with. */
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** The issuers Google uses. Both forms appear in real tokens. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** How long a fetched key set is trusted before being fetched again. */
const JWKS_TTL_MS = 60 * 60 * 1000;

/** Clock skew tolerated on `exp` and `iat`, in seconds. */
const CLOCK_TOLERANCE_SECONDS = 30;

/** Timeout on the key fetch. Short: this runs inside a request. */
const JWKS_TIMEOUT_MS = 5_000;

/** Why a token was not accepted. */
export type OidcRejection =
  /** This deployment has nothing configured to verify against. */
  | 'not_configured'
  /** No bearer token on the request. */
  | 'missing_token'
  /** The token is not a readable JWT, or names no signing key. */
  | 'malformed_token'
  /** Google's signing keys could not be fetched, so nothing can be verified. */
  | 'keys_unavailable'
  /** The key the token names is not one of Google's current ones. */
  | 'unknown_key'
  /** Signature, issuer, audience or expiry did not check out. */
  | 'invalid_token'
  /** Verified, and the identity is not one this deployment accepts. */
  | 'principal_not_allowed';

export type OidcVerification =
  | { ok: true; principal: string; audience: string }
  | { ok: false; rejection: OidcRejection; detail: string };

/** What an endpoint verifies against. */
export interface OidcRequirement {
  /** The `aud` the token must carry: the URL the scheduler was configured with. */
  audience: string;
  /**
   * The identities allowed to call.
   *
   * In a deployed environment this holds the scheduler's service account. It also accepts an
   * operator's own account, which is what makes a manual invocation possible without a second
   * authentication mechanism existing alongside this one.
   */
  principals: readonly string[];
}

/** The claims a Google identity token carries that this module reads. */
interface GoogleIdTokenClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  email?: string;
  email_verified?: boolean | string;
}

/** A cached key set. */
interface CachedKeys {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
}

let cache: CachedKeys | null = null;

/**
 * Forgets the cached signing keys.
 *
 * For tests, and for the rotation case where a token names a key the cache does not have.
 */
export function resetGoogleOidcKeys(): void {
  cache = null;
}

/**
 * Reads the bearer token off an authorization header.
 *
 * @param header - The header value, or `undefined`.
 * @returns The token, or `null`.
 */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Google's current signing keys, by key id.
 *
 * Cached because this runs on every call to a protected endpoint and the keys change on the order of
 * weeks. A token naming a key the cache does not have forces a refetch, which is how a rotation is
 * picked up without waiting for the cache to expire.
 *
 * @param allowRefetch - Whether a cache miss on the key id may trigger one more fetch.
 * @param kid - The key id the token names.
 * @returns The keys, or `null` when they could not be fetched.
 */
async function signingKeys(
  kid: string,
  allowRefetch = true
): Promise<Map<string, KeyObject> | null> {
  const fresh = cache !== null && Date.now() - cache.fetchedAt < JWKS_TTL_MS;
  if (fresh && cache !== null) {
    if (cache.keys.has(kid) || !allowRefetch) return cache.keys;
  }

  try {
    const response = await axios.get<{ keys: (JsonWebKey & { kid?: string })[] }>(GOOGLE_JWKS_URL, {
      timeout: JWKS_TIMEOUT_MS
    });
    const keys = new Map<string, KeyObject>();
    for (const jwk of response.data.keys ?? []) {
      if (!jwk.kid) continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        // One unusable key does not invalidate the rest of the set.
        Logger.warn('googleOidcService', `Skipping an unreadable Google signing key: ${jwk.kid}`);
      }
    }
    cache = { keys, fetchedAt: Date.now() };
    return keys;
  } catch (error) {
    Logger.error(
      'googleOidcService',
      `Could not fetch Google signing keys: ${error instanceof Error ? error.message : String(error)}`
    );
    // The stale set is better than nothing: the keys it holds are still Google's, and refusing every
    // call during a transient network failure would stop a scheduler that is behaving correctly.
    return cache?.keys ?? null;
  }
}

/**
 * Verifies a Google identity token against what an endpoint requires.
 *
 * @param token - The raw JWT.
 * @param requirement - The audience and the principals this endpoint accepts.
 * @returns The verification. Nothing about the token is trusted unless `ok` is true.
 */
export async function verifyGoogleOidcToken(
  token: string | null,
  requirement: OidcRequirement
): Promise<OidcVerification> {
  if (requirement.audience.trim() === '' || requirement.principals.length === 0) {
    return {
      ok: false,
      rejection: 'not_configured',
      detail: 'no audience or no accepted principal is configured'
    };
  }
  if (token === null) return { ok: false, rejection: 'missing_token', detail: 'no bearer token' };

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, rejection: 'malformed_token', detail: 'not a three-part JWT' };
  }

  // Read only to find which key signed it. Nothing in here is trusted: the header is part of the
  // token the caller supplied, and the checks below are what make any of it mean something.
  let algorithm: string;
  let kid: string;
  try {
    const header = JSON.parse(decodeSegment(parts[0]).toString('utf8')) as {
      alg?: string;
      kid?: string;
    };
    if (!header.kid || !header.alg) {
      return { ok: false, rejection: 'malformed_token', detail: 'no key id in the header' };
    }
    algorithm = header.alg;
    kid = header.kid;
  } catch {
    return { ok: false, rejection: 'malformed_token', detail: 'unreadable header' };
  }

  // Pinned, not read from the token. `alg: none` and a downgrade to a symmetric algorithm are the
  // two classic ways a verifier is talked out of verifying anything.
  if (algorithm !== 'RS256') {
    return { ok: false, rejection: 'invalid_token', detail: 'unexpected signing algorithm' };
  }

  const keys = await signingKeys(kid);
  if (keys === null) {
    return { ok: false, rejection: 'keys_unavailable', detail: 'Google signing keys unreachable' };
  }
  const key = keys.get(kid);
  if (key === undefined) {
    return {
      ok: false,
      rejection: 'unknown_key',
      detail: 'the token names an unknown signing key'
    };
  }

  let signatureValid: boolean;
  try {
    signatureValid = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
      key,
      decodeSegment(parts[2])
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { ok: false, rejection: 'invalid_token', detail: 'signature does not verify' };
  }

  let payload: GoogleIdTokenClaims;
  try {
    payload = JSON.parse(decodeSegment(parts[1]).toString('utf8')) as GoogleIdTokenClaims;
  } catch {
    return { ok: false, rejection: 'malformed_token', detail: 'unreadable payload' };
  }

  const claimFailure = checkClaims(payload, requirement.audience);
  if (claimFailure !== null) {
    return { ok: false, rejection: 'invalid_token', detail: claimFailure };
  }

  // Signed by Google, for this endpoint, and not expired. What is left is whose token it is.
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (email === '' || !verified) {
    return {
      ok: false,
      rejection: 'principal_not_allowed',
      detail: 'the token carries no verified email claim'
    };
  }

  const allowed = requirement.principals.some(
    (principal) => principal.trim().toLowerCase() === email
  );
  if (!allowed) {
    // The email is logged and not returned. It is a real identity and the caller does not need to be
    // told which identities this deployment accepts.
    Logger.warn('googleOidcService', `Rejected an OIDC caller that is not on the allowed list`);
    return {
      ok: false,
      rejection: 'principal_not_allowed',
      detail: 'the caller is not accepted by this deployment'
    };
  }

  return { ok: true, principal: email, audience: requirement.audience };
}

/**
 * Reads one base64url segment of a JWT.
 *
 * @param segment - The segment.
 * @returns Its bytes.
 */
function decodeSegment(segment: string): Buffer {
  return Buffer.from(segment, 'base64url');
}

/**
 * Checks the claims that decide whether a correctly signed token is for this endpoint.
 *
 * The audience is the one that carries the weight. Google mints a valid, correctly signed identity
 * token for whatever audience is requested, so a token issued for some other service is genuine and
 * proves a genuine identity — and replaying it here works unless the audience is compared.
 *
 * @param claims - The verified payload.
 * @param audience - The audience this endpoint requires.
 * @returns What failed, or `null` when everything holds.
 */
function checkClaims(claims: GoogleIdTokenClaims, audience: string): string | null {
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) {
    return 'issuer is not Google';
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return 'audience does not name this endpoint';

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_TOLERANCE_SECONDS < now) {
    return 'token has expired';
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_TOLERANCE_SECONDS > now) {
    return 'token is not valid yet';
  }
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_TOLERANCE_SECONDS > now) {
    return 'token was issued in the future';
  }

  return null;
}

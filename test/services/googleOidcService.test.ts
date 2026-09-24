import { createSign, generateKeyPairSync, type KeyObject } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bearerToken,
  resetGoogleOidcKeys,
  verifyGoogleOidcToken
} from '../../src/services/googleOidcService';

const get = vi.hoisted(() => vi.fn());

vi.mock('axios', () => ({ default: { get }, get }));

const AUDIENCE = 'https://backend.example.net/internal/cardano/staking/sync';
const SCHEDULER = 'cardano-staking-sync@chatterpay-dev.iam.gserviceaccount.com';
const KEY_ID = 'test-key-1';

/** A signing key pair, generated once: 2048-bit RSA is slow enough to matter in a loop. */
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** A second pair, for the token that is signed by the wrong key. */
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

/**
 * A key set in the shape Google publishes.
 *
 * @param keys - The public keys, by key id.
 * @returns The JWKS document.
 */
function jwks(keys: Record<string, KeyObject>): { keys: unknown[] } {
  return {
    keys: Object.entries(keys).map(([kid, key]) => ({
      ...(key.export({ format: 'jwk' }) as Record<string, unknown>),
      kid,
      use: 'sig',
      alg: 'RS256'
    }))
  };
}

/**
 * Encodes one JWT segment.
 *
 * @param value - What to encode.
 * @returns The base64url segment.
 */
function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Mints a token, signed for real.
 *
 * Signed rather than stubbed, so the suite exercises the signature check instead of trusting a mock
 * to have been wired the same way the verifier reads it.
 *
 * @param claims - Claims to override.
 * @param options - Which key and algorithm to use.
 * @returns The token.
 */
function token(
  claims: Record<string, unknown> = {},
  options: { key?: KeyObject; kid?: string; alg?: string } = {}
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: options.alg ?? 'RS256', kid: options.kid ?? KEY_ID, typ: 'JWT' };
  const payload = {
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    azp: SCHEDULER,
    email: SCHEDULER,
    email_verified: true,
    iat: now,
    exp: now + 3600,
    ...claims
  };

  const signing = `${segment(header)}.${segment(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signing);
  return `${signing}.${signer.sign(options.key ?? pair.privateKey).toString('base64url')}`;
}

/** What the endpoint requires. */
const REQUIREMENT = { audience: AUDIENCE, principals: [SCHEDULER] };

beforeEach(() => {
  resetGoogleOidcKeys();
  get.mockReset();
  get.mockResolvedValue({ data: jwks({ [KEY_ID]: pair.publicKey }) });
});

describe('bearerToken', () => {
  it('reads a bearer token', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('reads nothing out of anything else', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
  });
});

describe('verifyGoogleOidcToken', () => {
  it('accepts a token signed by Google for this endpoint by an accepted principal', async () => {
    const result = await verifyGoogleOidcToken(token(), REQUIREMENT);

    expect(result).toMatchObject({ ok: true, principal: SCHEDULER, audience: AUDIENCE });
  });

  it('verifies nothing when nothing is configured', async () => {
    // A deployment with no audience and no principals has authorised nobody. Reading that as "allow"
    // would turn a missing setting into an open endpoint.
    await expect(
      verifyGoogleOidcToken(token(), { audience: '', principals: [SCHEDULER] })
    ).resolves.toMatchObject({ ok: false, rejection: 'not_configured' });

    await expect(
      verifyGoogleOidcToken(token(), { audience: AUDIENCE, principals: [] })
    ).resolves.toMatchObject({ ok: false, rejection: 'not_configured' });
  });

  it('refuses a request with no token', async () => {
    await expect(verifyGoogleOidcToken(null, REQUIREMENT)).resolves.toMatchObject({
      ok: false,
      rejection: 'missing_token'
    });
  });

  it('refuses a token minted for a different audience', async () => {
    // The check that carries the most weight. Google mints a valid, correctly signed identity token
    // for whatever audience is asked for, so a token issued for another service is genuine — and
    // replaying it here works unless the audience is compared.
    const elsewhere = token({ aud: 'https://some-other-service.example.net' });

    await expect(verifyGoogleOidcToken(elsewhere, REQUIREMENT)).resolves.toMatchObject({
      ok: false,
      rejection: 'invalid_token'
    });
  });

  it('refuses a token from another issuer', async () => {
    await expect(
      verifyGoogleOidcToken(token({ iss: 'https://accounts.example.net' }), REQUIREMENT)
    ).resolves.toMatchObject({ ok: false, rejection: 'invalid_token' });
  });

  it("refuses a token signed by a key that is not Google's", async () => {
    const forged = token({}, { key: other.privateKey });

    await expect(verifyGoogleOidcToken(forged, REQUIREMENT)).resolves.toMatchObject({
      ok: false,
      rejection: 'invalid_token'
    });
  });

  it('refuses an unsigned token', async () => {
    // `alg: none` is the classic way a verifier is talked out of verifying. The algorithm is pinned
    // rather than read from the token.
    const header = segment({ alg: 'none', kid: KEY_ID, typ: 'JWT' });
    const payload = segment({
      iss: 'https://accounts.google.com',
      aud: AUDIENCE,
      email: SCHEDULER
    });

    await expect(
      verifyGoogleOidcToken(`${header}.${payload}.`, REQUIREMENT)
    ).resolves.toMatchObject({ ok: false, rejection: 'invalid_token' });
  });

  it('refuses an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);

    await expect(
      verifyGoogleOidcToken(token({ iat: now - 7200, exp: now - 3600 }), REQUIREMENT)
    ).resolves.toMatchObject({ ok: false, rejection: 'invalid_token' });
  });

  it('refuses a token issued in the future', async () => {
    const now = Math.floor(Date.now() / 1000);

    await expect(
      verifyGoogleOidcToken(token({ iat: now + 3600, exp: now + 7200 }), REQUIREMENT)
    ).resolves.toMatchObject({ ok: false, rejection: 'invalid_token' });
  });

  it('refuses a token naming a key Google does not publish', async () => {
    await expect(
      verifyGoogleOidcToken(token({}, { kid: 'not-a-google-key' }), REQUIREMENT)
    ).resolves.toMatchObject({ ok: false, rejection: 'unknown_key' });
  });

  it('refuses a valid token belonging to an identity it was not told to accept', async () => {
    // Signed by Google, for this endpoint, not expired — and from somebody else's account.
    await expect(
      verifyGoogleOidcToken(token({ email: 'somebody@example.net' }), REQUIREMENT)
    ).resolves.toMatchObject({ ok: false, rejection: 'principal_not_allowed' });
  });

  it('does not say which identities it accepts', async () => {
    const result = await verifyGoogleOidcToken(
      token({ email: 'somebody@example.net' }),
      REQUIREMENT
    );

    if (result.ok) throw new Error('expected a rejection');
    expect(result.detail).not.toContain(SCHEDULER);
  });

  it('refuses a token whose email is not verified', async () => {
    await expect(
      verifyGoogleOidcToken(token({ email_verified: false }), REQUIREMENT)
    ).resolves.toMatchObject({ ok: false, rejection: 'principal_not_allowed' });
  });

  it('compares the identity without regard to case', async () => {
    await expect(
      verifyGoogleOidcToken(token({ email: SCHEDULER.toUpperCase() }), REQUIREMENT)
    ).resolves.toMatchObject({ ok: true });
  });

  it('refuses something that is not a JWT at all', async () => {
    await expect(verifyGoogleOidcToken('not-a-token', REQUIREMENT)).resolves.toMatchObject({
      ok: false,
      rejection: 'malformed_token'
    });
  });

  it('caches the key set rather than fetching it per call', async () => {
    await verifyGoogleOidcToken(token(), REQUIREMENT);
    await verifyGoogleOidcToken(token(), REQUIREMENT);

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('refetches when a token names a key the cache does not have', async () => {
    // How a key rotation is picked up without waiting out the cache.
    await verifyGoogleOidcToken(token(), REQUIREMENT);
    get.mockResolvedValue({ data: jwks({ 'rotated-key': other.publicKey }) });

    const rotated = token({}, { key: other.privateKey, kid: 'rotated-key' });
    await expect(verifyGoogleOidcToken(rotated, REQUIREMENT)).resolves.toMatchObject({ ok: true });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('refuses everything while the keys cannot be fetched', async () => {
    resetGoogleOidcKeys();
    get.mockRejectedValue(new Error('network down'));

    await expect(verifyGoogleOidcToken(token(), REQUIREMENT)).resolves.toMatchObject({
      ok: false,
      rejection: 'keys_unavailable'
    });
  });

  it('keeps working on a cached key set while the fetch is failing', async () => {
    // The keys it already holds are still Google's. Refusing every call during a transient network
    // failure would stop a scheduler that is behaving correctly.
    await verifyGoogleOidcToken(token(), REQUIREMENT);
    get.mockRejectedValue(new Error('network down'));

    await expect(
      verifyGoogleOidcToken(token({}, { kid: 'unknown-so-it-refetches' }), REQUIREMENT)
    ).resolves.toMatchObject({ ok: false, rejection: 'unknown_key' });
  });
});

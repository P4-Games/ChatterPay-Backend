import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bearerCredential,
  MINIMUM_SYNC_SECRET_LENGTH,
  verifyStakingSyncCredential
} from '../../../src/services/cardano/cardanoStakingSyncAuthService';

/**
 * The credential in front of the staking sync endpoint.
 *
 * This is the whole authorisation for a route that can start transactions and spend sponsor fees, so
 * the cases that matter are the ones where it silently stops being an authorisation: an unset secret
 * read as "allow", a placeholder short enough to guess, and the product token pasted in by somebody
 * copying an environment file. All three are refusals here, and each has its own reason so that an
 * operator configuring a schedule is told which mistake they made.
 */

/** The deployment's configuration, as these tests drive it. */
const config = vi.hoisted(() => ({
  secret: '',
  frontendToken: '',
  chatizaloToken: ''
}));

vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  return Object.defineProperties(
    { ...actual },
    {
      CARDANO_STAKING_SYNC_SECRET: { get: () => config.secret, enumerable: true },
      FRONTEND_TOKEN: { get: () => config.frontendToken, enumerable: true },
      CHATIZALO_TOKEN: { get: () => config.chatizaloToken, enumerable: true }
    }
  );
});

/** A secret of the shape the deliverable tells an operator to generate. */
const SECRET = 'Zp8rN4tQv7Lw2Hs9Kd3Fj6Xb1Cm5Ty0Ge4Ra8Uo2Iv6Nq';

/** Long enough to pass the length check, and not the one configured. */
const OTHER_SECRET = 'Wd3Hk9Pz6Bn2Sq7Lt4Ry1Mv8Cj5Xf0Ga3Eo6Uu9Ii2Nb';

beforeEach(() => {
  config.secret = SECRET;
  config.frontendToken = 'a-frontend-token-long-enough-to-be-one';
  config.chatizaloToken = 'a-chatizalo-token-long-enough-to-be-one';
});

describe('reading the credential off the header', () => {
  it('takes the value after Bearer', () => {
    expect(bearerCredential(`Bearer ${SECRET}`)).toBe(SECRET);
  });

  it('accepts the scheme in any case, because header schemes are case insensitive', () => {
    expect(bearerCredential(`bearer ${SECRET}`)).toBe(SECRET);
  });

  it('ignores whitespace around the value', () => {
    expect(bearerCredential(`Bearer   ${SECRET}  `)).toBe(SECRET);
  });

  it('reads nothing out of a header that is not a bearer one', () => {
    expect(bearerCredential(`Basic ${SECRET}`)).toBe('');
  });

  it('reads nothing when there is no header', () => {
    expect(bearerCredential(undefined)).toBe('');
  });
});

describe('a deployment that is configured', () => {
  it('accepts the configured secret', () => {
    expect(verifyStakingSyncCredential(`Bearer ${SECRET}`)).toEqual({ ok: true });
  });

  it('accepts a secret of exactly the minimum length', () => {
    config.secret = 'x'.repeat(MINIMUM_SYNC_SECRET_LENGTH);

    expect(verifyStakingSyncCredential(`Bearer ${config.secret}`)).toEqual({ ok: true });
  });

  it('refuses a different secret', () => {
    expect(verifyStakingSyncCredential(`Bearer ${OTHER_SECRET}`)).toEqual({
      ok: false,
      rejection: 'credential_mismatch'
    });
  });

  it('refuses a secret that is right except for its last character', () => {
    const nearly = `${SECRET.slice(0, -1)}X`;

    expect(verifyStakingSyncCredential(`Bearer ${nearly}`)).toEqual({
      ok: false,
      rejection: 'credential_mismatch'
    });
  });

  it('refuses a prefix of the secret', () => {
    // The comparison is over digests, so a length mismatch is a mismatch rather than an exception.
    expect(verifyStakingSyncCredential(`Bearer ${SECRET.slice(0, 20)}`)).toEqual({
      ok: false,
      rejection: 'credential_mismatch'
    });
  });

  it('refuses the frontend token', () => {
    // The product tokens are held by the web routes and by the bot. Neither is the schedule.
    expect(verifyStakingSyncCredential(`Bearer ${config.frontendToken}`)).toEqual({
      ok: false,
      rejection: 'credential_mismatch'
    });
  });

  it('refuses the bot token', () => {
    expect(verifyStakingSyncCredential(`Bearer ${config.chatizaloToken}`)).toEqual({
      ok: false,
      rejection: 'credential_mismatch'
    });
  });

  it('refuses a call carrying no credential', () => {
    expect(verifyStakingSyncCredential(undefined)).toEqual({
      ok: false,
      rejection: 'missing_credential'
    });
  });

  it('refuses a bearer header with nothing after it', () => {
    expect(verifyStakingSyncCredential('Bearer    ')).toEqual({
      ok: false,
      rejection: 'missing_credential'
    });
  });

  it('refuses a credential presented under another scheme', () => {
    expect(verifyStakingSyncCredential(`Basic ${SECRET}`)).toEqual({
      ok: false,
      rejection: 'missing_credential'
    });
  });
});

describe('a deployment that is not configured', () => {
  it('authorises nobody when no secret is set', () => {
    // The failure that matters most. An unset variable read as "allow" is an open endpoint that
    // starts transactions, and it would look exactly like a working deployment until it did.
    config.secret = '';

    expect(verifyStakingSyncCredential(`Bearer ${SECRET}`)).toEqual({
      ok: false,
      rejection: 'not_configured'
    });
  });

  it('authorises nobody when the secret is whitespace', () => {
    config.secret = '    ';

    expect(verifyStakingSyncCredential('Bearer     ')).toEqual({
      ok: false,
      rejection: 'not_configured'
    });
  });

  it('says so rather than reporting a mismatch', () => {
    // An operator whose schedule is refused needs to know whether their secret is wrong or the
    // deployment has none. Both as `credential_mismatch` would send them to change the right value.
    config.secret = '';

    const result = verifyStakingSyncCredential(`Bearer ${OTHER_SECRET}`);

    expect(result).toEqual({ ok: false, rejection: 'not_configured' });
  });
});

describe('a deployment configured badly', () => {
  it('refuses a secret too short to be one, rather than honouring it', () => {
    // A bearer credential is a password with no rate limit in front of it. A short value is a
    // placeholder somebody meant to replace, and accepting it is how it reaches production.
    config.secret = 'changeme';

    expect(verifyStakingSyncCredential('Bearer changeme')).toEqual({
      ok: false,
      rejection: 'secret_too_short'
    });
  });

  it('refuses one character below the minimum', () => {
    config.secret = 'x'.repeat(MINIMUM_SYNC_SECRET_LENGTH - 1);

    expect(verifyStakingSyncCredential(`Bearer ${config.secret}`)).toEqual({
      ok: false,
      rejection: 'secret_too_short'
    });
  });

  it('refuses a secret pointed at the frontend token', () => {
    // Easy to do while copying environment files, and it would hand the schedule's privileges to
    // every component holding that token.
    config.frontendToken = SECRET;

    expect(verifyStakingSyncCredential(`Bearer ${SECRET}`)).toEqual({
      ok: false,
      rejection: 'secret_reused'
    });
  });

  it('refuses a secret pointed at the bot token', () => {
    config.chatizaloToken = SECRET;

    expect(verifyStakingSyncCredential(`Bearer ${SECRET}`)).toEqual({
      ok: false,
      rejection: 'secret_reused'
    });
  });

  it('does not treat an unset product token as a reuse', () => {
    // Both product tokens empty is an ordinary local configuration. Comparing against '' would make
    // every secret a reuse of nothing.
    config.frontendToken = '';
    config.chatizaloToken = '';

    expect(verifyStakingSyncCredential(`Bearer ${SECRET}`)).toEqual({ ok: true });
  });
});

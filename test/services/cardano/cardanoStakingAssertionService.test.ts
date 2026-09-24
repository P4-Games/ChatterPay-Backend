import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertionIdempotencyKey,
  bffAssertionRequired,
  issuePinGrant,
  pinGrantRequired,
  signBffAssertion,
  verifyBffAssertion,
  verifyPinGrant
} from '../../../src/services/cardano/cardanoStakingAssertionService';

/**
 * The state the mocked constants answer from. Mutated per test.
 *
 * Held here rather than on the process environment, the same way the Cardano suites do it: the
 * constants are read in one place, so a test that wants a different configuration changes what that
 * place answers.
 */
const state = vi.hoisted(() => ({
  bffSecret: 'a-shared-secret-between-the-bff-and-the-backend',
  assertionRequired: 'true',
  pinEnabled: true,
  pinKey: 'the-pin-hmac-key'
}));

vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  return Object.defineProperties(
    { ...actual },
    {
      CARDANO_STAKING_BFF_SECRET: { get: () => state.bffSecret, enumerable: true },
      CARDANO_STAKING_ASSERTION_REQUIRED: { get: () => state.assertionRequired, enumerable: true },
      SECURITY_PIN_ENABLED: { get: () => state.pinEnabled, enumerable: true },
      SECURITY_PIN_HMAC_KEY: { get: () => state.pinKey, enumerable: true }
    }
  );
});

const PHONE = '5491122223333';
const OTHER = '5491199998888';
const RECIPIENT = 'addr_test1vrhdandhv2ngazdseql7v5fkg5utnu629anv9zt25x8vrsqn2mhal';

/** What a request for a withdrawal expects. */
const WITHDRAW = { sub: PHONE, act: 'withdraw_rewards' as const, rcp: null };

beforeEach(() => {
  state.bffSecret = 'a-shared-secret-between-the-bff-and-the-backend';
  state.assertionRequired = 'true';
  state.pinEnabled = true;
  state.pinKey = 'the-pin-hmac-key';
});

describe('whether assertions are required', () => {
  it('requires a BFF assertion unless a deployment says otherwise', () => {
    expect(bffAssertionRequired()).toBe(true);
  });

  it('accepts an explicit decision to do without one', () => {
    state.assertionRequired = 'false';
    expect(bffAssertionRequired()).toBe(false);
  });

  it('does not read anything else as permission to do without one', () => {
    // A typo in the setting must not open the gap it was meant to close. Only the word itself does,
    // whatever its case and whitespace.
    for (const value of ['', 'no', '0', 'off', 'true']) {
      state.assertionRequired = value;
      expect(bffAssertionRequired()).toBe(true);
    }

    for (const value of ['false', 'FALSE ', ' False']) {
      state.assertionRequired = value;
      expect(bffAssertionRequired()).toBe(false);
    }
  });

  it('ties the PIN grant to the PIN switch', () => {
    // A deployment that turned the PIN off has nothing for a grant to prove.
    state.pinEnabled = false;
    expect(pinGrantRequired()).toBe(false);
  });
});

describe('the BFF assertion', () => {
  it('verifies one it signed itself', () => {
    const assertion = signBffAssertion(PHONE, 'withdraw_rewards');

    expect(verifyBffAssertion(assertion, WITHDRAW)).toMatchObject({ ok: true });
  });

  it('refuses a request that carries none', () => {
    expect(verifyBffAssertion(null, WITHDRAW)).toMatchObject({ ok: false, rejection: 'missing' });
    expect(verifyBffAssertion('   ', WITHDRAW)).toMatchObject({ ok: false, rejection: 'missing' });
  });

  it('verifies nothing when no secret is configured', () => {
    // Fails closed. An unprovisioned secret must not read as "no signature needed".
    state.bffSecret = '';
    expect(signBffAssertion(PHONE, 'withdraw_rewards')).toBeNull();
    expect(verifyBffAssertion('anything', WITHDRAW)).toMatchObject({
      ok: false,
      rejection: 'not_configured'
    });
  });

  it('refuses one signed with a different secret', () => {
    const assertion = signBffAssertion(PHONE, 'withdraw_rewards');
    state.bffSecret = 'somebody-elses-secret';

    expect(verifyBffAssertion(assertion, WITHDRAW)).toMatchObject({
      ok: false,
      rejection: 'bad_signature'
    });
  });

  it('refuses one whose payload was edited', () => {
    // The whole point of signing the canonical form: changing the user inside the payload does not
    // change the signature, so the two stop agreeing.
    const assertion = signBffAssertion(PHONE, 'withdraw_rewards') ?? '';
    const [payload, signature] = assertion.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.sub = OTHER;
    const forged = `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${signature}`;

    expect(verifyBffAssertion(forged, { ...WITHDRAW, sub: OTHER })).toMatchObject({
      ok: false,
      rejection: 'bad_signature'
    });
  });

  it('refuses one about a different user', () => {
    // This is the property the mechanism exists for: holding the internal token is no longer enough to
    // name a user.
    const assertion = signBffAssertion(OTHER, 'withdraw_rewards');

    expect(verifyBffAssertion(assertion, WITHDRAW)).toMatchObject({
      ok: false,
      rejection: 'mismatched'
    });
  });

  it('refuses one issued for a different action', () => {
    const assertion = signBffAssertion(PHONE, 'withdraw_rewards');

    expect(
      verifyBffAssertion(assertion, { sub: PHONE, act: 'exit_and_send_max', rcp: null })
    ).toMatchObject({ ok: false, rejection: 'mismatched' });
  });

  it('refuses one whose destination does not match', () => {
    // An exit's destination is inside the signature, so an assertion cannot be reused to send the same
    // balance somewhere else.
    const assertion = signBffAssertion(PHONE, 'exit_and_send_max', RECIPIENT);

    expect(
      verifyBffAssertion(assertion, {
        sub: PHONE,
        act: 'exit_and_send_max',
        rcp: 'addr_test1_somewhere_else'
      })
    ).toMatchObject({ ok: false, rejection: 'mismatched' });
  });

  it('accepts the destination it was issued for', () => {
    const assertion = signBffAssertion(PHONE, 'exit_and_send_max', RECIPIENT);

    expect(
      verifyBffAssertion(assertion, { sub: PHONE, act: 'exit_and_send_max', rcp: RECIPIENT })
    ).toMatchObject({ ok: true });
  });

  it('compares the user by formatted phone number, not by spelling', () => {
    const assertion = signBffAssertion('+54 9 11 2222 3333', 'withdraw_rewards');

    expect(verifyBffAssertion(assertion, WITHDRAW)).toMatchObject({ ok: true });
  });

  it('expires', () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const assertion = signBffAssertion(PHONE, 'withdraw_rewards', null, issuedAt);

    expect(verifyBffAssertion(assertion, WITHDRAW, new Date('2026-01-01T00:10:00Z'))).toMatchObject(
      { ok: false, rejection: 'expired' }
    );
  });

  it('is still good a moment after it was issued', () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const assertion = signBffAssertion(PHONE, 'withdraw_rewards', null, issuedAt);

    expect(verifyBffAssertion(assertion, WITHDRAW, new Date('2026-01-01T00:00:30Z'))).toMatchObject(
      { ok: true }
    );
  });

  it('refuses one dated in the future', () => {
    const assertion = signBffAssertion(
      PHONE,
      'withdraw_rewards',
      null,
      new Date('2026-01-01T01:00:00Z')
    );

    expect(verifyBffAssertion(assertion, WITHDRAW, new Date('2026-01-01T00:00:00Z'))).toMatchObject(
      { ok: false, rejection: 'expired' }
    );
  });

  it('refuses something that is not an assertion at all', () => {
    expect(verifyBffAssertion('nonsense', WITHDRAW)).toMatchObject({
      ok: false,
      rejection: 'malformed'
    });
    expect(verifyBffAssertion('a.b.c', WITHDRAW)).toMatchObject({
      ok: false,
      rejection: 'malformed'
    });
  });

  it('refuses a payload of an unknown version', () => {
    // A different shape would be compared field by field against fields that mean something else.
    const claims = {
      v: 2,
      sub: PHONE,
      act: 'withdraw_rewards',
      rcp: null,
      nonce: 'aa',
      iat: 1,
      exp: 9
    };
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');

    expect(verifyBffAssertion(`${payload}.signature`, WITHDRAW)).toMatchObject({
      ok: false,
      rejection: 'malformed'
    });
  });
});

describe('the PIN grant', () => {
  it('verifies one it issued', () => {
    const issued = issuePinGrant(PHONE, 'withdraw_rewards');

    expect(issued).not.toBeNull();
    expect(verifyPinGrant(issued?.grant ?? null, WITHDRAW)).toMatchObject({ ok: true });
  });

  it('cannot be issued without the PIN key', () => {
    state.pinKey = '';
    expect(issuePinGrant(PHONE, 'withdraw_rewards')).toBeNull();
  });

  it('cannot be presented for another action', () => {
    // What makes the PIN specific to an operation. A grant obtained for a withdrawal is not permission
    // to empty the wallet.
    const issued = issuePinGrant(PHONE, 'withdraw_rewards');

    expect(
      verifyPinGrant(issued?.grant ?? null, { sub: PHONE, act: 'exit_and_send_max', rcp: null })
    ).toMatchObject({ ok: false, rejection: 'mismatched' });
  });

  it('cannot be presented for another user', () => {
    const issued = issuePinGrant(OTHER, 'withdraw_rewards');

    expect(verifyPinGrant(issued?.grant ?? null, WITHDRAW)).toMatchObject({
      ok: false,
      rejection: 'mismatched'
    });
  });

  it('is not interchangeable with a BFF assertion', () => {
    // Separate keys, so neither party can mint the other's proof. A BFF that could issue PIN grants
    // would make the PIN decorative.
    const bff = signBffAssertion(PHONE, 'withdraw_rewards');
    const grant = issuePinGrant(PHONE, 'withdraw_rewards');

    expect(verifyPinGrant(bff, WITHDRAW)).toMatchObject({ ok: false, rejection: 'bad_signature' });
    expect(verifyBffAssertion(grant?.grant ?? null, WITHDRAW)).toMatchObject({
      ok: false,
      rejection: 'bad_signature'
    });
  });

  it('is derived from the PIN key rather than equal to it', () => {
    // If the grant key were the PIN key itself, a grant signature and a PIN hash would be computed
    // under the same secret. Changing the PIN key must invalidate grants, and nothing else.
    const issued = issuePinGrant(PHONE, 'withdraw_rewards');
    state.pinKey = 'a-rotated-pin-key';

    expect(verifyPinGrant(issued?.grant ?? null, WITHDRAW)).toMatchObject({
      ok: false,
      rejection: 'bad_signature'
    });
  });

  it('expires within minutes, not hours', () => {
    const issued = issuePinGrant(PHONE, 'withdraw_rewards', null, new Date('2026-01-01T00:00:00Z'));

    expect(
      verifyPinGrant(issued?.grant ?? null, WITHDRAW, new Date('2026-01-01T00:04:00Z'))
    ).toMatchObject({ ok: true });
    expect(
      verifyPinGrant(issued?.grant ?? null, WITHDRAW, new Date('2026-01-01T00:20:00Z'))
    ).toMatchObject({ ok: false, rejection: 'expired' });
  });

  it('reports when it expires', () => {
    const issued = issuePinGrant(PHONE, 'withdraw_rewards', null, new Date('2026-01-01T00:00:00Z'));

    expect(issued?.expiresAt.toISOString()).toBe('2026-01-01T00:05:00.000Z');
  });
});

describe('single use', () => {
  it('turns a nonce into the idempotency key the database enforces', () => {
    // The storage-free way to make a grant single-use: a replay tries to create an operation whose key
    // already exists, and the unique index refuses it.
    const issued = issuePinGrant(PHONE, 'withdraw_rewards');

    expect(assertionIdempotencyKey(issued?.nonce ?? '')).toBe(`grant:${issued?.nonce}`);
  });

  it('gives every grant its own nonce', () => {
    const keys = new Set(
      Array.from({ length: 20 }, () => issuePinGrant(PHONE, 'withdraw_rewards')?.nonce)
    );

    expect(keys.size).toBe(20);
  });
});

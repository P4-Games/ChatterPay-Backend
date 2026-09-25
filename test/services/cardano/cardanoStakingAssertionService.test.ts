import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertionIdempotencyKey,
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
  pinEnabled: true,
  pinKey: 'the-pin-hmac-key'
}));

vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  return Object.defineProperties(
    { ...actual },
    {
      CARDANO_STAKING_BFF_SECRET: { get: () => state.bffSecret, enumerable: true },
      SECURITY_PIN_ENABLED: { get: () => state.pinEnabled, enumerable: true },
      SECURITY_PIN_HMAC_KEY: { get: () => state.pinKey, enumerable: true }
    }
  );
});

const PHONE = '5491122223333';
const OTHER = '5491199998888';
const RECIPIENT = 'addr_test1vrhdandhv2ngazdseql7v5fkg5utnu629anv9zt25x8vrsqn2mhal';

/**
 * Two DReps, as the canonical target strings a request produces for them.
 *
 * Written out rather than derived, because what these tests are about is that the *string* inside the
 * signature differs. How it is built is `cardanoGovernanceTargetService`'s business and is tested
 * there.
 */
const DREP_ONE = 'drep:drep1ytmqvnmfzlp9wvqd0kjdtqj6kqxh2yepzcmqmr8rhmalgks5p6tqa';
const DREP_TWO = 'drep:drep1y2qdkxhvj5rk6c6pdsy3xq5t8k9qh4wqz5xkmczw6kuhmfsq4rpxz';

/** What a request for a withdrawal expects. */
const WITHDRAW = { sub: PHONE, act: 'withdraw_rewards' as const, rcp: null, gov: null };

/** What a request to abstain expects. */
const ABSTAIN = {
  sub: PHONE,
  act: 'delegate_vote' as const,
  rcp: null,
  gov: 'always_abstain'
};

beforeEach(() => {
  state.bffSecret = 'a-shared-secret-between-the-bff-and-the-backend';
  state.pinEnabled = true;
  state.pinKey = 'the-pin-hmac-key';
});

describe('whether assertions are required', () => {
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
      verifyBffAssertion(assertion, { sub: PHONE, act: 'exit_and_send_max', rcp: null, gov: null })
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
        rcp: 'addr_test1_somewhere_else',
        gov: null
      })
    ).toMatchObject({ ok: false, rejection: 'mismatched' });
  });

  it('accepts the destination it was issued for', () => {
    const assertion = signBffAssertion(PHONE, 'exit_and_send_max', RECIPIENT);

    expect(
      verifyBffAssertion(assertion, {
        sub: PHONE,
        act: 'exit_and_send_max',
        rcp: RECIPIENT,
        gov: null
      })
    ).toMatchObject({ ok: true });
  });

  it('compares the user by formatted phone number, not by spelling', () => {
    const assertion = signBffAssertion('+54 9 11 2222 3333', 'withdraw_rewards');

    expect(verifyBffAssertion(assertion, WITHDRAW)).toMatchObject({ ok: true });
  });

  it('expires', () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const assertion = signBffAssertion(PHONE, 'withdraw_rewards', null, null, issuedAt);

    expect(verifyBffAssertion(assertion, WITHDRAW, new Date('2026-01-01T00:10:00Z'))).toMatchObject(
      { ok: false, rejection: 'expired' }
    );
  });

  it('is still good a moment after it was issued', () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const assertion = signBffAssertion(PHONE, 'withdraw_rewards', null, null, issuedAt);

    expect(verifyBffAssertion(assertion, WITHDRAW, new Date('2026-01-01T00:00:30Z'))).toMatchObject(
      { ok: true }
    );
  });

  it('refuses one dated in the future', () => {
    const assertion = signBffAssertion(
      PHONE,
      'withdraw_rewards',
      null,
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
      v: 99,
      sub: PHONE,
      act: 'withdraw_rewards',
      rcp: null,
      gov: null,
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

  it('refuses the shape this contract used to have', () => {
    // Version 1 carried no governance target, so its fields canonicalise into different positions.
    // Accepting it would mean accepting an assertion that says nothing about what a vote delegation
    // is aimed at, which is the whole hole the version was raised to close.
    const claims = {
      v: 1,
      sub: PHONE,
      act: 'delegate_vote',
      rcp: null,
      nonce: 'aa',
      iat: 1,
      exp: 9
    };
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');

    expect(verifyBffAssertion(`${payload}.signature`, ABSTAIN)).toMatchObject({
      ok: false,
      rejection: 'malformed'
    });
  });
});

describe('the governance target inside an assertion', () => {
  it('verifies the target it was signed for', () => {
    const assertion = signBffAssertion(PHONE, 'delegate_vote', null, 'always_abstain');

    expect(verifyBffAssertion(assertion, ABSTAIN)).toMatchObject({ ok: true });
  });

  it('refuses an abstention presented as a vote of no confidence', () => {
    // The two are opposite instructions to the ledger. An assertion for one is not an assertion for
    // the other, and without the target inside the signature they would be indistinguishable.
    const assertion = signBffAssertion(PHONE, 'delegate_vote', null, 'always_abstain');

    expect(
      verifyBffAssertion(assertion, { ...ABSTAIN, gov: 'always_no_confidence' })
    ).toMatchObject({ ok: false, rejection: 'mismatched' });
  });

  it('refuses an abstention presented as a delegation to a DRep', () => {
    const assertion = signBffAssertion(PHONE, 'delegate_vote', null, 'always_abstain');

    expect(verifyBffAssertion(assertion, { ...ABSTAIN, gov: DREP_ONE })).toMatchObject({
      ok: false,
      rejection: 'mismatched'
    });
  });

  it('refuses one DRep presented as another', () => {
    // The case the whole target claim exists for: two representatives who would vote differently, and
    // an assertion that names one of them.
    const assertion = signBffAssertion(PHONE, 'delegate_vote', null, DREP_ONE);

    expect(verifyBffAssertion(assertion, { ...ABSTAIN, gov: DREP_TWO })).toMatchObject({
      ok: false,
      rejection: 'mismatched'
    });
  });

  it('refuses a targeted assertion presented for an action that has no target', () => {
    const assertion = signBffAssertion(PHONE, 'delegate_vote', null, DREP_ONE);

    expect(verifyBffAssertion(assertion, { ...ABSTAIN, gov: null })).toMatchObject({
      ok: false,
      rejection: 'mismatched'
    });
  });

  it('refuses an untargeted assertion presented for a target', () => {
    // The direction that used to be the bug rather than a refusal: an assertion signed over the
    // action alone would otherwise authorise whichever target the request happened to carry.
    const assertion = signBffAssertion(PHONE, 'delegate_vote', null, null);

    expect(verifyBffAssertion(assertion, ABSTAIN)).toMatchObject({
      ok: false,
      rejection: 'mismatched'
    });
  });
});

describe('the governance target inside a PIN grant', () => {
  it('verifies the target it was issued for', () => {
    const issued = issuePinGrant(PHONE, 'delegate_vote', null, DREP_ONE);

    expect(verifyPinGrant(issued?.grant ?? null, { ...ABSTAIN, gov: DREP_ONE })).toMatchObject({
      ok: true
    });
  });

  it('cannot be spent on a different predefined target', () => {
    // The PIN was entered under a screen that said "abstain". Spending that confirmation on a vote of
    // no confidence would make the PIN a fact about a session again.
    const issued = issuePinGrant(PHONE, 'delegate_vote', null, 'always_abstain');

    expect(
      verifyPinGrant(issued?.grant ?? null, { ...ABSTAIN, gov: 'always_no_confidence' })
    ).toMatchObject({ ok: false, rejection: 'mismatched' });
  });

  it('cannot be spent on a DRep', () => {
    const issued = issuePinGrant(PHONE, 'delegate_vote', null, 'always_abstain');

    expect(verifyPinGrant(issued?.grant ?? null, { ...ABSTAIN, gov: DREP_ONE })).toMatchObject({
      ok: false,
      rejection: 'mismatched'
    });
  });

  it('cannot be spent on a different DRep', () => {
    const issued = issuePinGrant(PHONE, 'delegate_vote', null, DREP_ONE);

    expect(verifyPinGrant(issued?.grant ?? null, { ...ABSTAIN, gov: DREP_TWO })).toMatchObject({
      ok: false,
      rejection: 'mismatched'
    });
  });

  it('cannot be spent on a no-confidence vote by dropping the target', () => {
    const issued = issuePinGrant(PHONE, 'delegate_vote', null, 'always_no_confidence');

    expect(verifyPinGrant(issued?.grant ?? null, { ...ABSTAIN, gov: null })).toMatchObject({
      ok: false,
      rejection: 'mismatched'
    });
  });

  it('keeps the nonce, so the target it was issued for is also single-use', () => {
    // The nonce becomes the operation's idempotency key. A grant bound to one target is therefore
    // spendable once, on that target.
    const first = issuePinGrant(PHONE, 'delegate_vote', null, DREP_ONE);
    const second = issuePinGrant(PHONE, 'delegate_vote', null, DREP_ONE);

    expect(first?.nonce).not.toBe(second?.nonce);
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
      verifyPinGrant(issued?.grant ?? null, {
        sub: PHONE,
        act: 'exit_and_send_max',
        rcp: null,
        gov: null
      })
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
    const issued = issuePinGrant(
      PHONE,
      'withdraw_rewards',
      null,
      null,
      new Date('2026-01-01T00:00:00Z')
    );

    expect(
      verifyPinGrant(issued?.grant ?? null, WITHDRAW, new Date('2026-01-01T00:04:00Z'))
    ).toMatchObject({ ok: true });
    expect(
      verifyPinGrant(issued?.grant ?? null, WITHDRAW, new Date('2026-01-01T00:20:00Z'))
    ).toMatchObject({ ok: false, rejection: 'expired' });
  });

  it('reports when it expires', () => {
    const issued = issuePinGrant(
      PHONE,
      'withdraw_rewards',
      null,
      null,
      new Date('2026-01-01T00:00:00Z')
    );

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

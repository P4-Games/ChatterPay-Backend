import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  issuePinGrant,
  signBffAssertion
} from '../../../src/services/cardano/cardanoStakingAssertionService';
import {
  authorizeStakingAction,
  requestStakingAction
} from '../../../src/services/cardano/cardanoStakingUserService';
import { enableCardanoPreprod } from '../../support/cardanoEnv';

/**
 * What a grant for one governance target is, and is not, permission to do.
 *
 * These are the cases the three targets exist behind. Offering a choice of target only means something
 * if the authorisation follows the choice: a PIN typed under a screen that said *abstain* must not pay
 * for a vote of no confidence, and one typed for a named representative must not pay for a different
 * representative. Every case below therefore drives the real request path — the same
 * `requestStakingAction` the route calls — and reads the refusal it produces.
 *
 * The negative cases all refuse **before** the security gate, before the account is resolved and before
 * any chain read, which is where the two proofs are checked. Nothing here reaches a provider, signs a
 * transaction or writes an operation.
 *
 * The positive case cannot reach a chain either, so what it asserts is that neither proof is what
 * stopped it: the request gets past the assertion, past the grant and past the target validation, and
 * is then refused by the security gate for a user this suite never set a PIN for. That is the furthest
 * the binding can be observed without building a transaction, and building one is out of scope.
 */

const state = vi.hoisted(() => ({
  bffSecret: 'a-shared-secret-between-the-bff-and-the-backend',
  pinEnabled: true,
  pinKey: 'the-pin-hmac-key'
}));

vi.mock('../../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  const { cardanoConstantsMock } = await import('../../support/cardanoEnv');
  return Object.defineProperties(cardanoConstantsMock(actual), {
    CARDANO_STAKING_BFF_SECRET: { get: () => state.bffSecret, enumerable: true },
    SECURITY_PIN_ENABLED: { get: () => state.pinEnabled, enumerable: true },
    SECURITY_PIN_HMAC_KEY: { get: () => state.pinKey, enumerable: true }
  });
});

const PHONE = '5491133334444';

/** Two DReps, as bech32 fixtures denoting nobody. */
const DREP_A = 'drep1y242424242424242424242424242424242424242424242sdg97tu';
const DREP_A_LEGACY = 'drep_vkh1424242424242424242424242424242424242424242425xawa90';
const DREP_B = 'drep1y2amhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwcxwkjzd';

/** The wire form of each target. */
const ABSTAIN = { kind: 'always_abstain' };
const NO_CONFIDENCE = { kind: 'always_no_confidence' };
const DREP_ONE = { kind: 'drep', drep_id: DREP_A };
const DREP_TWO = { kind: 'drep', drep_id: DREP_B };

/** The canonical string each of those produces, which is what the two proofs are signed over. */
const CANONICAL: Record<string, string> = {
  always_abstain: 'always_abstain',
  always_no_confidence: 'always_no_confidence',
  drep_one: `drep:${DREP_A}`,
  drep_two: `drep:${DREP_B}`
};

/**
 * Asks for a vote delegation, presenting proofs issued for whichever target the caller names.
 *
 * @param options - The target the request carries, and the canonical target each proof was issued for.
 * @returns What the service answered.
 */
async function ask(options: {
  requested: unknown;
  assertionFor?: string | null;
  grantFor?: string | null;
}) {
  const assertion = signBffAssertion(
    PHONE,
    'delegate_vote',
    null,
    options.assertionFor === undefined ? null : options.assertionFor
  );
  const grant = issuePinGrant(
    PHONE,
    'delegate_vote',
    null,
    options.grantFor === undefined ? null : options.grantFor
  );

  return requestStakingAction(PHONE, 'delegate_vote', {
    actor: 'web',
    governanceTarget: options.requested,
    bffAssertion: assertion,
    pinGrant: grant?.grant ?? null
  });
}

beforeEach(() => {
  enableCardanoPreprod();
  state.bffSecret = 'a-shared-secret-between-the-bff-and-the-backend';
  state.pinEnabled = true;
  state.pinKey = 'the-pin-hmac-key';
});

describe('the target a request has to name', () => {
  it('refuses a vote delegation that names none', () => {
    // What used to happen instead: the assembler defaulted to abstaining, so `delegate_vote` could
    // only ever mean one of the three targets.
    return expect(
      requestStakingAction(PHONE, 'delegate_vote', { actor: 'web' })
    ).resolves.toMatchObject({ ok: false, refusal: 'governance_target' });
  });

  it('refuses a target on an action that has none', async () => {
    const result = await requestStakingAction(PHONE, 'withdraw_rewards', {
      actor: 'web',
      governanceTarget: ABSTAIN
    });

    expect(result).toMatchObject({ ok: false, refusal: 'governance_target' });
    expect(result.ok === false && result.detail).toContain('not_applicable');
  });

  it('refuses an unreadable representative rather than falling back to abstaining', async () => {
    const result = await ask({ requested: { kind: 'drep', drep_id: 'drep1nonsense' } });

    expect(result).toMatchObject({ ok: false, refusal: 'governance_target' });
    expect(result.ok === false && result.detail).toContain('unreadable_drep_id');
  });

  it('refuses a representative named by nothing', async () => {
    const result = await ask({ requested: { kind: 'drep' } });

    expect(result.ok === false && result.detail).toContain('missing_drep_id');
  });

  it('refuses a kind it does not offer', async () => {
    for (const kind of ['register_drep', 'cast_drep_vote', 'abstain']) {
      const result = await ask({ requested: { kind } });

      expect(result, kind).toMatchObject({ ok: false, refusal: 'governance_target' });
    }
  });
});

describe('a grant issued for one target', () => {
  it('is accepted for the target it was issued for', async () => {
    const result = await ask({
      requested: ABSTAIN,
      assertionFor: CANONICAL.always_abstain,
      grantFor: CANONICAL.always_abstain
    });

    // Refused further along, by the gate, for a user with no PIN on file. What matters is which
    // refusal it is not.
    expect(result).toMatchObject({ ok: false });
    // Named rather than merely "not one of the three": a refusal from earlier in the sequence would
    // satisfy the negations below while proving nothing about the binding.
    expect(result.ok === false && result.refusal).toBe('security_gate');
    expect(result.ok === false && result.refusal).not.toBe('governance_target');
    expect(result.ok === false && result.refusal).not.toBe('assertion');
    expect(result.ok === false && result.refusal).not.toBe('pin_grant');
  });

  it('is not permission to vote no confidence', async () => {
    // The case the whole binding exists for. Abstaining and voting against everything are opposite
    // instructions, and the PIN was typed for one of them.
    const result = await ask({
      requested: NO_CONFIDENCE,
      assertionFor: CANONICAL.always_no_confidence,
      grantFor: CANONICAL.always_abstain
    });

    expect(result).toMatchObject({ ok: false, refusal: 'pin_grant' });
    expect(result.ok === false && result.detail).toContain('mismatched');
  });

  it('is not permission to follow a representative', async () => {
    const result = await ask({
      requested: DREP_ONE,
      assertionFor: CANONICAL.drep_one,
      grantFor: CANONICAL.always_abstain
    });

    expect(result).toMatchObject({ ok: false, refusal: 'pin_grant' });
  });

  it('is not permission to follow a different representative', async () => {
    // Two representatives who would vote differently. A grant for one is not a grant for the other.
    const result = await ask({
      requested: DREP_TWO,
      assertionFor: CANONICAL.drep_two,
      grantFor: CANONICAL.drep_one
    });

    expect(result).toMatchObject({ ok: false, refusal: 'pin_grant' });
    expect(result.ok === false && result.detail).toContain('mismatched');
  });

  it('is not permission to abstain when it was issued for a representative', async () => {
    const result = await ask({
      requested: ABSTAIN,
      assertionFor: CANONICAL.always_abstain,
      grantFor: CANONICAL.drep_one
    });

    expect(result).toMatchObject({ ok: false, refusal: 'pin_grant' });
  });

  it('is not permission for anything once the target is dropped from it', async () => {
    // A grant signed over the action alone, which is what every grant looked like before the target
    // became a claim. It no longer authorises the target the request happens to carry.
    const result = await ask({
      requested: ABSTAIN,
      assertionFor: CANONICAL.always_abstain,
      grantFor: null
    });

    expect(result).toMatchObject({ ok: false, refusal: 'pin_grant' });
  });

  it('is bound to the spelling of the representative it was issued for', async () => {
    // Strictly tighter than binding the decoded credential, and deliberately so: neither side needs a
    // DRep parser to agree on what was signed. The same representative in the other spelling is a
    // different string and therefore a different grant.
    const result = await ask({
      requested: { kind: 'drep', drep_id: DREP_A_LEGACY },
      assertionFor: `drep:${DREP_A_LEGACY}`,
      grantFor: CANONICAL.drep_one
    });

    expect(result).toMatchObject({ ok: false, refusal: 'pin_grant' });
  });
});

describe('an assertion issued for one target', () => {
  it('is refused for another, before the grant is even looked at', async () => {
    // The order matters: the assertion says who is asking and for what, so a request that has not
    // established that is refused before anything else is consulted.
    const result = await ask({
      requested: NO_CONFIDENCE,
      assertionFor: CANONICAL.always_abstain,
      grantFor: CANONICAL.always_no_confidence
    });

    expect(result).toMatchObject({ ok: false, refusal: 'assertion' });
    expect(result.ok === false && result.detail).toContain('mismatched');
  });

  it('is refused for a different representative', async () => {
    const result = await ask({
      requested: DREP_TWO,
      assertionFor: CANONICAL.drep_one,
      grantFor: CANONICAL.drep_two
    });

    expect(result).toMatchObject({ ok: false, refusal: 'assertion' });
  });

  it('is refused when it names no target at all', async () => {
    const result = await ask({
      requested: ABSTAIN,
      assertionFor: null,
      grantFor: CANONICAL.always_abstain
    });

    expect(result).toMatchObject({ ok: false, refusal: 'assertion' });
  });
});

describe('authorising a vote delegation', () => {
  it('refuses to issue a grant for a vote delegation with no target', async () => {
    // A grant can only be bound to a target that was named. Issuing one for an unnamed target would be
    // issuing the general permission the binding exists to prevent.
    const result = await authorizeStakingAction(PHONE, 'delegate_vote', {
      pin: '123456',
      actor: 'web'
    });

    expect(result).toMatchObject({ ok: false, refusal: 'governance_target' });
  });

  it('refuses to issue one for an unreadable representative', async () => {
    const result = await authorizeStakingAction(PHONE, 'delegate_vote', {
      pin: '123456',
      actor: 'web',
      governanceTarget: { kind: 'drep', drep_id: 'drep1nonsense' },
      bffAssertion: signBffAssertion(PHONE, 'delegate_vote', null, 'drep:drep1nonsense')
    });

    expect(result).toMatchObject({ ok: false, refusal: 'governance_target' });
  });

  it('refuses to issue one when the assertion names a different target', async () => {
    // A caller able to buy a grant for a target the user never saw would make the confirmation
    // meaningless, so the same binding is checked here.
    const result = await authorizeStakingAction(PHONE, 'delegate_vote', {
      pin: '123456',
      actor: 'web',
      governanceTarget: NO_CONFIDENCE,
      bffAssertion: signBffAssertion(PHONE, 'delegate_vote', null, CANONICAL.always_abstain)
    });

    expect(result).toMatchObject({ ok: false, refusal: 'assertion' });
  });

  it('refuses a target on an action that has none', async () => {
    const result = await authorizeStakingAction(PHONE, 'withdraw_rewards', {
      pin: '123456',
      actor: 'web',
      governanceTarget: ABSTAIN
    });

    expect(result).toMatchObject({ ok: false, refusal: 'governance_target' });
  });
});

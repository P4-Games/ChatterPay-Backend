import { describe, expect, it } from 'vitest';

import {
  GOVERNANCE_TARGET_KINDS,
  governanceTargetAlreadyInPlace,
  governanceTargetCanonical,
  parseGovernanceTarget
} from '../../../src/services/cardano/cardanoGovernanceTargetService';

/**
 * Reading the governance target a request names.
 *
 * The three targets Cardano offers a delegator are one action and three different instructions to the
 * ledger, so the target has to survive the trip intact and it has to be refused rather than guessed
 * at. Two properties carry the weight here:
 *
 * The canonical string differs for every distinct target. That string is what the BFF assertion and
 * the PIN grant are signed over, so anything that made two targets canonicalise the same way would
 * make a grant for one spendable on the other.
 *
 * Nothing is inferred. A `kind` outside the three, a DRep with no identifier, and an identifier that
 * does not decode are each refused with their own reason — and in particular none of them falls back
 * to abstaining, which is the failure that made the other two targets unreachable in the first place.
 *
 * The identifiers below are fixtures: real bech32, derived from hashes of repeated bytes, denoting
 * nobody.
 */

/** One DRep, in both spellings of the same credential. */
const DREP_A_CIP129 = 'drep1y242424242424242424242424242424242424242424242sdg97tu';
const DREP_A_CIP105 = 'drep_vkh1424242424242424242424242424242424242424242425xawa90';

/** A different DRep. */
const DREP_B_CIP129 = 'drep1y2amhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwcxwkjzd';

/** A script-hash DRep, which is a DRep like any other. */
const DREP_SCRIPT_CIP105 = 'drep_script1enxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvcmphcvc';

describe('the kinds offered', () => {
  it('offers the three that are in scope and nothing else', () => {
    // Registering a DRep of our own and voting on proposals directly are out of scope. A fourth kind
    // here is how they would arrive without a product decision.
    expect([...GOVERNANCE_TARGET_KINDS]).toEqual([
      'always_abstain',
      'always_no_confidence',
      'drep'
    ]);
  });
});

describe('which actions carry a target', () => {
  it('requires one for a vote delegation', () => {
    // The refusal that replaced the old behaviour. Before the target existed, `delegate_vote` with
    // nothing to aim at silently meant abstaining.
    expect(parseGovernanceTarget(undefined, 'delegate_vote')).toMatchObject({
      ok: false,
      refusal: 'required'
    });
    expect(parseGovernanceTarget(null, 'delegate_vote')).toMatchObject({
      ok: false,
      refusal: 'required'
    });
  });

  it('refuses one on an action that has none', () => {
    // A parameter that is merely ignored where it has no meaning is the kind that acquires one later
    // by accident.
    for (const action of ['withdraw_rewards', 'deregister', 'exit_and_send_max'] as const) {
      expect(parseGovernanceTarget({ kind: 'always_abstain' }, action), action).toMatchObject({
        ok: false,
        refusal: 'not_applicable'
      });
    }
  });

  it('refuses one on a registration, which delegates the vote by a different decision', () => {
    // A registration carries a vote delegation certificate too, and choosing its target is not part of
    // this scope: enrolment abstains, which is what unlocks withdrawals.
    expect(
      parseGovernanceTarget({ kind: 'always_no_confidence' }, 'register_and_delegate')
    ).toMatchObject({ ok: false, refusal: 'not_applicable' });
  });

  it('reads no target for an action that has none', () => {
    expect(parseGovernanceTarget(undefined, 'withdraw_rewards')).toEqual({
      ok: true,
      target: null
    });
  });
});

describe('the predefined targets', () => {
  it('reads an abstention', () => {
    const result = parseGovernanceTarget({ kind: 'always_abstain' }, 'delegate_vote');

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.target).toMatchObject({
      kind: 'always_abstain',
      drep: { kind: 'always_abstain' },
      credential: null,
      idCip129: null,
      canonical: 'always_abstain'
    });
  });

  it('reads a vote of no confidence', () => {
    const result = parseGovernanceTarget({ kind: 'always_no_confidence' }, 'delegate_vote');

    expect(result.ok && result.target).toMatchObject({
      kind: 'always_no_confidence',
      drep: { kind: 'always_no_confidence' },
      canonical: 'always_no_confidence'
    });
  });

  it('gives the two of them different canonical strings', () => {
    // They are opposite instructions. Sharing a canonical string would make a grant for one good for
    // the other, which is the binding this whole mechanism exists for.
    const abstain = parseGovernanceTarget({ kind: 'always_abstain' }, 'delegate_vote');
    const noConfidence = parseGovernanceTarget({ kind: 'always_no_confidence' }, 'delegate_vote');

    expect(abstain.ok && noConfidence.ok && abstain.target?.canonical).not.toBe(
      noConfidence.ok ? noConfidence.target?.canonical : ''
    );
  });

  it('ignores an identifier supplied beside a predefined kind', () => {
    // The kind is the discriminator. A predefined target has no credential, so an identifier next to
    // one is not part of what is being asked for and must not reach the signature.
    const result = parseGovernanceTarget(
      { kind: 'always_abstain', drep_id: DREP_A_CIP129 },
      'delegate_vote'
    );

    expect(result.ok && result.target).toMatchObject({
      canonical: 'always_abstain',
      idCip129: null,
      suppliedId: null
    });
  });
});

describe('a DRep target', () => {
  it('reads a CIP-129 identifier', () => {
    const result = parseGovernanceTarget({ kind: 'drep', drep_id: DREP_A_CIP129 }, 'delegate_vote');

    expect(result.ok && result.target).toMatchObject({
      kind: 'drep',
      idCip129: DREP_A_CIP129,
      suppliedId: DREP_A_CIP129,
      canonical: `drep:${DREP_A_CIP129}`
    });
  });

  it('reads the legacy CIP-105 spelling of the same DRep', () => {
    // Explorers and wallets still print this form, and it denotes the same credential.
    const result = parseGovernanceTarget({ kind: 'drep', drep_id: DREP_A_CIP105 }, 'delegate_vote');

    expect(result.ok && result.target?.idCip129).toBe(DREP_A_CIP129);
  });

  it('stores identity canonically while binding the spelling it was given', () => {
    // Two different jobs. `idCip129` is what a record is compared by; `canonical` is what a signature
    // covers, and it covers the literal request field so that neither side needs a parser to agree.
    const legacy = parseGovernanceTarget({ kind: 'drep', drep_id: DREP_A_CIP105 }, 'delegate_vote');
    const canonicalForm = parseGovernanceTarget(
      { kind: 'drep', drep_id: DREP_A_CIP129 },
      'delegate_vote'
    );

    expect(legacy.ok && legacy.target?.idCip129).toBe(
      canonicalForm.ok ? canonicalForm.target?.idCip129 : ''
    );
    expect(legacy.ok && legacy.target?.canonical).not.toBe(
      canonicalForm.ok ? canonicalForm.target?.canonical : ''
    );
  });

  it('reads a script-hash DRep', () => {
    const result = parseGovernanceTarget(
      { kind: 'drep', drep_id: DREP_SCRIPT_CIP105 },
      'delegate_vote'
    );

    expect(result.ok && result.target?.credential?.type).toBe('script_hash');
  });

  it('carries the credential a certificate is built from', () => {
    const result = parseGovernanceTarget({ kind: 'drep', drep_id: DREP_A_CIP129 }, 'delegate_vote');

    expect(result.ok && result.target?.drep).toEqual({
      kind: 'drep',
      credential: { type: 'key_hash', hashHex: 'aa'.repeat(28) }
    });
  });

  it('gives two different DReps two different canonical strings', () => {
    const one = parseGovernanceTarget({ kind: 'drep', drep_id: DREP_A_CIP129 }, 'delegate_vote');
    const two = parseGovernanceTarget({ kind: 'drep', drep_id: DREP_B_CIP129 }, 'delegate_vote');

    expect(one.ok && one.target?.canonical).not.toBe(two.ok ? two.target?.canonical : '');
  });

  it('trims the identifier before reading it', () => {
    const result = parseGovernanceTarget(
      { kind: 'drep', drep_id: `  ${DREP_A_CIP129}  ` },
      'delegate_vote'
    );

    expect(result.ok && result.target?.suppliedId).toBe(DREP_A_CIP129);
  });
});

describe('what is refused', () => {
  it('refuses something that is not a target at all', () => {
    for (const raw of ['always_abstain', 42, true, ['always_abstain']]) {
      expect(parseGovernanceTarget(raw, 'delegate_vote'), String(raw)).toMatchObject({
        ok: false,
        refusal: 'malformed'
      });
    }
  });

  it('refuses a kind outside the three', () => {
    // Including the kinds that exist in the model for a DRep of our own. Those are out of scope and a
    // target is not the way in.
    for (const kind of ['abstain', 'drep_script', 'register_drep', 'cast_drep_vote', '']) {
      expect(parseGovernanceTarget({ kind }, 'delegate_vote'), kind).toMatchObject({
        ok: false,
        refusal: 'malformed'
      });
    }
  });

  it('refuses a DRep with no identifier', () => {
    for (const raw of [
      { kind: 'drep' },
      { kind: 'drep', drep_id: '' },
      { kind: 'drep', drep_id: '   ' }
    ]) {
      expect(parseGovernanceTarget(raw, 'delegate_vote')).toMatchObject({
        ok: false,
        refusal: 'missing_drep_id'
      });
    }
  });

  it('refuses an identifier carrying the delimiter the signature is built on', () => {
    // The canonical form of an assertion joins its fields with a pipe. An identifier able to carry one
    // could be chosen to make two different claim sets canonicalise to the same string, and a
    // signature over that string would verify for both. Refused before it can reach one.
    for (const drepId of [
      'drep1abc|always_abstain',
      'drep1abc|5491133334444|delegate_vote',
      'drep1abc:extra',
      'drep1ABCDEFGHIJKL',
      'drep1 abc def ghi'
    ]) {
      expect(
        parseGovernanceTarget({ kind: 'drep', drep_id: drepId }, 'delegate_vote')
      ).toMatchObject({ ok: false, refusal: 'unsafe_drep_id' });
    }
  });

  it('refuses an identifier that does not decode as a DRep', () => {
    // Unreadable is not the same fact as absent, and it is certainly not the same as abstaining.
    for (const drepId of [
      'drep1qqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      'pool1424242424242424242424242424242424242424242425xawa90',
      'stake1u9testtesttesttesttesttesttesttesttesttesttesttest'
    ]) {
      expect(
        parseGovernanceTarget({ kind: 'drep', drep_id: drepId }, 'delegate_vote'),
        drepId
      ).toMatchObject({ ok: false, refusal: 'unreadable_drep_id' });
    }
  });

  it('refuses a committee credential written in the DRep scheme', () => {
    // CIP-129 labels constitutional committee keys with the same header byte scheme. Accepting one
    // would store a well-formed identifier for the wrong kind of thing.
    const committee = 'drep1qfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyyss62m3pq';

    expect(
      parseGovernanceTarget({ kind: 'drep', drep_id: committee }, 'delegate_vote')
    ).toMatchObject({ ok: false, refusal: 'unreadable_drep_id' });
  });
});

describe('the canonical string of an absent target', () => {
  it('is null rather than empty', () => {
    // An action with no governance meaning signs exactly what it signed before the target existed.
    expect(governanceTargetCanonical(null)).toBeNull();
  });

  it('is the target own canonical form otherwise', () => {
    const result = parseGovernanceTarget({ kind: 'always_abstain' }, 'delegate_vote');

    expect(governanceTargetCanonical(result.ok ? result.target : null)).toBe('always_abstain');
  });
});

describe('whether the credential already delegates there', () => {
  /**
   * A parsed target, for the comparisons below.
   *
   * @param raw - The wire target.
   * @returns The parsed target.
   */
  function target(raw: unknown) {
    const result = parseGovernanceTarget(raw, 'delegate_vote');
    if (!result.ok || result.target === null) throw new Error('fixture does not parse');
    return result.target;
  }

  it('says yes for the same predefined target', () => {
    expect(
      governanceTargetAlreadyInPlace({ kind: 'always_abstain' }, target({ kind: 'always_abstain' }))
    ).toBe(true);
  });

  it('says no for the other predefined target', () => {
    expect(
      governanceTargetAlreadyInPlace(
        { kind: 'always_abstain' },
        target({ kind: 'always_no_confidence' })
      )
    ).toBe(false);
  });

  it('says yes for the same DRep written the other way', () => {
    // The reason this comparison exists. The same DRep has a different string under each spelling, so
    // comparing as text would read "already there" as a change worth a network fee.
    expect(
      governanceTargetAlreadyInPlace(
        { kind: 'drep', idCip129: DREP_A_CIP129 },
        target({ kind: 'drep', drep_id: DREP_A_CIP105 })
      )
    ).toBe(true);
  });

  it('says no for a different DRep', () => {
    expect(
      governanceTargetAlreadyInPlace(
        { kind: 'drep', idCip129: DREP_A_CIP129 },
        target({ kind: 'drep', drep_id: DREP_B_CIP129 })
      )
    ).toBe(false);
  });

  it('says no when the credential delegates to nobody', () => {
    for (const kind of ['none', 'not_registered'] as const) {
      expect(
        governanceTargetAlreadyInPlace({ kind }, target({ kind: 'always_abstain' })),
        kind
      ).toBe(false);
    }
  });

  it('says no when nothing was read', () => {
    // An unread delegation is not a delegation that matches. Answering yes here would refuse the very
    // request that would establish one.
    expect(governanceTargetAlreadyInPlace(null, target({ kind: 'always_abstain' }))).toBe(false);
  });

  it('says no when the recorded DRep cannot be read', () => {
    expect(
      governanceTargetAlreadyInPlace(
        { kind: 'drep', idCip129: 'not-an-identifier' },
        target({ kind: 'drep', drep_id: DREP_A_CIP129 })
      )
    ).toBe(false);
  });
});

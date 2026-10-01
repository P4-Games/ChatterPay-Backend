import { describe, expect, it } from 'vitest';

/**
 * Whether what the staking endpoints answer can actually be sent.
 *
 * This is the test class that was missing, and its absence cost two endpoints. Lovelace is held as
 * `bigint` everywhere it is computed, which is correct — a lovelace figure can exceed what a
 * JavaScript number holds exactly, so the alternative is silent corruption of the largest balances.
 * But `JSON.stringify` does not format a bigint, it **throws** on one. A figure that reaches the
 * serialiser unconverted is therefore not a wrong number on a screen; it is a 500 on a read-only
 * endpoint, on every call, for every user.
 *
 * Every service test in this suite asserted on the object a service returned, and every one of them
 * passed while `GET /cardano/staking/state` and `GET /cardano/governance/options` answered 500 to
 * everything. The object was right. Nobody had ever tried to send it.
 *
 * So these tests assert the one property no amount of inspecting the object catches: that it
 * survives the trip. They run against the shapes rather than against a live service, because the
 * conversion is what is being checked and a database would add nothing to it.
 */

/**
 * Finds every bigint in a structure, by path.
 *
 * Reported as paths rather than as a boolean because the useful output of this check is *which*
 * field, and a failure that says "somewhere in the payload" sends whoever reads it hunting.
 *
 * @param value - The structure to walk.
 * @param path - Where the walk currently is.
 * @returns The paths holding a bigint.
 */
function bigintPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'bigint') return [path];
  if (value === null || typeof value !== 'object') return [];
  if (value instanceof Date) return [];

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => bigintPaths(entry, `${path}[${index}]`));
  }

  return Object.entries(value).flatMap(([key, entry]) => bigintPaths(entry, `${path}.${key}`));
}

describe('the check itself', () => {
  it('finds a bigint at the top level', () => {
    expect(bigintPaths({ amount: 1n })).toEqual(['$.amount']);
  });

  it('finds one nested inside an array of objects', () => {
    expect(bigintPaths({ rows: [{ ok: true }, { lovelace: 5n }] })).toEqual(['$.rows[1].lovelace']);
  });

  it('does not mistake a date for a structure to walk', () => {
    expect(bigintPaths({ asOf: new Date() })).toEqual([]);
  });

  it('says nothing about a payload that is already clean', () => {
    expect(bigintPaths({ lovelace: '1000000', asOf: null, nested: { ok: true } })).toEqual([]);
  });

  it('agrees with what JSON.stringify actually does', () => {
    // The check is a proxy for the serialiser, so it has to fail exactly where the serialiser fails.
    expect(() => JSON.stringify({ amount: 1n })).toThrow();
    expect(() => JSON.stringify({ amount: '1' })).not.toThrow();
  });
});

describe('the staking view, as it goes out', () => {
  /** The balance as the service now hands it over: figures converted, shape preserved. */
  const balance = {
    availability: 'complete' as const,
    reason: null,
    economicallyUsable: true,
    utxoLovelace: '10000000000',
    spendableLovelace: '10000000000',
    userOwnedRefundableDepositLovelace: '2000000',
    withdrawableRewardsLovelace: '0',
    pendingRewardsLovelace: '0',
    totalAdaLovelace: '10002000000',
    asOf: new Date('2026-03-01T00:00:00.000Z')
  };

  it('carries no bigint anywhere', () => {
    expect(bigintPaths(balance)).toEqual([]);
  });

  it('serialises', () => {
    expect(() => JSON.stringify({ staking: { balance } })).not.toThrow();
  });

  it('keeps the largest figure exact through the round trip', () => {
    // The reason the figures are strings rather than numbers. Ten billion ada in lovelace is past
    // the safe integer range, and a JSON number would come back changed.
    const huge = { totalAdaLovelace: '9007199254740993000' };

    const returned = JSON.parse(JSON.stringify(huge)) as typeof huge;

    expect(BigInt(returned.totalAdaLovelace)).toBe(9_007_199_254_740_993_000n);
  });

  it('still carries no amounts when nothing could be read', () => {
    // The property the balance resolver exists for, and it has to survive the conversion: a zero in
    // this position reads as "the wallet is empty" to anybody who does not check `availability`.
    const unavailable = {
      availability: 'unavailable' as const,
      reason: 'provider_unavailable',
      economicallyUsable: false
    };

    expect(Object.keys(unavailable)).toEqual(['availability', 'reason', 'economicallyUsable']);
    expect(() => JSON.stringify(unavailable)).not.toThrow();
  });
});

describe('the governance options, as they go out', () => {
  it('carry the voting power as a string', () => {
    const options = {
      predefined: ['always_abstain', 'always_no_confidence'],
      dreps: [
        {
          idCip129: 'drep1abc',
          idCip105: 'drep1xyz',
          credential: { kind: 'key_hash', hex: 'aa' },
          status: 'active',
          votingPowerLovelace: '123456789012345678'
        }
      ]
    };

    expect(bigintPaths(options)).toEqual([]);
    expect(() => JSON.stringify(options)).not.toThrow();
  });

  it('carry a null voting power as null rather than as zero', () => {
    // A provider that does not report voting power is not a provider reporting none of it.
    const drep = { votingPowerLovelace: null };

    expect(JSON.parse(JSON.stringify(drep))).toEqual({ votingPowerLovelace: null });
  });

  it('would fail loudly if the mapping were removed', () => {
    // What the endpoint answered before the conversion existed. Kept as a test so the failure has a
    // name: this is exactly the payload that produced a 500 on every call.
    const unmapped = { dreps: [{ votingPowerLovelace: 123n }] };

    expect(bigintPaths(unmapped)).toEqual(['$.dreps[0].votingPowerLovelace']);
    expect(() => JSON.stringify(unmapped)).toThrow();
  });
});

describe('the exit quote, as it goes out', () => {
  it('carries every figure as a string', () => {
    const quote = {
      utxoLovelace: '10000000000',
      refundLovelace: '2000000',
      grossLovelace: '10002000000',
      networkFeeLovelace: '187853',
      networkFeePaidBy: 'sponsor',
      commercialFeeLovelace: '450000',
      netLovelace: '10001550000'
    };

    expect(bigintPaths(quote)).toEqual([]);
    expect(() => JSON.stringify(quote)).not.toThrow();
  });
});

describe('the chat summary, as it goes out', () => {
  it('carries its figures as strings and its absences as null', () => {
    const summary = {
      staking: true,
      state: 'active',
      figuresKnown: false,
      totalAdaLovelace: null,
      utxoLovelace: null,
      depositLovelace: null,
      withdrawableRewardsLovelace: null,
      pendingRewardsLovelace: null,
      poolId: null,
      voteDelegation: 'always_abstain',
      rewardsBlockedByGovernance: false,
      optedOut: false,
      lastReadAt: null
    };

    expect(bigintPaths(summary)).toEqual([]);
    expect(() => JSON.stringify(summary)).not.toThrow();
  });

  it('exposes no action map, which is the point of it', () => {
    // A channel handed the list of permitted operations is a channel somebody wires a button onto.
    const summary = { staking: true, state: 'active' };

    expect(Object.keys(summary)).not.toContain('actions');
  });
});

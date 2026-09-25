import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readCardanoEnv } from '../../src/helpers/envHelper';

/**
 * How a configured chain id is read, before anything decides what to do about it.
 *
 * Covered on its own because every other Cardano suite mocks `readCardanoEnv` wholesale and hands
 * the configuration an already-parsed object. That leaves the parsing itself — the step between a
 * string somebody typed into a deploy trigger and a number the key derivation is bound to —
 * exercised by nothing.
 *
 * The distinction being pinned is absent against present-and-unusable. Both used to read as "no
 * value", which made `0`, a negative and a truncated paste indistinguishable from an empty setting
 * and therefore answerable with the network's default.
 */

/**
 * What the environment says the chain id is, for the case being run.
 *
 * Hoisted, because the mock factory below runs before anything else in this file and a plain `let`
 * would not exist yet. Read through a getter so a case can change it without reloading the module.
 */
const state = vi.hoisted(() => ({ chainId: '' }));

vi.mock('../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/constants')>();
  return Object.defineProperties(
    { ...actual },
    { CARDANO_CHAIN_ID: { get: () => state.chainId, enumerable: true } }
  );
});

/**
 * Reads the chain id as configured.
 *
 * @param raw - The value the environment holds.
 * @returns What the reader makes of it.
 */
function read(raw: string): number | 'invalid' | null {
  state.chainId = raw;
  return readCardanoEnv().chainId;
}

beforeEach(() => {
  state.chainId = '';
});

describe('the configured Cardano chain id', () => {
  it('reads a whole positive number', () => {
    expect(read('900000000001')).toBe(900000000001);
    expect(read('900764824073')).toBe(900764824073);
  });

  it('ignores surrounding whitespace, which a copied value carries', () => {
    expect(read('  900000000001  ')).toBe(900000000001);
  });

  it.each(['', '   '])('reads %j as absent, which is what lets the network decide', (raw) => {
    expect(read(raw)).toBeNull();
  });

  it.each([
    ['abc', 'not a number at all'],
    ['900000000001abc', 'a paste with something after it'],
    ['0', 'zero, which identifies no network'],
    ['-900000000001', 'a negative'],
    ['1.5', 'a decimal'],
    ['9e11', 'exponent notation'],
    ['0x900000000001', 'hexadecimal'],
    ['900_000_000_001', 'digit separators'],
    ['99999999999999999999', 'past the safe integer range']
  ])('refuses %j — %s', (raw) => {
    expect(read(raw)).toBe('invalid');
  });

  it('does not truncate, which is the failure a parseInt would have', () => {
    // The one that matters most: read loosely this is 900000000001, a perfectly usable id, and the
    // deployment would come up deriving against it without a word.
    expect(read('900000000001x')).not.toBe(900000000001);
  });
});

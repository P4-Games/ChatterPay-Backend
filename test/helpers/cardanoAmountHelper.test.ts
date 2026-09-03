import { describe, expect, it } from 'vitest';

import {
  adaToLovelace,
  lovelaceToAda,
  lovelaceToAdaNumber
} from '../../src/helpers/cardanoAmountHelper';

describe('adaToLovelace', () => {
  it('converts whole and fractional amounts', () => {
    expect(adaToLovelace('1')).toBe(1_000_000n);
    expect(adaToLovelace('2.5')).toBe(2_500_000n);
    expect(adaToLovelace('0.000001')).toBe(1n);
    expect(adaToLovelace('1000000')).toBe(1_000_000_000_000n);
  });

  it('does not go through a float', () => {
    // `0.07 * 1e6` is 70000.00000000001 in IEEE 754. A lovelace off is a transaction that does not
    // balance, which the chain rejects outright.
    expect(adaToLovelace('0.07')).toBe(70_000n);
    expect(adaToLovelace('0.29')).toBe(290_000n);
    expect(adaToLovelace('1.1')).toBe(1_100_000n);
    expect(adaToLovelace('8.16')).toBe(8_160_000n);
  });

  it('pads a short fraction rather than misreading it', () => {
    // "2.5" is two and a half ADA, not two ADA and five lovelace.
    expect(adaToLovelace('2.5')).toBe(2_500_000n);
    expect(adaToLovelace('2.05')).toBe(2_050_000n);
    expect(adaToLovelace('2.000005')).toBe(2_000_005n);
  });

  it('tolerates surrounding whitespace', () => {
    expect(adaToLovelace('  2.5  ')).toBe(2_500_000n);
  });

  it('refuses more precision than ADA can represent', () => {
    // Truncating here would move a different amount than the user asked for.
    expect(() => adaToLovelace('1.0000001')).toThrow('CARDANO_AMOUNT_TOO_PRECISE');
  });

  it('refuses anything that is not a plain positive decimal', () => {
    for (const bad of ['', '0', '0.0', '-1', '1,5', 'abc', '1e6', '1.2.3', '.5', '1.', '+1']) {
      expect(() => adaToLovelace(bad), bad).toThrow(/CARDANO_(INVALID_AMOUNT|AMOUNT_TOO_PRECISE)/);
    }
  });
});

describe('lovelaceToAda', () => {
  it('always prints six decimals, so two values compare as strings', () => {
    expect(lovelaceToAda(1_000_000n)).toBe('1.000000');
    expect(lovelaceToAda(2_500_000n)).toBe('2.500000');
    expect(lovelaceToAda(1n)).toBe('0.000001');
    expect(lovelaceToAda(0n)).toBe('0.000000');
    expect(lovelaceToAda(165_941n)).toBe('0.165941');
  });

  it('round-trips with adaToLovelace', () => {
    for (const amount of ['1.000000', '0.165941', '12.834059', '1000000.000000']) {
      expect(lovelaceToAda(adaToLovelace(amount))).toBe(amount);
    }
  });
});

describe('lovelaceToAdaNumber', () => {
  it('converts for the numeric fields the transaction schema uses', () => {
    expect(lovelaceToAdaNumber(1_000_000n)).toBe(1);
    expect(lovelaceToAdaNumber(165_941n)).toBeCloseTo(0.165941, 9);
  });
});

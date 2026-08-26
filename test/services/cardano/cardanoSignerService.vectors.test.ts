import { describe, expect, it, vi } from 'vitest';

const CHAIN_ID = 900000000001;
const PHONE = '5491100000001';
const WALLET_ID = 'w';
const TX_ID = '0'.repeat(64);

vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  return {
    ...actual,
    $S: 'x',
    $B: 'y',
    CDC1: '743a643a',
    CDC2: '743a633a',
    CDC3: '7430',
    CDC4: '743a6b3a',
    CDC5: '743a733a',
    CDC6: '743a73733a'
  };
});

const { cardanoSignerService } = await import('../../../src/services/cardano/cardanoSignerService');

describe('cardanoSignerService - fixed outputs', () => {
  it('matches the recorded user account', () => {
    const account = cardanoSignerService.getAccount(PHONE, 'testnet', CHAIN_ID);
    expect(account.address).toBe(
      'addr_test1qz96mtwpjqcr4gmtev240lptedjfyc7m00zyw8y9swjy9zpyt5xntzy445s2snx5ek7lhn3x6erfjw7wqeks0nl7kqasu7k88k'
    );
    expect(account.publicKey).toBe(
      '0xde5e798a75236f3353d841a8dc1d3d58abf0b1a15a2c192adbdc20ea342f4fa7'
    );
    expect(account.stakePublicKey).toBe(
      '0xb41824dbdf29e46977dfe17bd40b32455f4ce2b2709ab7fc79e7ef258cd4b349'
    );
  });

  it('matches the recorded sponsor account', () => {
    const account = cardanoSignerService.getSponsorAccount(WALLET_ID, 'testnet', CHAIN_ID);
    expect(account.address).toBe(
      'addr_test1qr8dqak7stwpe5p247sckuws00g2welcjgutzp0mvxk6x4qcrjpypqcmyjjs36ah96gz25f037qdehza68ecwpnqlxkshlvduq'
    );
    expect(account.publicKey).toBe(
      '0x65d62edc189c53317e3ce04e1b3707cadad250655d5301bd948d9cda5b905efc'
    );
    expect(account.stakePublicKey).toBe(
      '0x0d90af9ac91c78874fff4d16bc001137a86be9f5bda375dde0e61b5147d320e6'
    );
  });

  it('matches the recorded signature', () => {
    expect(cardanoSignerService.sign(PHONE, 'testnet', CHAIN_ID, TX_ID)).toBe(
      '0x53eaf0a8e641235772391ef25069d28add5ea25fbc51ff425dfdef44ca118ebab0b1859c00bb561c6ecb7565e0331967f76f7d0146f3751cca63ea3907c1ef0e'
    );
  });

  it('keeps every account distinct from every other', () => {
    const user = cardanoSignerService.getAccount(PHONE, 'testnet', CHAIN_ID);
    const sponsor = cardanoSignerService.getSponsorAccount(WALLET_ID, 'testnet', CHAIN_ID);
    const keys = [user.publicKey, user.stakePublicKey, sponsor.publicKey, sponsor.stakePublicKey];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('$hx', () => {
  it('refuses anything that is not a whole number of hex bytes', async () => {
    const { $hx } = await import('../../../src/helpers/envHelper');
    for (const value of [undefined, '', '   ', 'not-hex', 'zz', '7631a', '0x7631']) {
      expect(() => $hx(value), String(value)).toThrow('CONFIG_HEX_INVALID');
    }
    expect($hx('7430')).toBe('t0');
  });
});

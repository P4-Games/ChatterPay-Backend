import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';

import {
  baseAddress,
  decodeCardanoAddress,
  enterpriseAddress,
  isValidCardanoAddress,
  paymentCredential
} from '../../../src/services/cardano/cardanoAddressService';

/**
 * Official CIP-19 test vectors.
 *
 * Taken from the specification itself rather than produced by this implementation, which is the
 * whole point: a round-trip test only proves the code agrees with itself, and the failure mode that
 * matters here — a header nibble on the wrong side, a network id inverted — round-trips perfectly
 * while producing addresses nobody can spend from.
 *
 * @see https://github.com/cardano-foundation/CIPs/blob/master/CIP-0019/README.md
 */
const CIP19 = {
  paymentVerificationKey: 'addr_vk1w0l2sr2zgfm26ztc6nl9xy8ghsk5sh6ldwemlpmp9xylzy4dtf7st80zhd',
  paymentKeyHash: '9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e',
  stakeVerificationKey: 'stake_vk1px4j0r2fk7ux5p23shz8f3y5y2qam7s954rgf3lg5merqcj6aetsft99wu',
  stakeKeyHash: '337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251',
  mainnet: {
    type00: 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x',
    type02: 'addr1yx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerkr0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs2z78ve',
    type04: 'addr1gx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrzqf96k',
    type06: 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8'
  },
  testnet: {
    type00: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae',
    type02: 'addr_test1yz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerkr0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shsf5r8qx',
    type05: 'addr_test12rphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtupnz75xxcryqrvmw',
    type06: 'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz'
  }
};

/** The raw 32-byte Ed25519 payment public key behind the CIP-19 vectors. */
const PUBLIC_KEY = Buffer.from(
  bech32.fromWords(bech32.decode(CIP19.paymentVerificationKey as `${string}1${string}`, 256).words)
).toString('hex');

/** The raw 32-byte Ed25519 staking public key behind the CIP-19 vectors. */
const STAKE_PUBLIC_KEY = Buffer.from(
  bech32.fromWords(bech32.decode(CIP19.stakeVerificationKey as `${string}1${string}`, 256).words)
).toString('hex');

describe('cardanoAddressService - paymentCredential', () => {
  it('reproduces the payment key hash of the CIP-19 vectors', () => {
    expect(Buffer.from(paymentCredential(PUBLIC_KEY)).toString('hex')).toBe(CIP19.paymentKeyHash);
  });

  it('accepts the key with or without the 0x prefix', () => {
    expect(Buffer.from(paymentCredential(`0x${PUBLIC_KEY}`)).toString('hex')).toBe(
      CIP19.paymentKeyHash
    );
  });

  it('rejects a key that is not 32 bytes', () => {
    // A compressed secp256k1 point is 33 bytes and would otherwise hash into a plausible-looking
    // address for a key that cannot sign for it.
    const secp256k1Point = `02${'ab'.repeat(32)}`;
    expect(() => paymentCredential(secp256k1Point)).toThrow('CARDANO_PUBLIC_KEY_MUST_BE_32_BYTES');
    expect(() => paymentCredential('deadbeef')).toThrow('CARDANO_PUBLIC_KEY_MUST_BE_32_BYTES');
    expect(() => paymentCredential('zz'.repeat(32))).toThrow('CARDANO_PUBLIC_KEY_MUST_BE_32_BYTES');
  });
});

describe('cardanoAddressService - baseAddress', () => {
  it('matches the CIP-19 type-00 mainnet vector', () => {
    expect(baseAddress(PUBLIC_KEY, STAKE_PUBLIC_KEY, 'mainnet')).toBe(CIP19.mainnet.type00);
  });

  it('matches the CIP-19 type-00 testnet vector', () => {
    expect(baseAddress(PUBLIC_KEY, STAKE_PUBLIC_KEY, 'testnet')).toBe(CIP19.testnet.type00);
  });

  it('produces a different address per network for the same keys', () => {
    // The network lives inside the address. Deriving a mainnet address on a Preprod deployment
    // produces a well-formed address nobody can spend from, and no later check would catch it.
    expect(baseAddress(PUBLIC_KEY, STAKE_PUBLIC_KEY, 'mainnet')).not.toBe(
      baseAddress(PUBLIC_KEY, STAKE_PUBLIC_KEY, 'testnet')
    );
  });

  it('puts the payment credential first and the staking one second', () => {
    // Swapping the two produces a perfectly valid address whose funds are spendable only by the
    // staking key — which signs nothing here, so the funds would be spendable by nobody.
    const swapped = baseAddress(STAKE_PUBLIC_KEY, PUBLIC_KEY, 'mainnet');
    expect(swapped).not.toBe(CIP19.mainnet.type00);

    const decoded = decodeCardanoAddress(CIP19.mainnet.type00);
    expect(decoded?.credentialHex).toBe(CIP19.paymentKeyHash);
    expect(decoded?.stakeCredentialHex).toBe(CIP19.stakeKeyHash);
  });

  it('rejects a staking key that is not 32 bytes', () => {
    expect(() => baseAddress(PUBLIC_KEY, 'deadbeef', 'mainnet')).toThrow(
      'CARDANO_PUBLIC_KEY_MUST_BE_32_BYTES'
    );
  });
});

describe('cardanoAddressService - enterpriseAddress', () => {
  it('matches the CIP-19 type-06 mainnet vector', () => {
    expect(enterpriseAddress(PUBLIC_KEY, 'mainnet')).toBe(CIP19.mainnet.type06);
  });

  it('matches the CIP-19 type-06 testnet vector', () => {
    expect(enterpriseAddress(PUBLIC_KEY, 'testnet')).toBe(CIP19.testnet.type06);
  });

  it('produces a different address per network for the same key', () => {
    // The network lives inside the address. Deriving a mainnet address on a Preprod deployment
    // produces a well-formed address nobody can spend from, and no later check would catch it.
    expect(enterpriseAddress(PUBLIC_KEY, 'mainnet')).not.toBe(
      enterpriseAddress(PUBLIC_KEY, 'testnet')
    );
  });
});

describe('cardanoAddressService - decodeCardanoAddress', () => {
  it('reads back an address this service issued', () => {
    const decoded = decodeCardanoAddress(baseAddress(PUBLIC_KEY, STAKE_PUBLIC_KEY, 'testnet'));
    expect(decoded).not.toBeNull();
    expect(decoded?.network).toBe('testnet');
    expect(decoded?.addressType).toBe(0);
    expect(decoded?.credentialHex).toBe(CIP19.paymentKeyHash);
    expect(decoded?.stakeCredentialHex).toBe(CIP19.stakeKeyHash);
    // Header byte first: the bytes that go into a transaction output.
    expect(decoded?.payload.length).toBe(57);
    expect(decoded?.payload[0]).toBe(0x00);
  });

  it('reads back an enterprise address, which carries no staking part', () => {
    const decoded = decodeCardanoAddress(enterpriseAddress(PUBLIC_KEY, 'testnet'));
    expect(decoded?.addressType).toBe(6);
    expect(decoded?.credentialHex).toBe(CIP19.paymentKeyHash);
    expect(decoded?.stakeCredentialHex).toBeUndefined();
    expect(decoded?.payload.length).toBe(29);
    expect(decoded?.payload[0]).toBe(0x60);
  });

  it('accepts base addresses, which is what external wallets hand out', () => {
    // Refusing type 0 would refuse every destination a user copies from Eternl, Lace or Daedalus.
    for (const [address, network, type] of [
      [CIP19.mainnet.type00, 'mainnet', 0],
      [CIP19.testnet.type00, 'testnet', 0],
      [CIP19.mainnet.type02, 'mainnet', 2],
      [CIP19.testnet.type02, 'testnet', 2]
    ] as const) {
      const decoded = decodeCardanoAddress(address);
      expect(decoded, address).not.toBeNull();
      expect(decoded?.network).toBe(network);
      expect(decoded?.addressType).toBe(type);
      // The payment credential is the first 28 bytes after the header, staking part excluded.
      expect(decoded?.credentialHex).toBe(CIP19.paymentKeyHash);
    }
  });

  it('rejects pointer addresses, deprecated in the Conway era', () => {
    expect(decodeCardanoAddress(CIP19.mainnet.type04)).toBeNull();
    expect(decodeCardanoAddress(CIP19.testnet.type05)).toBeNull();
  });

  it('rejects a typo: the checksum is what makes a wrong character a rejection', () => {
    const valid = CIP19.testnet.type06;
    const typo = `${valid.slice(0, -1)}${valid.at(-1) === 'z' ? 'x' : 'z'}`;
    expect(typo).not.toBe(valid);
    expect(decodeCardanoAddress(typo)).toBeNull();
  });

  it('rejects a truncated address that would otherwise look well formed', () => {
    expect(decodeCardanoAddress(CIP19.testnet.type06.slice(0, -6))).toBeNull();
  });

  it('rejects anything that is not a Cardano address', () => {
    for (const value of [
      '',
      'not-an-address',
      '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      'stake_test1uqevw2xnsc0pvn9t9r9c7qryfqfeerchgrlm6ear9y96sc998twz2'
    ]) {
      expect(decodeCardanoAddress(value), value).toBeNull();
    }
  });

  it('rejects a mixed-case address, which bech32 defines as invalid', () => {
    expect(decodeCardanoAddress(CIP19.testnet.type06.toUpperCase())).toBeNull();
  });
});

describe('cardanoAddressService - isValidCardanoAddress', () => {
  it('refuses a mainnet address on a testnet deployment, and the reverse', () => {
    // The two look alike enough to be pasted for one another, and the funds would leave for a chain
    // this deployment does not operate on.
    expect(isValidCardanoAddress(CIP19.mainnet.type06, 'testnet')).toBe(false);
    expect(isValidCardanoAddress(CIP19.testnet.type06, 'mainnet')).toBe(false);
  });

  it('accepts an address of the network it is asked about', () => {
    expect(isValidCardanoAddress(CIP19.testnet.type06, 'testnet')).toBe(true);
    expect(isValidCardanoAddress(CIP19.testnet.type00, 'testnet')).toBe(true);
    expect(isValidCardanoAddress(CIP19.mainnet.type06, 'mainnet')).toBe(true);
  });
});

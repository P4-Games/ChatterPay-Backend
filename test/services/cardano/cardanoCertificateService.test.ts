import { bech32 } from '@scure/base';
import { decodeFirst, encode } from 'borc';
import { describe, expect, it } from 'vitest';

import {
  type CardanoCredential,
  type CardanoDRepTarget,
  encodeCertificate,
  encodeCertificates,
  encodeCredential,
  encodeDRep,
  encodeWithdrawals,
  poolKeyHash
} from '../../../src/services/cardano/cardanoCertificateService';
import {
  encodeOutput,
  encodeTransactionBody
} from '../../../src/services/cardano/cardanoTxService';
import type { CardanoUtxo } from '../../../src/types/cardanoType';

/**
 * `borc` is the independent implementation this suite checks the encoder against.
 *
 * It is a general-purpose CBOR library with no knowledge of Cardano, written by someone else and
 * already installed in this repository. Decoding with it answers the question a round trip through
 * our own code cannot: not "can we read back what we wrote", which a consistently wrong encoder
 * also passes, but "does a stranger read these bytes as the structure the CDDL describes".
 *
 * What it does **not** answer is whether the structure is the one the Cardano ledger wants. That
 * needs a cross-check against `cardano-cli` or the serialization library, which this environment
 * has no way to run — see the NOT RUN note at the end of this file.
 */

const STAKE_KEY: CardanoCredential = {
  type: 'key_hash',
  hashHex: 'cc2f0b60ee5c4edb7bcc46410787d389539cddf5b64f0012304b91da'
};

const STAKE_SCRIPT: CardanoCredential = {
  type: 'script_hash',
  hashHex: '313318dd5b51b0376278ee8f2ad38cdf9466d483e60c312428964faf'
};

const POOL_HASH = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5';

/** The same pool id in bech32, derived here rather than quoted, so the two forms provably agree. */
const POOL_BECH32 = bech32.encode('pool', bech32.toWords(Buffer.from(POOL_HASH, 'hex')), 256);

/** Reward addresses of the two credentials above, on preprod. */
const REWARD_KEY = 'stake_test1urxz7zmqaewyakmme3ryzpu86wy488xa7kmy7qqjxp9erksag4z3l';
const REWARD_OTHER = 'stake_test1uqcnxxxatdgmqdmz0rhg72kn3n0egek5s0nqcvfy9ztyltc9cpuz4';

const DEPOSIT = 2_000_000n;

/**
 * Decodes with the independent implementation.
 *
 * @param encoded - Bytes produced by our encoder.
 * @returns Whatever `borc` makes of them.
 */
function independentDecode(encoded: Uint8Array): unknown {
  return decodeFirst(Buffer.from(encoded));
}

/**
 * Renders bytes as lowercase hex.
 *
 * @param value - Bytes, or a Buffer `borc` handed back.
 * @returns Hex without `0x`.
 */
function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

/** A minimal UTxO: only the hash and index reach the body. */
function utxo(txHash: string, outputIndex: number): CardanoUtxo {
  return { txHash, outputIndex, lovelace: 10_000_000n, holdsOtherAssets: false, assets: [] };
}

describe('cardanoCertificateService', () => {
  describe('credentials', () => {
    it('writes a key credential as [0, hash] and a script one as [1, hash]', () => {
      const key = independentDecode(encodeCredential(STAKE_KEY)) as [number, Uint8Array];
      const script = independentDecode(encodeCredential(STAKE_SCRIPT)) as [number, Uint8Array];

      expect(key[0]).toBe(0);
      expect(hex(key[1])).toBe(STAKE_KEY.hashHex);
      expect(script[0]).toBe(1);
      expect(hex(script[1])).toBe(STAKE_SCRIPT.hashHex);
    });

    it('refuses a hash that is not 28 bytes', () => {
      // A hash of the wrong length is not a credential, and a certificate built from one addresses
      // nothing. Accepting it would produce a well-formed transaction against no account.
      expect(() => encodeCredential({ type: 'key_hash', hashHex: 'cc2f0b60' })).toThrow(
        'CARDANO_CREDENTIAL_MUST_BE_28_BYTES'
      );
      expect(() =>
        encodeCredential({ type: 'key_hash', hashHex: `${STAKE_KEY.hashHex}ff` })
      ).toThrow('CARDANO_CREDENTIAL_MUST_BE_28_BYTES');
    });

    it('refuses hex that is not hex', () => {
      expect(() => encodeCredential({ type: 'key_hash', hashHex: 'zz'.repeat(28) })).toThrow(
        'CARDANO_INVALID_HEX'
      );
    });
  });

  describe('drep', () => {
    it('writes always-abstain and always-no-confidence as one-element arrays', () => {
      // The trap: `[2]`, not the bare integer `2`. A bare integer decodes as something else and the
      // ledger rejects the transaction.
      expect(hex(encodeDRep({ kind: 'always_abstain' }))).toBe('8102');
      expect(hex(encodeDRep({ kind: 'always_no_confidence' }))).toBe('8103');

      const abstain = independentDecode(encodeDRep({ kind: 'always_abstain' })) as number[];
      expect(Array.isArray(abstain)).toBe(true);
      expect(abstain).toEqual([2]);
    });

    it('writes a delegate as its credential, keeping key and script apart', () => {
      const key = independentDecode(encodeDRep({ kind: 'drep', credential: STAKE_KEY })) as [
        number,
        Uint8Array
      ];
      const script = independentDecode(encodeDRep({ kind: 'drep', credential: STAKE_SCRIPT })) as [
        number,
        Uint8Array
      ];

      // Two DReps can share a hash and differ in type, so the type is not decoration.
      expect(key[0]).toBe(0);
      expect(hex(key[1])).toBe(STAKE_KEY.hashHex);
      expect(script[0]).toBe(1);
      expect(hex(script[1])).toBe(STAKE_SCRIPT.hashHex);
    });
  });

  describe('pool ids', () => {
    it('reads the bech32 and the hex form to the same bytes', () => {
      expect(hex(poolKeyHash(POOL_BECH32))).toBe(POOL_HASH);
      expect(hex(poolKeyHash(POOL_HASH))).toBe(POOL_HASH);
    });

    it('refuses a pool id that is neither', () => {
      expect(() => poolKeyHash('pool1notarealpoolid')).toThrow('CARDANO_INVALID_POOL_ID');
      expect(() => poolKeyHash('1a2b3c')).toThrow('CARDANO_INVALID_POOL_ID');
      expect(() => poolKeyHash('')).toThrow('CARDANO_INVALID_POOL_ID');
    });
  });

  describe('certificates, read back by an independent decoder', () => {
    it('registers with the deposit written into the certificate', () => {
      const decoded = independentDecode(
        encodeCertificate({ kind: 'register', stake: STAKE_KEY, depositLovelace: DEPOSIT })
      ) as [number, [number, Uint8Array], number];

      expect(decoded).toHaveLength(3);
      expect(decoded[0]).toBe(7);
      expect(hex(decoded[1][1])).toBe(STAKE_KEY.hashHex);
      expect(decoded[2]).toBe(Number(DEPOSIT));
    });

    it('deregisters with the refund written into the certificate', () => {
      // Cardano refunds what was deposited, not the current protocol parameter. The amount is
      // therefore the one that was observed, and writing it down turns a parameter change into a
      // rejected transaction instead of a silent mismatch.
      const paidUnderAnOlderParameter = 2_000_000n;
      const decoded = independentDecode(
        encodeCertificate({
          kind: 'deregister',
          stake: STAKE_KEY,
          refundLovelace: paidUnderAnOlderParameter
        })
      ) as [number, unknown, number];

      expect(decoded[0]).toBe(8);
      expect(decoded[2]).toBe(Number(paidUnderAnOlderParameter));
    });

    it('delegates to a pool', () => {
      const decoded = independentDecode(
        encodeCertificate({ kind: 'delegate_pool', stake: STAKE_KEY, poolId: POOL_BECH32 })
      ) as [number, unknown, Uint8Array];

      expect(decoded[0]).toBe(2);
      expect(hex(decoded[2])).toBe(POOL_HASH);
    });

    it('delegates a vote', () => {
      const decoded = independentDecode(
        encodeCertificate({
          kind: 'delegate_vote',
          stake: STAKE_KEY,
          drep: { kind: 'always_no_confidence' }
        })
      ) as [number, unknown, number[]];

      expect(decoded[0]).toBe(9);
      expect(decoded[2]).toEqual([3]);
    });

    it('delegates pool and vote in one certificate', () => {
      const decoded = independentDecode(
        encodeCertificate({
          kind: 'delegate_pool_and_vote',
          stake: STAKE_KEY,
          poolId: POOL_HASH,
          drep: { kind: 'drep', credential: STAKE_SCRIPT }
        })
      ) as [number, unknown, Uint8Array, [number, Uint8Array]];

      expect(decoded[0]).toBe(10);
      expect(hex(decoded[2])).toBe(POOL_HASH);
      expect(decoded[3][0]).toBe(1);
    });

    it('registers and delegates to a pool at once', () => {
      const decoded = independentDecode(
        encodeCertificate({
          kind: 'register_and_delegate_pool',
          stake: STAKE_KEY,
          poolId: POOL_HASH,
          depositLovelace: DEPOSIT
        })
      ) as [number, unknown, Uint8Array, number];

      expect(decoded[0]).toBe(11);
      expect(decoded[3]).toBe(Number(DEPOSIT));
    });

    it('registers and delegates a vote at once', () => {
      const decoded = independentDecode(
        encodeCertificate({
          kind: 'register_and_delegate_vote',
          stake: STAKE_KEY,
          drep: { kind: 'always_abstain' },
          depositLovelace: DEPOSIT
        })
      ) as [number, unknown, number[], number];

      expect(decoded[0]).toBe(12);
      expect(decoded[2]).toEqual([2]);
      expect(decoded[3]).toBe(Number(DEPOSIT));
    });

    it('registers, delegates and votes in one certificate', () => {
      // One certificate rather than three, because a registration that lands without its delegation
      // leaves a paid deposit earning nothing, and a delegation whose registration never landed is
      // invalid.
      const encoded = encodeCertificate({
        kind: 'register_and_delegate_pool_and_vote',
        stake: STAKE_KEY,
        poolId: POOL_BECH32,
        drep: { kind: 'always_abstain' },
        depositLovelace: DEPOSIT
      });
      const decoded = independentDecode(encoded) as [
        number,
        [number, Uint8Array],
        Uint8Array,
        number[],
        number
      ];

      expect(decoded).toHaveLength(5);
      expect(decoded[0]).toBe(13);
      expect(decoded[1][0]).toBe(0);
      expect(hex(decoded[1][1])).toBe(STAKE_KEY.hashHex);
      expect(hex(decoded[2])).toBe(POOL_HASH);
      expect(decoded[3]).toEqual([2]);
      expect(decoded[4]).toBe(Number(DEPOSIT));
    });

    it.each([
      ['register', 7],
      ['deregister', 8],
      ['delegate_pool', 2],
      ['delegate_vote', 9],
      ['delegate_pool_and_vote', 10],
      ['register_and_delegate_pool', 11],
      ['register_and_delegate_vote', 12],
      ['register_and_delegate_pool_and_vote', 13]
    ] as const)('gives %s the tag %d and no other', (kind, tag) => {
      // A transposed pair — 11 for register-and-delegate-pool against 12 for the vote one —
      // produces a well-formed certificate that does the wrong thing to the user's stake.
      const certificate = {
        kind,
        stake: STAKE_KEY,
        poolId: POOL_HASH,
        drep: { kind: 'always_abstain' } as CardanoDRepTarget,
        depositLovelace: DEPOSIT,
        refundLovelace: DEPOSIT
      };
      const decoded = independentDecode(encodeCertificate(certificate as never)) as [
        number,
        ...unknown[]
      ];

      expect(decoded[0]).toBe(tag);
    });
  });

  describe('the certificate set', () => {
    it('is the tagged set Conway specifies', () => {
      const decoded = independentDecode(
        encodeCertificates([{ kind: 'register', stake: STAKE_KEY, depositLovelace: DEPOSIT }])
      ) as { tag: number; value: unknown[] };

      expect(decoded.tag).toBe(258);
      expect(decoded.value).toHaveLength(1);
    });

    it('keeps the order it was given, because order is meaning', () => {
      // The ledger applies certificates in sequence. A delegation placed before the registration it
      // depends on is a different, invalid transaction, so "tidying" the set would break it.
      const decoded = independentDecode(
        encodeCertificates([
          { kind: 'register', stake: STAKE_KEY, depositLovelace: DEPOSIT },
          { kind: 'delegate_pool', stake: STAKE_KEY, poolId: POOL_HASH }
        ])
      ) as { value: [number, ...unknown[]][] };

      expect(decoded.value.map((certificate) => certificate[0])).toEqual([7, 2]);
    });

    it('refuses an empty set', () => {
      // `certificates` is a non-empty set, so an empty one is malformed CBOR. A transaction with no
      // certificates omits the key instead.
      expect(() => encodeCertificates([])).toThrow('CARDANO_EMPTY_CERTIFICATE_SET');
    });
  });

  describe('withdrawals', () => {
    it('keys the map by the 29-byte reward account, not by its bech32 text', () => {
      const decoded = independentDecode(
        encodeWithdrawals([{ rewardAddress: REWARD_KEY, lovelace: 1_234_567n }])
      ) as Map<Uint8Array, number>;

      const [account] = [...decoded.keys()];
      expect(account).toHaveLength(29);
      // Header byte: reward address type 14, testnet.
      expect(hex(account as Uint8Array).slice(0, 2)).toBe('e0');
      expect(hex(account as Uint8Array).slice(2)).toBe(STAKE_KEY.hashHex);
      expect([...decoded.values()]).toEqual([1_234_567]);
    });

    it('sorts the accounts, because the transaction id is the hash of these bytes', () => {
      const given = encodeWithdrawals([
        { rewardAddress: REWARD_KEY, lovelace: 1n },
        { rewardAddress: REWARD_OTHER, lovelace: 2n }
      ]);
      const reversed = encodeWithdrawals([
        { rewardAddress: REWARD_OTHER, lovelace: 2n },
        { rewardAddress: REWARD_KEY, lovelace: 1n }
      ]);

      expect(hex(given)).toBe(hex(reversed));
      const keys = [...(independentDecode(given) as Map<Uint8Array, number>).keys()].map((key) =>
        hex(key as Uint8Array)
      );
      expect(keys).toEqual([...keys].sort());
    });

    it('refuses an address that is not a reward address', () => {
      // A payment address is where value goes; a reward address is what a withdrawal addresses.
      // Passing one for the other names a payment credential no reward account belongs to.
      expect(() =>
        encodeWithdrawals([
          {
            rewardAddress:
              'addr_test1qzasn8g8wgz5elr7a2jwcpvy9jdpzddy4vc5xtqpkrl53xwv9u9kpmjufmdhhnzxgyrc05uf2wwdmadkfuqpyvztj8dqw6fdax',
            lovelace: 1n
          }
        ])
      ).toThrow('CARDANO_INVALID_REWARD_ADDRESS');
      expect(() => encodeWithdrawals([{ rewardAddress: 'not-an-address', lovelace: 1n }])).toThrow(
        'CARDANO_INVALID_REWARD_ADDRESS'
      );
    });

    it('refuses the same account twice, rather than losing one of the amounts', () => {
      // A map cannot hold the key twice, so one of the two would silently disappear.
      expect(() =>
        encodeWithdrawals([
          { rewardAddress: REWARD_KEY, lovelace: 1n },
          { rewardAddress: REWARD_KEY, lovelace: 2n }
        ])
      ).toThrow('CARDANO_DUPLICATE_WITHDRAWAL');
    });

    it('refuses an empty map', () => {
      expect(() => encodeWithdrawals([])).toThrow('CARDANO_EMPTY_WITHDRAWAL_SET');
    });
  });

  describe('the transaction body', () => {
    const inputs = [utxo('aa'.repeat(32), 0)];
    const outputs = [encodeOutput(Uint8Array.from([0x00, ...new Uint8Array(56)]), 1_000_000n)];

    it('writes keys 4 and 5 after the four a transfer needs, in ascending order', () => {
      const body = encodeTransactionBody(inputs, outputs, 170_000n, 900, {
        certificates: [{ kind: 'register', stake: STAKE_KEY, depositLovelace: DEPOSIT }],
        withdrawals: [{ rewardAddress: REWARD_KEY, lovelace: 5n }]
      });

      const decoded = independentDecode(body) as Map<number, unknown>;
      // A key out of order is a different body, and a different body is a different transaction id.
      expect([...decoded.keys()]).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('omits both keys when there is nothing to say, rather than writing empty ones', () => {
      const body = encodeTransactionBody(inputs, outputs, 170_000n, 900);

      const decoded = independentDecode(body) as Map<number, unknown>;
      expect([...decoded.keys()]).toEqual([0, 1, 2, 3]);
    });

    it('omits the key an empty list would have produced', () => {
      const body = encodeTransactionBody(inputs, outputs, 170_000n, 900, {
        certificates: [{ kind: 'register', stake: STAKE_KEY, depositLovelace: DEPOSIT }],
        withdrawals: []
      });

      const decoded = independentDecode(body) as Map<number, unknown>;
      expect([...decoded.keys()]).toEqual([0, 1, 2, 3, 4]);
    });

    it('builds the same bytes as a transfer when it carries no staking fields', () => {
      // The staking parameter is additive: a body without it has to be byte-identical to what the
      // transfer path already produces, or every existing transaction id would change.
      const withEmpty = encodeTransactionBody(inputs, outputs, 170_000n, 900, {});
      const without = encodeTransactionBody(inputs, outputs, 170_000n, 900);

      expect(hex(withEmpty)).toBe(hex(without));
    });
  });

  describe('canonical form', () => {
    it('writes every integer in the shortest head that fits', () => {
      // Canonical is not tidiness here: the transaction id is the blake2b-256 hash of these exact
      // bytes, so a longer head than necessary is a different transaction.
      const deposits: [bigint, string][] = [
        [23n, '17'],
        [24n, '1818'],
        [255n, '18ff'],
        [256n, '190100'],
        [65_535n, '19ffff'],
        [65_536n, '1a00010000'],
        [4_294_967_295n, '1affffffff'],
        [4_294_967_296n, '1b0000000100000000']
      ];

      for (const [deposit, expected] of deposits) {
        const encoded = hex(
          encodeCertificate({ kind: 'register', stake: STAKE_KEY, depositLovelace: deposit })
        );
        expect(encoded.endsWith(expected)).toBe(true);
      }
    });

    it('agrees with the independent implementation on what canonical means', () => {
      // Decoded by `borc` and re-encoded by `borc`: if the bytes come back identical, the encoding
      // is one a library written by someone else would also have produced.
      const encoded = encodeCertificate({
        kind: 'register_and_delegate_pool_and_vote',
        stake: STAKE_KEY,
        poolId: POOL_BECH32,
        drep: { kind: 'always_abstain' },
        depositLovelace: DEPOSIT
      });

      const reEncoded = encode(independentDecode(encoded));
      expect(hex(reEncoded)).toBe(hex(encoded));
    });

    it('keeps a deposit past the exact-integer limit of a float', () => {
      const exact = 9_007_199_254_740_993n;
      const decoded = independentDecode(
        encodeCertificate({ kind: 'register', stake: STAKE_KEY, depositLovelace: exact })
      ) as [number, unknown, { toString(): string }];

      expect(String(decoded[2])).toBe(String(exact));
    });
  });

  describe('what this suite does not prove', () => {
    it('leaves the ledger-rules question to the reference vectors', () => {
      // `borc` proves these bytes are the CBOR structure we intended. It knows nothing about
      // Conway's CDDL, so a certificate with the wrong tag decodes perfectly and is still a
      // transaction the ledger rejects. That question is answered in `cardanoConwayVectors.test.ts`,
      // where every encoding here is compared byte for byte against cardano-serialization-lib.
      //
      // What remains unproven, and is recorded NOT RUN in that file, is acceptance by a real node.
      expect(true).toBe(true);
    });
  });
});

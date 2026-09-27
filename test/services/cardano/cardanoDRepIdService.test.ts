import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';

import {
  parseDRepId,
  sameDRep,
  toCip105,
  toCip129
} from '../../../src/services/cardano/cardanoDRepIdService';

/** Three credentials: an arbitrary one, and both extremes of the byte range. */
const HASHES = [
  '2a1b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5',
  '00'.repeat(28),
  'ff'.repeat(28)
] as const;

/**
 * The same credential as the serialization library writes it.
 *
 * This is the independent implementation the module is checked against: the identifiers below are
 * not transcribed from a specification by hand, they are produced by a library that also parses
 * them back. A vector written from memory would agree with whatever mistake produced it.
 *
 * @param hashHex - The 28-byte credential.
 * @param type - Whether it is a key hash or a script hash.
 * @returns Both spellings, as the library emits them.
 */
function reference(hashHex: string, type: 'key_hash' | 'script_hash') {
  const drep =
    type === 'key_hash'
      ? CSL.DRep.new_key_hash(CSL.Ed25519KeyHash.from_hex(hashHex))
      : CSL.DRep.new_script_hash(CSL.ScriptHash.from_hex(hashHex));
  return { cip129: drep.to_bech32(true), cip105: drep.to_bech32(false) };
}

/**
 * The raw payload of a bech32 identifier.
 *
 * @param id - The identifier.
 * @returns Its prefix and decoded bytes.
 */
function payloadOf(id: string): { prefix: string; bytes: Buffer } {
  const decoded = bech32.decode(id as `${string}1${string}`, 1023);
  return { prefix: decoded.prefix, bytes: Buffer.from(bech32.fromWords([...decoded.words])) };
}

describe('cardanoDRepIdService', () => {
  describe('writing, against the serialization library', () => {
    it.each(HASHES)('writes a key hash exactly as the library does: %s', (hashHex) => {
      const expected = reference(hashHex, 'key_hash');

      expect(toCip129({ type: 'key_hash', hashHex })).toBe(expected.cip129);
      expect(toCip105({ type: 'key_hash', hashHex })).toBe(expected.cip105);
    });

    it.each(HASHES)('writes a script hash exactly as the library does: %s', (hashHex) => {
      const expected = reference(hashHex, 'script_hash');

      expect(toCip129({ type: 'script_hash', hashHex })).toBe(expected.cip129);
      expect(toCip105({ type: 'script_hash', hashHex })).toBe(expected.cip105);
    });

    it('puts the CIP-129 header byte where the standard says', () => {
      // The header is `(key type << 4) | credential type`, DRep being key type 2, key hash being
      // credential type 2 and script hash 3. Asserted on the bytes rather than only through the
      // library, so that a change in either one is visible rather than cancelled out.
      const hashHex = HASHES[0];

      const key = payloadOf(toCip129({ type: 'key_hash', hashHex }));
      const script = payloadOf(toCip129({ type: 'script_hash', hashHex }));

      expect(key.prefix).toBe('drep');
      expect(key.bytes[0]).toBe(0x22);
      expect(key.bytes.subarray(1).toString('hex')).toBe(hashHex);
      expect(script.prefix).toBe('drep');
      expect(script.bytes[0]).toBe(0x23);
      expect(script.bytes.subarray(1).toString('hex')).toBe(hashHex);
    });

    it('writes CIP-105 as the revised prefixes, never the superseded bare one', () => {
      // `drep1…` now denotes a CIP-129 identifier. Emitting a bare key hash under it would produce
      // a string that current readers have to disambiguate by length to avoid misreading.
      expect(toCip105({ type: 'key_hash', hashHex: HASHES[0] })).toMatch(/^drep_vkh1/);
      expect(toCip105({ type: 'script_hash', hashHex: HASHES[0] })).toMatch(/^drep_script1/);
    });

    it('refuses a credential whose hash is not 28 bytes', () => {
      // A truncated hash bech32-encodes perfectly well. The result would be a syntactically valid
      // identifier for a DRep that does not exist, which is worse than an error.
      expect(() => toCip129({ type: 'key_hash', hashHex: 'ab'.repeat(27) })).toThrow(
        'CARDANO_DREP_CREDENTIAL_INVALID'
      );
      expect(() => toCip129({ type: 'key_hash', hashHex: 'zz'.repeat(28) })).toThrow(
        'CARDANO_DREP_CREDENTIAL_INVALID'
      );
      expect(() => toCip105({ type: 'script_hash', hashHex: '' })).toThrow(
        'CARDANO_DREP_CREDENTIAL_INVALID'
      );
    });
  });

  describe('reading', () => {
    it.each(HASHES)('reads back what the library wrote, both spellings: %s', (hashHex) => {
      for (const type of ['key_hash', 'script_hash'] as const) {
        const expected = reference(hashHex, type);

        const fromCip129 = parseDRepId(expected.cip129);
        const fromCip105 = parseDRepId(expected.cip105);

        expect(fromCip129?.credential).toEqual({ type, hashHex });
        expect(fromCip129?.standard).toBe('cip129');
        expect(fromCip105?.credential).toEqual({ type, hashHex });
        expect(fromCip105?.standard).toBe('cip105');
      }
    });

    it('reads the superseded bare `drep1` key hash by its length', () => {
      // 28 bytes under `drep` cannot be CIP-129, which is always 29. Older wallets still print it.
      const hashHex = HASHES[0];
      const legacy = bech32.encode('drep', bech32.toWords(Buffer.from(hashHex, 'hex')), 1023);

      const parsed = parseDRepId(legacy);

      expect(parsed?.credential).toEqual({ type: 'key_hash', hashHex });
      expect(parsed?.standard).toBe('cip105');
      // Read in the old spelling, canonicalised to the current one.
      expect(parsed?.idCip129).toBe(reference(hashHex, 'key_hash').cip129);
    });

    it('carries both spellings on every parse, whichever came in', () => {
      const hashHex = HASHES[0];
      const expected = reference(hashHex, 'key_hash');

      const parsed = parseDRepId(expected.cip105);

      expect(parsed?.idCip129).toBe(expected.cip129);
      expect(parsed?.idCip105).toBe(expected.cip105);
    });

    it('refuses a header naming a credential type the scheme does not define', () => {
      // Nibble 0 is not a credential type. A reader that ignored the low nibble would accept this
      // as a key hash and store a DRep identity nothing on chain agrees with.
      const payload = Buffer.concat([Buffer.from([0x20]), Buffer.from(HASHES[0], 'hex')]);

      expect(parseDRepId(bech32.encode('drep', bech32.toWords(payload), 1023))).toBeNull();
    });

    it('refuses a header naming a constitutional committee credential', () => {
      // Key types 0 and 1 are the committee hot and cold credentials. They share this header scheme
      // and this prefix length, and accepting one would record a committee key as the DRep a
      // credential delegates to: well-formed, and the wrong kind of thing entirely.
      for (const header of [0x02, 0x12]) {
        const payload = Buffer.concat([Buffer.from([header]), Buffer.from(HASHES[0], 'hex')]);

        expect(parseDRepId(bech32.encode('drep', bech32.toWords(payload), 1023))).toBeNull();
      }
    });

    it('refuses a checksum that does not hold', () => {
      const valid = reference(HASHES[0], 'key_hash').cip129;
      const corrupted = `${valid.slice(0, -1)}${valid.endsWith('q') ? 'p' : 'q'}`;

      expect(parseDRepId(corrupted)).toBeNull();
    });

    it('refuses an unknown prefix, a pool id among them', () => {
      expect(parseDRepId('pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy')).toBeNull();
      expect(
        parseDRepId('stake_test1urxz7zmqe3xqfjre9vlp5ru6u3elkjvnhz4hw6xw0y6dvhqkf8y0p')
      ).toBeNull();
      expect(parseDRepId('')).toBeNull();
      expect(parseDRepId('not an identifier')).toBeNull();
    });

    it('refuses a payload of a length neither standard defines', () => {
      for (const length of [27, 30]) {
        const payload = Buffer.alloc(length, 0xab);

        expect(parseDRepId(bech32.encode('drep', bech32.toWords(payload), 1023))).toBeNull();
        expect(parseDRepId(bech32.encode('drep_vkh', bech32.toWords(payload), 1023))).toBeNull();
      }
    });
  });

  describe('comparing', () => {
    it('matches the same DRep across spellings', () => {
      const expected = reference(HASHES[0], 'key_hash');

      expect(sameDRep(expected.cip129, expected.cip105)).toBe(true);
      // Text comparison would have said no, which is the bug this function exists to prevent.
      expect(expected.cip129).not.toBe(expected.cip105);
    });

    it('separates a key hash from a script hash of the same bytes', () => {
      // Two DReps can share a hash and differ in type, so the hash alone does not identify one.
      const hashHex = HASHES[0];

      expect(
        sameDRep(
          toCip129({ type: 'key_hash', hashHex }),
          toCip129({ type: 'script_hash', hashHex })
        )
      ).toBe(false);
    });

    it('treats unreadable as not equal, including against itself', () => {
      // Unreadable is not a value. Two failures to read are not a match, and a `null` identity is
      // not "delegates to nobody" — that distinction is what the callers act on.
      expect(sameDRep('garbage', 'garbage')).toBe(false);
      expect(sameDRep(null, null)).toBe(false);
      expect(sameDRep(undefined, reference(HASHES[0], 'key_hash').cip129)).toBe(false);
    });
  });
});

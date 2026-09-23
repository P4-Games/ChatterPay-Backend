/**
 * Canonical CBOR, hand-rolled, shared by everything that serialises a Cardano transaction.
 *
 * Extracted from `cardanoTxService` unchanged when certificates arrived: a transfer body and a
 * staking body are built from the same primitives, and two copies of a canonical encoder is two
 * encoders that can disagree — which on Cardano means two different transaction ids for what was
 * meant to be one transaction.
 *
 * **Canonical is not a style choice here.** The transaction id is the blake2b-256 hash of these
 * exact bytes, so a head written in a longer form than necessary, or a map key out of order, is a
 * different transaction. Every head below is the shortest form that fits.
 *
 * Nothing in this module knows what a transaction is. It encodes integers, byte strings, arrays,
 * maps, tags and sets, and that is all.
 */

/** CBOR major types, shifted into the high three bits of a head byte. */
const MAJOR_UNSIGNED = 0 << 5;
const MAJOR_BYTES = 2 << 5;
const MAJOR_ARRAY = 4 << 5;
const MAJOR_MAP = 5 << 5;
const MAJOR_TAG = 6 << 5;

/** `#6.258`, the tag Conway's CDDL puts in front of every set. */
export const SET_TAG = 258;

/** `true` and `null` as CBOR simple values: the validity flag and the absent auxiliary data. */
export const CBOR_TRUE = Uint8Array.from([0xf5]);
export const CBOR_NULL = Uint8Array.from([0xf6]);

/**
 * A CBOR head: the major type and either the value itself or the width of what follows.
 *
 * Always the shortest form that fits, which is what canonical CBOR requires and what makes the
 * transaction id reproducible: a body encoded two ways hashes to two different transactions.
 *
 * @param major - Major type, already shifted into the high three bits.
 * @param value - The argument the head carries.
 * @returns The head bytes.
 */
function head(major: number, value: bigint): Uint8Array {
  if (value < 24n) return Uint8Array.from([major | Number(value)]);
  if (value < 0x100n) return Uint8Array.from([major | 24, Number(value)]);
  if (value < 0x10000n) {
    return Uint8Array.from([major | 25, Number(value >> 8n), Number(value & 0xffn)]);
  }
  if (value < 0x100000000n) {
    const parts = [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn));
    return Uint8Array.from([major | 26, ...parts]);
  }
  const parts = [56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((shift) =>
    Number((value >> shift) & 0xffn)
  );
  return Uint8Array.from([major | 27, ...parts]);
}

/**
 * Joins byte runs.
 *
 * @param parts - Runs to join, in order.
 * @returns One run.
 */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * An unsigned integer.
 *
 * @param value - The value. Negative values are not representable and are a caller error.
 * @returns Its canonical encoding.
 */
export function uint(value: bigint | number): Uint8Array {
  return head(MAJOR_UNSIGNED, BigInt(value));
}

/**
 * A byte string.
 *
 * @param value - The bytes.
 * @returns Its canonical encoding.
 */
export function bytes(value: Uint8Array): Uint8Array {
  return concat([head(MAJOR_BYTES, BigInt(value.length)), value]);
}

/**
 * A definite-length array.
 *
 * @param items - Already-encoded items, in order.
 * @returns Its canonical encoding.
 */
export function array(items: readonly Uint8Array[]): Uint8Array {
  return concat([head(MAJOR_ARRAY, BigInt(items.length)), ...items]);
}

/**
 * A definite-length map.
 *
 * Entries are written in the order given: this function does not sort. Ordering is the caller's
 * responsibility because the correct order depends on what the keys are — ascending integers for
 * the transaction body, length-then-bytewise for the byte-string keys of a multiasset or a
 * withdrawals map.
 *
 * @param entries - Already-encoded key/value pairs, in canonical order.
 * @returns Its canonical encoding.
 */
export function map(entries: readonly (readonly [Uint8Array, Uint8Array])[]): Uint8Array {
  return concat([head(MAJOR_MAP, BigInt(entries.length)), ...entries.flat()]);
}

/**
 * A tagged value.
 *
 * @param tag - The tag number.
 * @param value - Already-encoded value.
 * @returns Its canonical encoding.
 */
export function tagged(tag: number, value: Uint8Array): Uint8Array {
  return concat([head(MAJOR_TAG, BigInt(tag)), value]);
}

/**
 * A set, in the tagged form Conway's CDDL specifies.
 *
 * @param items - Already-encoded members, in the order they should appear.
 * @returns `#6.258([...])`.
 */
export function set(items: readonly Uint8Array[]): Uint8Array {
  return tagged(SET_TAG, array(items));
}

/**
 * Reads hex into bytes.
 *
 * @param value - Hex, with or without `0x`.
 * @returns The bytes.
 * @throws Error `CARDANO_INVALID_HEX` for an odd length or a non-hex character. Silently accepting
 *   either would put bytes nobody chose into a transaction that then gets signed.
 */
export function hexToBytes(value: string): Uint8Array {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('CARDANO_INVALID_HEX');
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/**
 * Renders bytes as lowercase hex.
 *
 * @param value - The bytes.
 * @returns Hex without `0x`.
 */
export function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

/**
 * Orders map keys the way canonical CBOR does: shorter first, then bytewise.
 *
 * Asset names run from 0 to 32 bytes, so length has to come first — and the order matters beyond
 * tidiness, because the transaction id is the hash of these exact bytes. Two encodings of the same
 * value are two different transactions.
 *
 * Comparing lowercase hex is bytewise comparison of the bytes it represents, which is why every
 * caller lowercases first.
 *
 * @param left - Hex of the first key.
 * @param right - Hex of the second key.
 * @returns Negative, zero or positive, for `sort`.
 */
export function compareCborKeys(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

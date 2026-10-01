/**
 * Reading and writing DRep identifiers, in both spellings the ecosystem uses.
 *
 * A DRep is identified by a 28-byte credential — a key hash or a script hash — and that credential
 * has been bech32-encoded **three** different ways, not two.
 *
 * CIP-105 came first and encoded the bare hash, using the human-readable part to carry the
 * credential type: `drep1…` for a key hash, `drep_script1…` for a script hash. CIP-105 was then
 * revised, because `drep1…` was about to mean something else, and its key-hash prefix became
 * `drep_vkh1…`; that is the spelling current tooling and the serialization library emit. CIP-129
 * finally replaced the scheme with a single prefix and a header byte inside the payload, so the
 * type travels with the bytes instead of with the label — and it took `drep1…` for itself.
 *
 * All three are in circulation. Wallets, explorers and the two providers this backend reads do not
 * agree on which one they emit, and **the same DRep has a different string in each**. That is the
 * whole reason this module exists: comparing identifiers as text is how a delegation to a DRep the
 * user already delegates to reads as a change, and how "did the chain do what we asked" answers no.
 *
 * The collision on `drep1…` is the part that has to be got right rather than guessed at: the same
 * prefix means a bare key hash under the original CIP-105 and a header-prefixed credential of
 * either type under CIP-129. Length is what separates them, and it separates them completely —
 * 28 bytes against 29 — so the decision is made on the payload before anything reads a header.
 *
 * So there is exactly one canonical form here — CIP-129 — and it is the only one anything compares
 * or stores as identity. CIP-105 is parsed, because inputs arrive in it, and emitted, because some
 * user-facing surfaces still show it; it is never the field a decision is made on.
 *
 * **What this module refuses to do is guess.** An identifier that does not decode is not a DRep
 * that is absent, and neither is one this deployment cannot classify. The difference between "this
 * credential delegates to nobody", "this credential is not registered" and "the identifier could
 * not be read" is a difference the caller has to act on, and collapsing any two of them into one
 * produces a governance state that looks settled and is not. Every function here answers `null` for
 * unreadable and leaves the interpretation upstream.
 */

import { bech32 } from '@scure/base';

import type {
  CardanoDRepCredential,
  CardanoDRepCredentialType
} from '../../models/cardanoStakingAccountModel';

/** Bech32 length ceiling. Cardano identifiers exceed the 90-character default of the spec. */
const BECH32_LIMIT = 1023;

/** blake2b-224 digest length: what every Cardano credential hash is. */
const CREDENTIAL_HASH_BYTES = 28;

/**
 * CIP-129 key type nibble for a DRep.
 *
 * The same header byte scheme also labels constitutional committee hot and cold credentials, with
 * nibbles `0` and `1`. Accepting those here would let a committee key be stored as the DRep a
 * credential delegates to — a well-formed identifier for the wrong kind of thing.
 */
const CIP129_DREP_KEY_TYPE = 0b0010;

/** CIP-129 credential type nibble for a key hash. */
const CIP129_KEY_HASH = 0b0010;

/** CIP-129 credential type nibble for a script hash. */
const CIP129_SCRIPT_HASH = 0b0011;

/** Human-readable part CIP-129 gives every DRep identifier, whatever the credential type. */
const CIP129_HRP = 'drep';

/**
 * CIP-105 human-readable parts as this module **writes** them, which is where that spelling carries
 * the credential type.
 *
 * `drep_vkh` rather than the original `drep`: the revision exists precisely because CIP-129 took
 * the bare prefix, and emitting the superseded form would produce an identifier that a current
 * reader has to disambiguate by length. The original is still accepted on input — see
 * {@link DEPRECATED_CIP105_KEY_HASH_HRP} — because identifiers written before the revision do not
 * stop existing.
 */
const CIP105_HRP: Readonly<Record<CardanoDRepCredentialType, string>> = {
  key_hash: 'drep_vkh',
  script_hash: 'drep_script'
};

/**
 * The key-hash prefix of CIP-105 before its revision.
 *
 * Read, never written. A 28-byte payload under this prefix is unambiguous — CIP-129 payloads are
 * 29 — so accepting it costs nothing and refusing it would reject identifiers that are still
 * printed by older wallets and stored in older records.
 */
const DEPRECATED_CIP105_KEY_HASH_HRP = 'drep';

/** Which spelling an identifier was written in. */
export type CardanoDRepIdStandard = 'cip129' | 'cip105';

/** A DRep identifier that decoded, and what it turned out to say. */
export interface ParsedDRepId {
  credential: CardanoDRepCredential;
  /** The spelling the input was written in. */
  standard: CardanoDRepIdStandard;
  /** Canonical identity. The only form anything compares or stores as identity. */
  idCip129: string;
  /** Legacy form, for display beside the canonical one. Never compared. */
  idCip105: string;
}

/**
 * Reads a DRep identifier in any of the three spellings.
 *
 * `drep1…` is decided by payload length before anything else, because that prefix is shared: 29
 * bytes is CIP-129, 28 is an original-CIP-105 key hash. Everything else is decided by prefix —
 * `drep_vkh1…` is a revised-CIP-105 key hash, `drep_script1…` a script hash.
 *
 * @param id - The identifier, bech32, in any spelling.
 * @returns What it denotes, or `null` when it cannot be read: bad checksum, unknown prefix, a
 *   payload of the wrong length, a header naming a credential type this scheme does not define, or
 *   a header naming a key type that is not a DRep. A `null` here means **unreadable**, which is not
 *   the same fact as a credential that delegates to nobody.
 */
export function parseDRepId(id: string): ParsedDRepId | null {
  let prefix: string;
  let payload: Uint8Array;
  try {
    const decoded = bech32.decode(id as `${string}1${string}`, BECH32_LIMIT);
    prefix = decoded.prefix;
    payload = Uint8Array.from(bech32.fromWords([...decoded.words]));
  } catch {
    // A bad checksum, an invalid character, or mixed case. All of them are "not an identifier".
    return null;
  }

  if (prefix === CIP129_HRP && payload.length === 1 + CREDENTIAL_HASH_BYTES) {
    return fromCip129Payload(payload);
  }
  if (payload.length !== CREDENTIAL_HASH_BYTES) return null;

  const type: CardanoDRepCredentialType | null =
    prefix === CIP105_HRP.key_hash || prefix === DEPRECATED_CIP105_KEY_HASH_HRP
      ? 'key_hash'
      : prefix === CIP105_HRP.script_hash
        ? 'script_hash'
        : null;
  if (type === null) return null;

  return described({ type, hashHex: hex(payload) }, 'cip105');
}

/**
 * Reads the header byte and credential of a CIP-129 payload.
 *
 * @param payload - Header byte followed by the 28-byte credential.
 * @returns What it denotes, or `null` when the header names something other than a DRep.
 */
function fromCip129Payload(payload: Uint8Array): ParsedDRepId | null {
  const header = payload[0];
  if (header === undefined) return null;
  if (header >> 4 !== CIP129_DREP_KEY_TYPE) return null;

  const credentialNibble = header & 0x0f;
  const type: CardanoDRepCredentialType | null =
    credentialNibble === CIP129_KEY_HASH
      ? 'key_hash'
      : credentialNibble === CIP129_SCRIPT_HASH
        ? 'script_hash'
        : null;
  if (type === null) return null;

  return described({ type, hashHex: hex(payload.slice(1)) }, 'cip129');
}

/**
 * Both spellings of a credential, packaged with the one it came in.
 *
 * @param credential - The credential.
 * @param standard - The spelling the input used.
 * @returns The parsed identifier.
 */
function described(
  credential: CardanoDRepCredential,
  standard: CardanoDRepIdStandard
): ParsedDRepId {
  return {
    credential,
    standard,
    idCip129: toCip129(credential),
    idCip105: toCip105(credential)
  };
}

/**
 * Writes a credential in its canonical CIP-129 form.
 *
 * @param credential - Credential type and 28-byte hash, hex.
 * @returns The `drep1…` identifier.
 * @throws Error `CARDANO_DREP_CREDENTIAL_INVALID` when the hash is not 28 bytes of hex. Throwing
 *   rather than returning a shorter identifier: a truncated hash still bech32-encodes, and the
 *   result would be a syntactically valid identifier for a DRep that does not exist.
 */
export function toCip129(credential: CardanoDRepCredential): string {
  const hash = credentialBytes(credential);
  const header =
    (CIP129_DREP_KEY_TYPE << 4) |
    (credential.type === 'key_hash' ? CIP129_KEY_HASH : CIP129_SCRIPT_HASH);
  const payload = new Uint8Array(1 + CREDENTIAL_HASH_BYTES);
  payload[0] = header;
  payload.set(hash, 1);
  return bech32.encode(CIP129_HRP, bech32.toWords(payload), BECH32_LIMIT);
}

/**
 * Writes a credential in the legacy CIP-105 form.
 *
 * Provided for display beside the canonical identifier, because explorers and wallets in the wild
 * still show this spelling and a user comparing the two would otherwise see no match. Nothing in
 * this backend decides anything on this value.
 *
 * @param credential - Credential type and 28-byte hash, hex.
 * @returns The `drep_vkh1…` or `drep_script1…` identifier — the revised prefixes, never the
 *   original `drep1…`, which now denotes a CIP-129 identifier to any current reader.
 * @throws Error `CARDANO_DREP_CREDENTIAL_INVALID` when the hash is not 28 bytes of hex.
 */
export function toCip105(credential: CardanoDRepCredential): string {
  const hash = credentialBytes(credential);
  return bech32.encode(CIP105_HRP[credential.type], bech32.toWords(hash), BECH32_LIMIT);
}

/**
 * Whether two identifiers denote the same DRep.
 *
 * Compares what they decode to, not how they are written: the same DRep in CIP-105 and CIP-129 is
 * the same DRep, and the strings do not match.
 *
 * @param a - One identifier, either spelling.
 * @param b - The other.
 * @returns `true` only when both decode and denote the same credential. Two identifiers that cannot
 *   be read are not equal — unreadable is not a value.
 */
export function sameDRep(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = parseDRepId(a);
  const right = parseDRepId(b);
  if (left === null || right === null) return false;
  return left.idCip129 === right.idCip129;
}

/**
 * The bytes of a credential hash, validated.
 *
 * @param credential - Credential to read.
 * @returns Its 28 bytes.
 * @throws Error `CARDANO_DREP_CREDENTIAL_INVALID` when the hash is not 28 bytes of lowercase hex.
 */
function credentialBytes(credential: CardanoDRepCredential): Uint8Array {
  const hashHex = credential.hashHex?.toLowerCase() ?? '';
  if (!/^[0-9a-f]{56}$/.test(hashHex)) {
    throw new Error(`CARDANO_DREP_CREDENTIAL_INVALID: ${credential.hashHex}`);
  }
  return Uint8Array.from(Buffer.from(hashHex, 'hex'));
}

/**
 * Lowercase hex of a byte string.
 *
 * @param bytes - Bytes to render.
 * @returns Hex without `0x`.
 */
function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

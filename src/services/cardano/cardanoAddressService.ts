/**
 * Cardano addresses, derived rather than requested.
 *
 * A Cardano address is not a hash of a public key with a prefix bolted on: it is a header byte that
 * says *what kind of address this is and which network it belongs to*, followed by the credential
 * itself, all of it bech32-encoded (CIP-19). Getting the header wrong produces a perfectly
 * well-formed address of the wrong kind, or of the wrong network — which is why the network is a
 * parameter here and never a default.
 *
 * ChatterPay issues **base** addresses: a payment credential *and* a staking one, both key hashes
 * derived from the same master secret. Both remain a pure function of the user's keys, so the
 * address can still be shown and funded before anything touches a chain, and a recipient can still
 * be resolved without creating anything anywhere.
 *
 * The staking credential is carried **unregistered**. That is deliberate and it is the whole point:
 * an address with an unregistered stake credential behaves exactly like an enterprise one — it
 * receives, it spends, it holds native assets — but registering and delegating it later is a
 * transaction, not a different address. Issuing enterprise addresses would have made staking a
 * migration of every funded wallet, and that migration only gets more expensive with each user.
 *
 * Nothing in this module talks to a provider, a node or the database.
 */

import { blake2b } from '@noble/hashes/blake2';
import { bech32 } from '@scure/base';
import type { CardanoNetwork, DecodedCardanoAddress } from '../../types/cardanoType';

/** Network id as it travels in the low nibble of the address header (CIP-19). */
const NETWORK_ID: Readonly<Record<CardanoNetwork, number>> = { testnet: 0, mainnet: 1 };

/** Human-readable part of a bech32 Cardano address, per network. */
const HRP: Readonly<Record<CardanoNetwork, string>> = { testnet: 'addr_test', mainnet: 'addr' };

/**
 * Address type 0: base address, a payment key hash followed by a staking key hash. It lives in the
 * high nibble of the header byte. This is what ChatterPay issues.
 */
const BASE_KEY_HASH_TYPE = 0;

/**
 * Address type 6: enterprise address with a payment key hash and no staking credential.
 *
 * No longer issued — kept because it is still a valid destination, and because the CIP-19 vectors
 * for it are what prove the header arithmetic below puts the type in the high nibble and the
 * network id in the low one. A test that only ever exercised one type would pass with the two
 * swapped.
 */
const ENTERPRISE_KEY_HASH_TYPE = 6;

/** Size of a Cardano credential hash: blake2b-224 output, in bytes. */
const CREDENTIAL_HASH_BYTES = 28;

/**
 * Bech32 length ceiling. BIP-173 caps an address at 90 characters; Cardano deliberately does not,
 * because an address carrying both a payment and a staking credential exceeds it. Passing an
 * explicit bound rather than the default is what keeps a valid address from being rejected as
 * malformed.
 */
const BECH32_LIMIT = 256;

/**
 * How many bytes the payload of each address type occupies, header byte included (CIP-19).
 *
 * Types 0–3 are **base** addresses: a payment credential followed by a staking one. They are what
 * every ordinary Cardano wallet hands out, so a deployment that only reads type 6 would refuse the
 * destination a user copies out of Eternl, Lace or Daedalus — which is to say, refuse almost every
 * real destination.
 *
 * Types 4 and 5 are pointer addresses. They are absent on purpose rather than unimplemented: the
 * Conway era deprecated them, and accepting one would build a transaction to a form of address the
 * ledger is retiring.
 */
const PAYLOAD_BYTES: Readonly<Record<number, number>> = {
  0: 1 + 2 * CREDENTIAL_HASH_BYTES,
  1: 1 + 2 * CREDENTIAL_HASH_BYTES,
  2: 1 + 2 * CREDENTIAL_HASH_BYTES,
  3: 1 + 2 * CREDENTIAL_HASH_BYTES,
  6: 1 + CREDENTIAL_HASH_BYTES,
  7: 1 + CREDENTIAL_HASH_BYTES
};

/**
 * The payment credential of an Ed25519 public key: its blake2b-224 hash.
 *
 * @param publicKey - Raw 32-byte Ed25519 public key, hex with or without `0x`.
 * @returns The 28-byte credential hash.
 * @throws Error `CARDANO_PUBLIC_KEY_MUST_BE_32_BYTES` when the key is not exactly 32 bytes — a
 *   compressed secp256k1 point is 33 and would otherwise hash into a plausible-looking address for
 *   a key that cannot sign for it.
 */
export function paymentCredential(publicKey: string): Uint8Array {
  const hex = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('CARDANO_PUBLIC_KEY_MUST_BE_32_BYTES');
  }
  return blake2b(Uint8Array.from(Buffer.from(hex, 'hex')), { dkLen: CREDENTIAL_HASH_BYTES });
}

/**
 * The base address of a payment key and a staking key on a network.
 *
 * The staking credential is written into the address but **not registered anywhere**: no
 * certificate, no deposit, no delegation. The address works exactly like an enterprise one until
 * someone decides to register it, and that decision then costs a transaction instead of a new
 * address.
 *
 * @param paymentPublicKey - Raw 32-byte Ed25519 payment public key, hex with or without `0x`.
 * @param stakePublicKey - Raw 32-byte Ed25519 staking public key, hex with or without `0x`.
 * @param network - Which network the address belongs to. Required on purpose.
 * @returns The bech32 address, `addr_test1q…` on testnet and `addr1q…` on mainnet.
 * @throws Error `CARDANO_PUBLIC_KEY_MUST_BE_32_BYTES` for a key of the wrong size.
 */
export function baseAddress(
  paymentPublicKey: string,
  stakePublicKey: string,
  network: CardanoNetwork
): string {
  const header = (BASE_KEY_HASH_TYPE << 4) | NETWORK_ID[network];
  const payload = Uint8Array.from([
    header,
    ...paymentCredential(paymentPublicKey),
    ...paymentCredential(stakePublicKey)
  ]);
  return bech32.encode(HRP[network], bech32.toWords(payload), BECH32_LIMIT);
}

/**
 * The enterprise address of an Ed25519 public key on a network.
 *
 * Not what ChatterPay issues — see {@link baseAddress}. Kept for the CIP-19 vectors it is tested
 * against, and because an enterprise address remains a legal destination.
 *
 * @param publicKey - Raw 32-byte Ed25519 public key, hex with or without `0x`.
 * @param network - Which network the address belongs to. Required on purpose.
 * @returns The bech32 address, `addr_test1…` on testnet and `addr1…` on mainnet.
 * @throws Error `CARDANO_PUBLIC_KEY_MUST_BE_32_BYTES` for a key of the wrong size.
 */
export function enterpriseAddress(publicKey: string, network: CardanoNetwork): string {
  const header = (ENTERPRISE_KEY_HASH_TYPE << 4) | NETWORK_ID[network];
  const payload = Uint8Array.from([header, ...paymentCredential(publicKey)]);
  return bech32.encode(HRP[network], bech32.toWords(payload), BECH32_LIMIT);
}

/**
 * Reads a Cardano address, checksum included.
 *
 * This is a real bech32 decode and not a prefix test. A regex over `addr_test1…` accepts a string
 * with a typo in it, and the cost of accepting a mistyped destination is money sent nowhere — the
 * checksum exists precisely so that a wrong character is a rejection instead of a payment.
 *
 * @param address - The address to read.
 * @returns What the address says about itself, or `null` when it is not a readable Cardano address:
 *   bad checksum, unknown prefix, wrong payload length for its own type, or a network whose prefix
 *   and header byte disagree.
 */
export function decodeCardanoAddress(address: string): DecodedCardanoAddress | null {
  const prefix: CardanoNetwork | null = address.startsWith('addr_test1')
    ? 'testnet'
    : address.startsWith('addr1')
      ? 'mainnet'
      : null;
  if (prefix === null) return null;

  let words: number[];
  try {
    const decoded = bech32.decode(address as `${string}1${string}`, BECH32_LIMIT);
    if (decoded.prefix !== HRP[prefix]) return null;
    words = [...decoded.words];
  } catch {
    // A bad checksum, a bad character or a mixed-case string. All of them are "not an address".
    return null;
  }

  const payload = bech32.fromWords(words);
  const header = payload[0];
  if (header === undefined) return null;

  const addressType = header >> 4;
  // Checked against the type rather than against one constant: every address type carries a
  // different payload, and a length that does not match its own type is a truncated or padded
  // string that happens to carry a valid checksum.
  if (payload.length !== PAYLOAD_BYTES[addressType]) return null;
  // The prefix and the header both carry the network, and a disagreement between them is not a
  // detail: it is an address that reads as one network and would settle on another.
  if ((header & 0x0f) !== NETWORK_ID[prefix]) return null;

  // Types 0-3 carry a second credential right after the payment one. Read here rather than left to
  // the caller to slice, so that whoever needs it later — registering a stake key, delegating —
  // gets the bytes whose checksum this function already verified.
  const hasStakePart = addressType <= 3;

  return {
    network: prefix,
    addressType,
    credentialHex: Buffer.from(payload.slice(1, 1 + CREDENTIAL_HASH_BYTES)).toString('hex'),
    stakeCredentialHex: hasStakePart
      ? Buffer.from(
          payload.slice(1 + CREDENTIAL_HASH_BYTES, 1 + 2 * CREDENTIAL_HASH_BYTES)
        ).toString('hex')
      : undefined,
    payload: Uint8Array.from(payload)
  };
}

/**
 * Whether `address` is a usable Cardano destination for `network`.
 *
 * @param address - Candidate destination.
 * @param network - Network the transfer would settle on.
 * @returns `true` only for a checksum-valid address of that same network. A mainnet address on a
 *   testnet deployment is refused rather than tried: the two look alike enough to be pasted by
 *   mistake, and the funds would leave for a chain this deployment does not operate on.
 */
export function isValidCardanoAddress(address: string, network: CardanoNetwork): boolean {
  const decoded = decodeCardanoAddress(address);
  return decoded !== null && decoded.network === network;
}

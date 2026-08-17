/**
 * The Cardano signing boundary.
 *
 * ChatterPay derives signing material in-process from a master secret, which is the posture the EVM
 * side already has (`secService`). Cardano needs a key on a different curve — Ed25519 rather than
 * secp256k1 — and the one property that must hold is **domain separation**: a user's Cardano key
 * must not be computable from their EVM key, and vice versa.
 *
 * That is why this does not reuse `secService.get_up()`'s output as a seed. That output *is* the
 * user's EVM private key; seeding Ed25519 from it would mean that leaking one key leaks the other,
 * on a different chain, silently. Instead both derive independently from the same master secret
 * through different constructions:
 *
 * ```
 *   EVM      : sha256( SALT ‖ chainId ‖ env ‖ phone )                     -> secp256k1 private key
 *   Cardano  : HKDF-SHA256( ikm  = SALT ‖ env ‖ phone,
 *                           salt = 'chatterpay:cardano:<network>',
 *                           info = 'ed25519:v1:<chainId>' )               -> payment seed
 *                           info = 'ed25519:stake:v1:<chainId>' )         -> staking seed
 * ```
 *
 * Neither is derivable from the other without the master secret, because inverting SHA-256 to
 * recover `SALT` is what it would take. The same separation holds between the two Cardano keys: a
 * different `info` is a different HKDF output, and `stake` cannot be mistaken for a version string.
 *
 * The `v1` in `info` is the derivation-scheme version. It exists so the scheme can be rotated
 * without ambiguity — but rotating it changes every address, so it is not a knob to turn casually:
 * an address holding funds is an address the old scheme has to keep deriving.
 *
 * The staking key signs nothing today. It exists because it goes *into the address*, and an address
 * is the one thing that cannot be changed after the fact without moving everybody's funds.
 *
 * @see CARDANO_INTEGRATION_PLAN.md §4.2
 */

// Every cryptographic primitive here comes from `@noble`, none from `node:crypto`.
//
// Not a preference: Bun's `node:crypto` is a reimplementation and it does not behave the same on
// every platform. `hkdfSync` is simply absent (the process dies at import time with "Export named
// 'hkdfSync' not found in module 'crypto'"), and importing an Ed25519 key from PKCS#8 was observed
// on Bun for Windows to return a **different key on every call for the same seed** — which made the
// derived address change between two requests of the same process, while Node and Bun for Linux
// stayed deterministic. A derivation that is not a pure function of its inputs is not a derivation:
// the address is the identity, and it cannot depend on which runtime happens to be serving.
//
// `@noble` is pure JavaScript, so the same seed gives the same key everywhere. Byte-for-byte
// equality with the `node:crypto` output — public key and signature both — was verified before the
// swap, because a different result would mean every existing address and signature changed.
import { ed25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { createHash } from 'node:crypto';
import { $B, $S } from '../../config/constants';
import { getPhoneNumberFormatted } from '../../helpers/formatHelper';
import type { CardanoAccount, CardanoNetwork } from '../../types/cardanoType';
import { baseAddress, decodeCardanoAddress } from './cardanoAddressService';

/** Size of the Ed25519 seed HKDF produces. */
const SEED_BYTES = 32;

/** Derivation-scheme version. Changing it changes every address this service derives. */
const SCHEME_VERSION = 'v1';

/**
 * Which key of a user's Cardano identity is being derived.
 *
 * `payment` has no label in `info` because it predates the staking key, and giving it one now would
 * change every payment credential for nothing.
 */
type KeyRole = 'payment' | 'stake';

/**
 * The Ed25519 seed of a user on a network, for one role.
 *
 * @param phoneNumber - The user's phone number, in any accepted format.
 * @param network - Cardano network the key is for. Part of the derivation on purpose: Preprod and
 *   mainnet are separate identities with nothing to keep in common, and a shared key would mean a
 *   mainnet address whose testnet twin has been exercised by every test run.
 * @param chainId - Internal chain id of the network, mixed into `info` so two Cardano networks of
 *   the same kind never collide.
 * @param role - Payment or staking. Two roles, two `info` strings, two independent seeds.
 * @returns The 32-byte seed.
 * @throws Error `CARDANO_SEED_SALT_MISSING` when `SEED_INTERNAL_SALT` is not configured — deriving
 *   from an empty salt would produce a well-formed address that anybody who knows the phone number
 *   can spend from.
 */
function ed25519Seed(
  phoneNumber: string,
  network: CardanoNetwork,
  chainId: number,
  role: KeyRole = 'payment'
): Buffer {
  if (!$S) throw new Error('CARDANO_SEED_SALT_MISSING');
  const ikm = Buffer.from(`${$S}${$B}${getPhoneNumberFormatted(phoneNumber)}`, 'utf8');
  const salt = Buffer.from(`chatterpay:cardano:${network}`, 'utf8');
  const label = role === 'stake' ? `stake:${SCHEME_VERSION}` : SCHEME_VERSION;
  const info = Buffer.from(`ed25519:${label}:${chainId}`, 'utf8');
  return Buffer.from(hkdf(sha256, ikm, salt, info, SEED_BYTES));
}

/** The raw 32-byte Ed25519 public key of a seed, hex with `0x`. */
function publicKeyOf(seed: Buffer): string {
  return `0x${Buffer.from(ed25519.getPublicKey(seed)).toString('hex')}`;
}

/**
 * A non-secret description of the inputs the derivation depends on.
 *
 * Every one of them is part of the address, so when a stored address stops matching the derived one
 * the answer is always "one of these changed" — and without naming them the only way to find out
 * which is to guess. The salt is reported as a length and a hash prefix, never as itself.
 *
 * @returns A one-line fingerprint safe to put in a log or an error message.
 */
export function derivationFingerprint(): string {
  const salt = $S
    ? `len=${$S.length},sha=${createHash('sha256').update($S).digest('hex').slice(0, 8)}`
    : 'MISSING';
  return `salt(${salt}) env(${$B ?? 'undefined'})`;
}

export const cardanoSignerService = {
  /**
   * The raw Ed25519 public key a user holds on a network.
   *
   * @param phoneNumber - The user's phone number.
   * @param network - Cardano network.
   * @param chainId - Internal chain id of the network.
   * @returns The 32-byte public key, hex with `0x`.
   */
  getPublicKey: (phoneNumber: string, network: CardanoNetwork, chainId: number): string =>
    publicKeyOf(ed25519Seed(phoneNumber, network, chainId)),

  /**
   * The user's Cardano identity: address, address bytes and both public keys.
   *
   * Pure arithmetic over two keys — no provider call, no database write, and in particular no
   * certificate: the staking key goes into the address and stays unregistered. That is what lets a
   * recipient's address be resolved before they have ever used Cardano, and what keeps delegation a
   * later decision instead of a migration.
   *
   * @param phoneNumber - The user's phone number.
   * @param network - Cardano network the address belongs to.
   * @param chainId - Internal chain id of the network.
   * @returns The account.
   * @throws Error `CARDANO_ADDRESS_DERIVATION_FAILED` when the derived address cannot be read back,
   *   which would mean this deployment publishes an address it cannot itself parse.
   */
  getAccount: (phoneNumber: string, network: CardanoNetwork, chainId: number): CardanoAccount => {
    const publicKey = publicKeyOf(ed25519Seed(phoneNumber, network, chainId));
    const stakePublicKey = publicKeyOf(ed25519Seed(phoneNumber, network, chainId, 'stake'));
    const address = baseAddress(publicKey, stakePublicKey, network);
    const decoded = decodeCardanoAddress(address);
    if (!decoded) throw new Error('CARDANO_ADDRESS_DERIVATION_FAILED');
    return { address, addressBytes: decoded.payload, publicKey, stakePublicKey };
  },

  /**
   * Signs a transaction body hash.
   *
   * Ed25519 signs a message rather than a pre-hashed digest, and that is exactly what Cardano
   * wants: the thing being signed is the 32-byte blake2b hash of the transaction body, passed as
   * the message.
   *
   * @param phoneNumber - The user's phone number.
   * @param network - Cardano network.
   * @param chainId - Internal chain id of the network.
   * @param transactionId - The transaction body hash, hex with or without `0x`.
   * @returns The 64-byte signature, hex with `0x`.
   * @throws Error `CARDANO_INVALID_TRANSACTION_ID` when the id is not 32 bytes of hex.
   */
  sign: (
    phoneNumber: string,
    network: CardanoNetwork,
    chainId: number,
    transactionId: string
  ): string => {
    const hex = transactionId.startsWith('0x') ? transactionId.slice(2) : transactionId;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('CARDANO_INVALID_TRANSACTION_ID');
    const seed = ed25519Seed(phoneNumber, network, chainId);
    const signature = ed25519.sign(Buffer.from(hex, 'hex'), seed);
    return `0x${Buffer.from(signature).toString('hex')}`;
  }
};

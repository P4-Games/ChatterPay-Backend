/**
 * Conway certificates and reward withdrawals: the two transaction-body fields staking needs.
 *
 * `cardanoTxService` builds a body with four keys — inputs, outputs, fee, TTL. Staking adds key 4,
 * `certificates`, and key 5, `withdrawals`. This module encodes both, on the same hand-rolled
 * canonical CBOR, and nothing here submits, signs or selects coins.
 *
 * **Why the explicit-deposit certificates and not the legacy ones.** Conway kept
 * `stake_registration` (0) and `stake_deregistration` (1), where the deposit is implied and taken
 * from the protocol parameter as the ledger sees it. It also added `reg_cert` (7) and `unreg_cert`
 * (8), where the amount is written into the certificate and has to match exactly. This module
 * emits only the explicit forms, because the implicit ones quietly change meaning when the
 * parameter changes: a deregistration built today would refund whatever the parameter says today,
 * while Cardano refunds what was actually deposited. Writing the amount down turns a silent
 * mismatch into a rejected transaction, which is the failure that can be noticed.
 *
 * **Why the combined certificates.** Registering and delegating in one certificate is not an
 * optimisation. Two certificates in one transaction would work, but a registration in one
 * transaction and a delegation in the next leaves a window where the deposit is paid and nothing
 * is earning — and, if the second transaction never lands, a registered credential nobody meant to
 * create. `stake_vote_reg_deleg_cert` (13) does all three at once, atomically.
 *
 * **Ordering.** Certificates are emitted in the order given and are never sorted. Within a
 * transaction the ledger applies them in sequence, so order is meaning: a delegation placed before
 * the registration it depends on is a different transaction, and an invalid one.
 */

import { bech32 } from '@scure/base';
import { decodeRewardAddress } from './cardanoAddressService';
import { array, bytes, compareCborKeys, hexToBytes, map, set, uint } from './cardanoCborService';

/** Size of a Cardano credential hash: blake2b-224 output, in bytes. */
const CREDENTIAL_HASH_BYTES = 28;

/** Upper bound for bech32 decoding. Pool ids are far below it; the default of 90 is not. */
const BECH32_LIMIT = 256;

/** Human-readable part of a bech32 stake pool id. */
const POOL_HRP = 'pool';

/**
 * Certificate tags, as Conway's CDDL numbers them.
 *
 * Named rather than written inline because the numbers are not guessable from the operation and a
 * transposed pair — 11 for register-and-delegate-pool against 12 for register-and-delegate-vote —
 * produces a well-formed certificate that does the wrong thing to the user's stake.
 */
const TAG = {
  stakeDelegation: 2,
  register: 7,
  deregister: 8,
  voteDelegation: 9,
  stakeAndVoteDelegation: 10,
  registerAndDelegateStake: 11,
  registerAndDelegateVote: 12,
  registerAndDelegateStakeAndVote: 13
} as const;

/** Which credential a hash is a digest of. */
export type CardanoCredentialType = 'key_hash' | 'script_hash';

/** A credential: the hash and what the hash is a digest of. */
export interface CardanoCredential {
  type: CardanoCredentialType;
  /** blake2b-224 digest, 28 bytes, lowercase hex without `0x`. */
  hashHex: string;
}

/**
 * Where a credential's voting power goes.
 *
 * The two predefined options are **one-element arrays** in the CBOR, `[2]` and `[3]`, not bare
 * integers. A bare integer decodes as something else entirely and the transaction is rejected.
 */
export type CardanoDRepTarget =
  | { kind: 'drep'; credential: CardanoCredential }
  | { kind: 'always_abstain' }
  | { kind: 'always_no_confidence' };

/** `drep` variants that carry no credential. */
const DREP_ALWAYS_ABSTAIN = 2;
const DREP_ALWAYS_NO_CONFIDENCE = 3;

/**
 * A certificate, described by what it is for rather than by its tag.
 *
 * The union is deliberately shaped so that an impossible combination cannot be expressed: there is
 * no way to ask for a registration without a deposit, or for a delegation to a pool that is not
 * named.
 */
export type CardanoStakingCertificate =
  | { kind: 'register'; stake: CardanoCredential; depositLovelace: bigint }
  | { kind: 'deregister'; stake: CardanoCredential; refundLovelace: bigint }
  | { kind: 'delegate_pool'; stake: CardanoCredential; poolId: string }
  | { kind: 'delegate_vote'; stake: CardanoCredential; drep: CardanoDRepTarget }
  | {
      kind: 'delegate_pool_and_vote';
      stake: CardanoCredential;
      poolId: string;
      drep: CardanoDRepTarget;
    }
  | {
      kind: 'register_and_delegate_pool';
      stake: CardanoCredential;
      poolId: string;
      depositLovelace: bigint;
    }
  | {
      kind: 'register_and_delegate_vote';
      stake: CardanoCredential;
      drep: CardanoDRepTarget;
      depositLovelace: bigint;
    }
  | {
      kind: 'register_and_delegate_pool_and_vote';
      stake: CardanoCredential;
      poolId: string;
      drep: CardanoDRepTarget;
      depositLovelace: bigint;
    };

/** One reward account being emptied, and by how much. */
export interface CardanoWithdrawal {
  /** Reward address, bech32 `stake1…` or `stake_test1…`. */
  rewardAddress: string;
  lovelace: bigint;
}

/**
 * Reads a 28-byte credential hash.
 *
 * @param hashHex - The hash, hex with or without `0x`.
 * @returns The bytes.
 * @throws Error `CARDANO_CREDENTIAL_MUST_BE_28_BYTES` for anything else. A hash of the wrong length
 *   is not a credential, and a certificate built from one addresses nothing.
 */
function credentialHash(hashHex: string): Uint8Array {
  const raw = hexToBytes(hashHex);
  if (raw.length !== CREDENTIAL_HASH_BYTES) {
    throw new Error('CARDANO_CREDENTIAL_MUST_BE_28_BYTES');
  }
  return raw;
}

/**
 * A `credential`: `[0, addr_keyhash]` for a key, `[1, script_hash]` for a script.
 *
 * @param credential - The credential to encode.
 * @returns Its canonical CBOR.
 */
export function encodeCredential(credential: CardanoCredential): Uint8Array {
  return array([
    uint(credential.type === 'key_hash' ? 0 : 1),
    bytes(credentialHash(credential.hashHex))
  ]);
}

/**
 * A `drep`.
 *
 * @param target - Where the voting power goes.
 * @returns Its canonical CBOR: `[0, keyhash]`, `[1, scripthash]`, `[2]` or `[3]`.
 */
export function encodeDRep(target: CardanoDRepTarget): Uint8Array {
  if (target.kind === 'always_abstain') return array([uint(DREP_ALWAYS_ABSTAIN)]);
  if (target.kind === 'always_no_confidence') return array([uint(DREP_ALWAYS_NO_CONFIDENCE)]);
  return encodeCredential(target.credential);
}

/**
 * Reads a stake pool id into its 28-byte key hash.
 *
 * Both spellings are accepted because both are in circulation: configuration and explorers use the
 * bech32 `pool1…` form, while provider APIs often answer with the raw hash.
 *
 * @param poolId - `pool1…` bech32, or the key hash as hex.
 * @returns The 28-byte pool key hash.
 * @throws Error `CARDANO_INVALID_POOL_ID` when it is neither, or the wrong length.
 */
export function poolKeyHash(poolId: string): Uint8Array {
  if (poolId.startsWith(`${POOL_HRP}1`)) {
    try {
      const decoded = bech32.decode(poolId as `${string}1${string}`, BECH32_LIMIT);
      if (decoded.prefix !== POOL_HRP) throw new Error('CARDANO_INVALID_POOL_ID');
      const raw = Uint8Array.from(bech32.fromWords([...decoded.words]));
      if (raw.length !== CREDENTIAL_HASH_BYTES) throw new Error('CARDANO_INVALID_POOL_ID');
      return raw;
    } catch {
      throw new Error('CARDANO_INVALID_POOL_ID');
    }
  }

  try {
    return credentialHash(poolId);
  } catch {
    throw new Error('CARDANO_INVALID_POOL_ID');
  }
}

/**
 * One certificate.
 *
 * @param certificate - What the certificate is for.
 * @returns Its canonical CBOR: an array whose first item is the Conway tag.
 */
export function encodeCertificate(certificate: CardanoStakingCertificate): Uint8Array {
  const stake = encodeCredential(certificate.stake);

  switch (certificate.kind) {
    case 'register':
      return array([uint(TAG.register), stake, uint(certificate.depositLovelace)]);
    case 'deregister':
      return array([uint(TAG.deregister), stake, uint(certificate.refundLovelace)]);
    case 'delegate_pool':
      return array([uint(TAG.stakeDelegation), stake, bytes(poolKeyHash(certificate.poolId))]);
    case 'delegate_vote':
      return array([uint(TAG.voteDelegation), stake, encodeDRep(certificate.drep)]);
    case 'delegate_pool_and_vote':
      return array([
        uint(TAG.stakeAndVoteDelegation),
        stake,
        bytes(poolKeyHash(certificate.poolId)),
        encodeDRep(certificate.drep)
      ]);
    case 'register_and_delegate_pool':
      return array([
        uint(TAG.registerAndDelegateStake),
        stake,
        bytes(poolKeyHash(certificate.poolId)),
        uint(certificate.depositLovelace)
      ]);
    case 'register_and_delegate_vote':
      return array([
        uint(TAG.registerAndDelegateVote),
        stake,
        encodeDRep(certificate.drep),
        uint(certificate.depositLovelace)
      ]);
    case 'register_and_delegate_pool_and_vote':
      return array([
        uint(TAG.registerAndDelegateStakeAndVote),
        stake,
        bytes(poolKeyHash(certificate.poolId)),
        encodeDRep(certificate.drep),
        uint(certificate.depositLovelace)
      ]);
  }
}

/**
 * The `certificates` field: a non-empty set, in the tagged form Conway specifies.
 *
 * Not sorted. The ledger applies certificates in sequence, so their order is part of what the
 * transaction means — a delegation placed before the registration it depends on is invalid, and
 * "tidying" the set would produce exactly that.
 *
 * @param certificates - The certificates, in the order they should be applied.
 * @returns The canonical CBOR of the field.
 * @throws Error `CARDANO_EMPTY_CERTIFICATE_SET` when there are none. The field is
 *   `nonempty_set<certificate>`, so an empty one is malformed — and omitting the key entirely is
 *   what a transaction with no certificates does.
 */
export function encodeCertificates(certificates: readonly CardanoStakingCertificate[]): Uint8Array {
  if (certificates.length === 0) throw new Error('CARDANO_EMPTY_CERTIFICATE_SET');
  return set(certificates.map(encodeCertificate));
}

/**
 * The `withdrawals` field: `{ reward_account => coin }`.
 *
 * The key is the 29-byte reward account, header byte included — not the bech32 text and not the
 * bare credential. Keys are sorted the canonical way, which for a map of equal-length byte strings
 * is bytewise; the transaction id is the hash of these bytes, so an unsorted map is a different
 * transaction.
 *
 * @param withdrawals - The accounts to empty, in any order.
 * @returns The canonical CBOR of the field.
 * @throws Error `CARDANO_EMPTY_WITHDRAWAL_SET` when there are none, `CARDANO_INVALID_REWARD_ADDRESS`
 *   for an address that does not decode, and `CARDANO_DUPLICATE_WITHDRAWAL` when one account is
 *   named twice — a map cannot hold it twice, so one of the two amounts would silently disappear.
 */
export function encodeWithdrawals(withdrawals: readonly CardanoWithdrawal[]): Uint8Array {
  if (withdrawals.length === 0) throw new Error('CARDANO_EMPTY_WITHDRAWAL_SET');

  const byAccount = new Map<string, bigint>();
  for (const withdrawal of withdrawals) {
    const decoded = decodeRewardAddress(withdrawal.rewardAddress);
    if (decoded === null) throw new Error('CARDANO_INVALID_REWARD_ADDRESS');

    const key = Buffer.from(decoded.payload).toString('hex');
    if (byAccount.has(key)) throw new Error('CARDANO_DUPLICATE_WITHDRAWAL');
    byAccount.set(key, withdrawal.lovelace);
  }

  const accounts = [...byAccount.keys()].sort(compareCborKeys);
  return map(
    accounts.map((account) => [bytes(hexToBytes(account)), uint(byAccount.get(account)!)] as const)
  );
}

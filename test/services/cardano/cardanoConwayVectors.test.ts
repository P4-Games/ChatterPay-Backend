import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { describe, expect, it } from 'vitest';

import {
  baseAddress,
  decodeCardanoAddress,
  decodeRewardAddress,
  rewardAddress
} from '../../../src/services/cardano/cardanoAddressService';
import {
  type CardanoCredential,
  encodeCertificate,
  encodeCertificates,
  encodeWithdrawals
} from '../../../src/services/cardano/cardanoCertificateService';
import {
  encodeOutput,
  encodeTransactionBody,
  transactionIdOf
} from '../../../src/services/cardano/cardanoTxService';
import type { CardanoNetwork, CardanoUtxo } from '../../../src/types/cardanoType';

/**
 * Cross-validation against cardano-serialization-lib, the reference Cardano encoder.
 *
 * This is the check `borc` could not make. `borc` proves the bytes are the CBOR structure we
 * intended; it knows nothing about Conway's CDDL, so a certificate with the wrong tag or a field in
 * the wrong position decodes perfectly and is still a transaction the ledger rejects.
 * cardano-serialization-lib is Cardano-aware, written by Emurgo, and is what wallets serialise
 * with — so "our bytes equal its bytes" is a statement about the ledger's rules, not about ours.
 *
 * It is a **test-only** dependency. The reason this repository hand-rolls its CBOR has not changed:
 * the fee depends on the serialized size, so the encoder is part of the fee calculation rather than
 * a detail underneath it, and a WASM module in the request path buys nothing. Here it is a second
 * opinion, which is exactly what a reference implementation is good for.
 *
 * Everything below runs offline. Nothing here submits a transaction, and nothing here is evidence
 * that a transaction was accepted by a node.
 */

const STAKE_KEY_HASH = 'cc2f0b60ee5c4edb7bcc46410787d389539cddf5b64f0012304b91da';
const OTHER_KEY_HASH = '313318dd5b51b0376278ee8f2ad38cdf9466d483e60c312428964faf';
const SCRIPT_HASH = '00000000000000000000000000000000000000000000000000000001';
const POOL_HASH = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5';

const PAYMENT_KEY = '0x7c3ca0ade35d250f5706a17cbbc9e97402b5c230b26b24b940c77e4c00154636';
const STAKE_KEY = '0xce3b525279e269bac5368d404508d9fa9c527bda6eadbf639fed17673ed50d18';

const DEPOSIT = 2_000_000n;

const STAKE: CardanoCredential = { type: 'key_hash', hashHex: STAKE_KEY_HASH };
const STAKE_SCRIPT: CardanoCredential = { type: 'script_hash', hashHex: SCRIPT_HASH };

/** CIP-19 network ids, the low nibble of every address header. */
const NETWORK_ID: Readonly<Record<CardanoNetwork, number>> = { testnet: 0, mainnet: 1 };

/**
 * Renders bytes as lowercase hex.
 *
 * @param value - The bytes.
 * @returns Hex without `0x`.
 */
function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

/**
 * A credential, as the reference library models it.
 *
 * @param hashHex - The 28-byte hash.
 * @param kind - Whether the hash is of a key or of a script.
 * @returns The reference credential.
 */
function reference(hashHex: string, kind: 'key' | 'script' = 'key') {
  return kind === 'key'
    ? CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(hashHex))
    : CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(hashHex));
}

/** Lovelace as the reference library wants it. */
const coin = (value: bigint) => CSL.BigNum.from_str(String(value));

/** A minimal UTxO: only the hash and index reach the body. */
function utxo(txHash: string, outputIndex: number): CardanoUtxo {
  return { txHash, outputIndex, lovelace: 10_000_000n, holdsOtherAssets: false, assets: [] };
}

describe('Conway encoding, against cardano-serialization-lib', () => {
  describe('certificates', () => {
    it('registers with an explicit deposit', () => {
      const mine = encodeCertificate({ kind: 'register', stake: STAKE, depositLovelace: DEPOSIT });
      const theirs = CSL.Certificate.new_stake_registration(
        CSL.StakeRegistration.new_with_explicit_deposit(reference(STAKE_KEY_HASH), coin(DEPOSIT))
      );

      expect(hex(mine)).toBe(hex(theirs.to_bytes()));
    });

    it('deregisters with an explicit refund', () => {
      const mine = encodeCertificate({
        kind: 'deregister',
        stake: STAKE,
        refundLovelace: DEPOSIT
      });
      const theirs = CSL.Certificate.new_stake_deregistration(
        CSL.StakeDeregistration.new_with_explicit_refund(reference(STAKE_KEY_HASH), coin(DEPOSIT))
      );

      expect(hex(mine)).toBe(hex(theirs.to_bytes()));
    });

    it('delegates to a pool', () => {
      const mine = encodeCertificate({ kind: 'delegate_pool', stake: STAKE, poolId: POOL_HASH });
      const theirs = CSL.Certificate.new_stake_delegation(
        CSL.StakeDelegation.new(reference(STAKE_KEY_HASH), CSL.Ed25519KeyHash.from_hex(POOL_HASH))
      );

      expect(hex(mine)).toBe(hex(theirs.to_bytes()));
    });

    it('delegates a vote to each kind of DRep', () => {
      const targets = [
        {
          mine: { kind: 'always_abstain' } as const,
          theirs: CSL.DRep.new_always_abstain()
        },
        {
          mine: { kind: 'always_no_confidence' } as const,
          theirs: CSL.DRep.new_always_no_confidence()
        },
        {
          mine: {
            kind: 'drep',
            credential: { type: 'key_hash', hashHex: OTHER_KEY_HASH }
          } as const,
          theirs: CSL.DRep.new_key_hash(CSL.Ed25519KeyHash.from_hex(OTHER_KEY_HASH))
        },
        {
          mine: { kind: 'drep', credential: STAKE_SCRIPT } as const,
          theirs: CSL.DRep.new_script_hash(CSL.ScriptHash.from_hex(SCRIPT_HASH))
        }
      ];

      for (const target of targets) {
        const mine = encodeCertificate({ kind: 'delegate_vote', stake: STAKE, drep: target.mine });
        const theirs = CSL.Certificate.new_vote_delegation(
          CSL.VoteDelegation.new(reference(STAKE_KEY_HASH), target.theirs)
        );

        expect(hex(mine)).toBe(hex(theirs.to_bytes()));
      }
    });

    it('delegates pool and vote in one certificate', () => {
      const mine = encodeCertificate({
        kind: 'delegate_pool_and_vote',
        stake: STAKE,
        poolId: POOL_HASH,
        drep: { kind: 'always_abstain' }
      });
      const theirs = CSL.Certificate.new_stake_and_vote_delegation(
        CSL.StakeAndVoteDelegation.new(
          reference(STAKE_KEY_HASH),
          CSL.Ed25519KeyHash.from_hex(POOL_HASH),
          CSL.DRep.new_always_abstain()
        )
      );

      expect(hex(mine)).toBe(hex(theirs.to_bytes()));
    });

    it('registers and delegates to a pool', () => {
      const mine = encodeCertificate({
        kind: 'register_and_delegate_pool',
        stake: STAKE,
        poolId: POOL_HASH,
        depositLovelace: DEPOSIT
      });
      const theirs = CSL.Certificate.new_stake_registration_and_delegation(
        CSL.StakeRegistrationAndDelegation.new(
          reference(STAKE_KEY_HASH),
          CSL.Ed25519KeyHash.from_hex(POOL_HASH),
          coin(DEPOSIT)
        )
      );

      expect(hex(mine)).toBe(hex(theirs.to_bytes()));
    });

    it('registers and delegates a vote', () => {
      const mine = encodeCertificate({
        kind: 'register_and_delegate_vote',
        stake: STAKE,
        drep: { kind: 'always_abstain' },
        depositLovelace: DEPOSIT
      });
      const theirs = CSL.Certificate.new_vote_registration_and_delegation(
        CSL.VoteRegistrationAndDelegation.new(
          reference(STAKE_KEY_HASH),
          CSL.DRep.new_always_abstain(),
          coin(DEPOSIT)
        )
      );

      expect(hex(mine)).toBe(hex(theirs.to_bytes()));
    });

    it('registers, delegates and votes at once', () => {
      const mine = encodeCertificate({
        kind: 'register_and_delegate_pool_and_vote',
        stake: STAKE,
        poolId: POOL_HASH,
        drep: { kind: 'always_abstain' },
        depositLovelace: DEPOSIT
      });
      const theirs = CSL.Certificate.new_stake_vote_registration_and_delegation(
        CSL.StakeVoteRegistrationAndDelegation.new(
          reference(STAKE_KEY_HASH),
          CSL.Ed25519KeyHash.from_hex(POOL_HASH),
          CSL.DRep.new_always_abstain(),
          coin(DEPOSIT)
        )
      );

      expect(hex(mine)).toBe(hex(theirs.to_bytes()));
    });

    it('writes a script stake credential the same way', () => {
      const mine = encodeCertificate({
        kind: 'register',
        stake: STAKE_SCRIPT,
        depositLovelace: DEPOSIT
      });
      const theirs = CSL.Certificate.new_stake_registration(
        CSL.StakeRegistration.new_with_explicit_deposit(
          reference(SCRIPT_HASH, 'script'),
          coin(DEPOSIT)
        )
      );

      expect(hex(mine)).toBe(hex(theirs.to_bytes()));
    });
  });

  describe('the certificate set', () => {
    it('is the same set, with the same tag and the same order', () => {
      const mine = encodeCertificates([
        { kind: 'register', stake: STAKE, depositLovelace: DEPOSIT },
        { kind: 'delegate_pool', stake: STAKE, poolId: POOL_HASH }
      ]);

      const theirs = CSL.Certificates.new();
      theirs.add(
        CSL.Certificate.new_stake_registration(
          CSL.StakeRegistration.new_with_explicit_deposit(reference(STAKE_KEY_HASH), coin(DEPOSIT))
        )
      );
      theirs.add(
        CSL.Certificate.new_stake_delegation(
          CSL.StakeDelegation.new(reference(STAKE_KEY_HASH), CSL.Ed25519KeyHash.from_hex(POOL_HASH))
        )
      );

      expect(hex(mine)).toBe(hex(theirs.to_bytes()));
      // `d90102` is tag 258. Both encoders emit it; a set written as a bare array would hash to a
      // different transaction id.
      expect(hex(mine).startsWith('d90102')).toBe(true);
    });
  });

  describe('reward addresses', () => {
    it.each([
      ['testnet', 'e0'],
      ['mainnet', 'e1']
    ] as const)('derives the %s header %s from the network', (network, headerHex) => {
      // The header is `(14 << 4) | networkId`: the type says "reward account", the low nibble says
      // which chain. Getting the nibble wrong produces a well-formed address on the other network,
      // which is money sent to an account nobody controls here.
      const mine = rewardAddress(STAKE_KEY, network);
      const decoded = decodeRewardAddress(mine);

      expect(hex(decoded?.payload ?? new Uint8Array()).slice(0, 2)).toBe(headerHex);
      expect(decoded?.network).toBe(network);

      const theirs = CSL.RewardAddress.new(
        NETWORK_ID[network],
        reference(decoded?.credentialHex ?? '')
      ).to_address();

      expect(mine).toBe(theirs.to_bech32());
      expect(hex(decoded?.payload ?? new Uint8Array())).toBe(hex(theirs.to_bytes()));
    });

    it('carries the staking credential of the base address it belongs to', () => {
      const base = decodeCardanoAddress(baseAddress(PAYMENT_KEY, STAKE_KEY, 'testnet'));
      const reward = decodeRewardAddress(rewardAddress(STAKE_KEY, 'testnet'));

      expect(reward?.credentialHex).toBe(base?.stakeCredentialHex);
    });

    it('gives the two networks different addresses for the same key', () => {
      expect(rewardAddress(STAKE_KEY, 'testnet')).not.toBe(rewardAddress(STAKE_KEY, 'mainnet'));
      expect(decodeRewardAddress(rewardAddress(STAKE_KEY, 'testnet'))?.credentialHex).toBe(
        decodeRewardAddress(rewardAddress(STAKE_KEY, 'mainnet'))?.credentialHex
      );
    });
  });

  describe('withdrawals', () => {
    const rewardOf = (hashHex: string, network: CardanoNetwork = 'testnet') =>
      CSL.RewardAddress.new(NETWORK_ID[network], reference(hashHex)).to_address().to_bech32();

    it('encodes one account identically', () => {
      const mine = encodeWithdrawals([{ rewardAddress: rewardOf(STAKE_KEY_HASH), lovelace: 5n }]);

      const theirs = CSL.Withdrawals.new();
      theirs.insert(CSL.RewardAddress.new(0, reference(STAKE_KEY_HASH)), coin(5n));

      expect(hex(mine)).toBe(hex(theirs.to_bytes()));
    });

    it('sorts its keys where the reference library keeps insertion order', () => {
      // A documented difference, and a deliberate one. cardano-serialization-lib writes the map in
      // the order entries were inserted, so the same withdrawals produce two different transaction
      // ids depending on the order a caller happened to use. This encoder sorts, which is what
      // canonical CBOR means and what makes the size — and therefore the fee — a function of the
      // withdrawals rather than of the caller. Both are maps the ledger accepts.
      const mine = encodeWithdrawals([
        { rewardAddress: rewardOf(STAKE_KEY_HASH), lovelace: 1n },
        { rewardAddress: rewardOf(OTHER_KEY_HASH), lovelace: 2n }
      ]);

      const insertionOrder = CSL.Withdrawals.new();
      insertionOrder.insert(CSL.RewardAddress.new(0, reference(STAKE_KEY_HASH)), coin(1n));
      insertionOrder.insert(CSL.RewardAddress.new(0, reference(OTHER_KEY_HASH)), coin(2n));

      const sortedOrder = CSL.Withdrawals.new();
      sortedOrder.insert(CSL.RewardAddress.new(0, reference(OTHER_KEY_HASH)), coin(2n));
      sortedOrder.insert(CSL.RewardAddress.new(0, reference(STAKE_KEY_HASH)), coin(1n));

      // `e031…` sorts before `e0cc…`, so the reference library agrees once it is fed in that order.
      expect(hex(mine)).toBe(hex(sortedOrder.to_bytes()));
      expect(hex(mine)).not.toBe(hex(insertionOrder.to_bytes()));
    });

    it('does not depend on the order the caller passes', () => {
      const one = encodeWithdrawals([
        { rewardAddress: rewardOf(STAKE_KEY_HASH), lovelace: 1n },
        { rewardAddress: rewardOf(OTHER_KEY_HASH), lovelace: 2n }
      ]);
      const other = encodeWithdrawals([
        { rewardAddress: rewardOf(OTHER_KEY_HASH), lovelace: 2n },
        { rewardAddress: rewardOf(STAKE_KEY_HASH), lovelace: 1n }
      ]);

      expect(hex(one)).toBe(hex(other));
    });
  });

  describe('whole transaction bodies', () => {
    const TX_HASH = 'aa'.repeat(32);
    const DESTINATION = baseAddress(PAYMENT_KEY, STAKE_KEY, 'testnet');
    const FEE = 170_000n;
    const TTL = 900;
    const OUTPUT_LOVELACE = 1_000_000n;

    /**
     * The same body, built with the reference library.
     *
     * @param withStaking - Whether to add the certificate and the withdrawal.
     * @returns The reference body.
     */
    function referenceBody(withStaking: boolean) {
      const inputs = CSL.TransactionInputs.new();
      inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_hex(TX_HASH), 0));

      const outputs = CSL.TransactionOutputs.new();
      outputs.add(
        CSL.TransactionOutput.new(
          CSL.Address.from_bech32(DESTINATION),
          CSL.Value.new(coin(OUTPUT_LOVELACE))
        )
      );

      const body = CSL.TransactionBody.new_tx_body(inputs, outputs, coin(FEE));
      body.set_ttl(coin(BigInt(TTL)));

      if (withStaking) {
        const certificates = CSL.Certificates.new();
        certificates.add(
          CSL.Certificate.new_stake_registration(
            CSL.StakeRegistration.new_with_explicit_deposit(
              reference(STAKE_KEY_HASH),
              coin(DEPOSIT)
            )
          )
        );
        body.set_certs(certificates);

        const withdrawals = CSL.Withdrawals.new();
        withdrawals.insert(CSL.RewardAddress.new(0, reference(STAKE_KEY_HASH)), coin(5n));
        body.set_withdrawals(withdrawals);
      }

      return body;
    }

    /**
     * The same body, built here.
     *
     * @param withStaking - Whether to add the certificate and the withdrawal.
     * @returns Our serialized body.
     */
    function ourBody(withStaking: boolean): Uint8Array {
      const addressBytes = decodeCardanoAddress(DESTINATION)?.payload ?? new Uint8Array();
      const outputs = [encodeOutput(addressBytes, OUTPUT_LOVELACE)];

      return encodeTransactionBody(
        [utxo(TX_HASH, 0)],
        outputs,
        FEE,
        TTL,
        withStaking
          ? {
              certificates: [{ kind: 'register', stake: STAKE, depositLovelace: DEPOSIT }],
              withdrawals: [
                {
                  rewardAddress: rewardAddress(STAKE_KEY, 'testnet'),
                  lovelace: 5n
                }
              ]
            }
          : {}
      );
    }

    it('matches on a plain transfer body, keys 0 to 3', () => {
      expect(hex(ourBody(false))).toBe(hex(referenceBody(false).to_bytes()));
    });

    it('matches on a staking body, keys 0 to 5', () => {
      expect(hex(ourBody(true))).toBe(hex(referenceBody(true).to_bytes()));
    });

    it('produces the transaction id the reference library computes', () => {
      // The strongest single check here: the id is the blake2b-256 of the body bytes, so an
      // agreement on the id is an agreement on every byte, in order, including the set tag and the
      // map key order.
      for (const withStaking of [false, true]) {
        const theirs = CSL.FixedTransactionBody.from_bytes(referenceBody(withStaking).to_bytes());

        expect(transactionIdOf(ourBody(withStaking))).toBe(theirs.tx_hash().to_hex());
      }
    });

    it('is parsed back by the reference library as the transaction it was meant to be', () => {
      // The other direction, and the one that says most about the ledger's rules: our bytes handed
      // to a Cardano-aware parser, which reads out the certificate and the withdrawal we put in. A
      // structure the parser could not make sense of would fail here even if every byte round-tripped
      // through a generic CBOR decoder.
      const parsed = CSL.FixedTransactionBody.from_bytes(ourBody(true)).transaction_body();

      expect(parsed.fee().to_str()).toBe(String(FEE));
      expect(parsed.ttl_bignum()?.to_str()).toBe(String(TTL));
      expect(parsed.certs()?.len()).toBe(1);

      const certificate = parsed.certs()?.get(0).as_stake_registration();
      expect(certificate?.coin()?.to_str()).toBe(String(DEPOSIT));
      expect(certificate?.stake_credential().to_keyhash()?.to_hex()).toBe(STAKE_KEY_HASH);

      const withdrawals = parsed.withdrawals();
      expect(withdrawals?.len()).toBe(1);
      expect(
        withdrawals
          ?.get(
            CSL.RewardAddress.from_address(
              CSL.Address.from_bech32(rewardAddress(STAKE_KEY, 'testnet'))
            )!
          )
          ?.to_str()
      ).toBe('5');
    });

    it('writes the address bytes the reference library reads back', () => {
      const addressBytes = decodeCardanoAddress(DESTINATION)?.payload ?? new Uint8Array();

      expect(hex(addressBytes)).toBe(hex(CSL.Address.from_bech32(DESTINATION).to_bytes()));
    });
  });

  describe('what only the network can answer', () => {
    it.skip('NOT RUN: a Preprod node accepts and confirms these transactions', () => {
      // Everything above is offline and byte-exact against the reference encoder, which settles the
      // structure. It does not settle acceptance: a node also checks the deposit against the live
      // protocol parameter, that the pool is registered and not retired, that the DRep exists, and
      // that the witnesses actually sign. Only a submission answers those.
      //
      // Requires a funded Preprod wallet and provider credentials, neither of which exists here.
      // No economic path is wired to this encoder until it has been done.
    });
  });
});

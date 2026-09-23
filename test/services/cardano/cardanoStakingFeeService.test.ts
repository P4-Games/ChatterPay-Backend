import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { describe, expect, it } from 'vitest';

import {
  decodeCardanoAddress,
  rewardAddress
} from '../../../src/services/cardano/cardanoAddressService';
import type { CardanoStakingCertificate } from '../../../src/services/cardano/cardanoCertificateService';
import {
  requiredWitnessCount,
  requiredWitnessKeys,
  signedTransactionSize,
  stakingChangeLovelace,
  stakingTransactionBalances,
  stakingTransactionFee
} from '../../../src/services/cardano/cardanoStakingFeeService';
import {
  encodeOutput,
  encodeTransactionBody
} from '../../../src/services/cardano/cardanoTxService';
import type { CardanoProtocolParameters, CardanoUtxo } from '../../../src/types/cardanoType';

const SPONSOR_KEY = 'aa'.repeat(28);
const USER_PAYMENT_KEY = 'bb'.repeat(28);
const USER_STAKE_KEY = 'cc2f0b60ee5c4edb7bcc46410787d389539cddf5b64f0012304b91da';

const DESTINATION =
  'addr_test1qzasn8g8wgz5elr7a2jwcpvy9jdpzddy4vc5xtqpkrl53xwv9u9kpmjufmdhhnzxgyrc05uf2wwdmadkfuqpyvztj8dqw6fdax';
const TX_HASH = 'aa'.repeat(32);
const STAKE_PUBLIC_KEY = '0xce3b525279e269bac5368d404508d9fa9c527bda6eadbf639fed17673ed50d18';

const DEPOSIT = 2_000_000n;

/**
 * Representative protocol parameters.
 *
 * Fixed here rather than fetched so the arithmetic is deterministic, and fed to the reference
 * library too, so the comparison holds whatever the live values happen to be.
 */
const PARAMETERS: CardanoProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155_381,
  coinsPerUtxoByte: 4_310n,
  maxTxSize: 16_384
};

const CERTIFICATE: CardanoStakingCertificate = {
  kind: 'register',
  stake: { type: 'key_hash', hashHex: USER_STAKE_KEY },
  depositLovelace: DEPOSIT
};

/** A minimal UTxO: only the hash and index reach the body. */
function utxo(): CardanoUtxo {
  return {
    txHash: TX_HASH,
    outputIndex: 0,
    lovelace: 10_000_000n,
    holdsOtherAssets: false,
    assets: []
  };
}

/**
 * A body with or without the staking fields, built here.
 *
 * @param withStaking - Whether to carry a certificate and a withdrawal.
 * @returns The serialized body.
 */
function body(withStaking: boolean): Uint8Array {
  const addressBytes = decodeCardanoAddress(DESTINATION)?.payload ?? new Uint8Array();

  return encodeTransactionBody(
    [utxo()],
    [encodeOutput(addressBytes, 1_000_000n)],
    170_000n,
    900,
    withStaking
      ? {
          certificates: [CERTIFICATE],
          withdrawals: [{ rewardAddress: rewardAddress(STAKE_PUBLIC_KEY, 'testnet'), lovelace: 5n }]
        }
      : {}
  );
}

/**
 * The same transaction, signed with placeholder witnesses, built by the reference library.
 *
 * @param withStaking - Whether to carry a certificate and a withdrawal.
 * @param witnessCount - How many distinct signatures.
 * @returns The reference transaction.
 */
function referenceTransaction(withStaking: boolean, witnessCount: number) {
  const inputs = CSL.TransactionInputs.new();
  inputs.add(CSL.TransactionInput.new(CSL.TransactionHash.from_hex(TX_HASH), 0));

  const outputs = CSL.TransactionOutputs.new();
  outputs.add(
    CSL.TransactionOutput.new(
      CSL.Address.from_bech32(DESTINATION),
      CSL.Value.new(CSL.BigNum.from_str('1000000'))
    )
  );

  const reference = CSL.TransactionBody.new_tx_body(inputs, outputs, CSL.BigNum.from_str('170000'));
  reference.set_ttl(CSL.BigNum.from_str('900'));

  if (withStaking) {
    const credential = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(USER_STAKE_KEY));

    const certificates = CSL.Certificates.new();
    certificates.add(
      CSL.Certificate.new_stake_registration(
        CSL.StakeRegistration.new_with_explicit_deposit(
          credential,
          CSL.BigNum.from_str(String(DEPOSIT))
        )
      )
    );
    reference.set_certs(certificates);

    const withdrawals = CSL.Withdrawals.new();
    withdrawals.insert(CSL.RewardAddress.new(0, credential), CSL.BigNum.from_str('5'));
    reference.set_withdrawals(withdrawals);
  }

  const witnessSet = CSL.TransactionWitnessSet.new();
  const vkeys = CSL.Vkeywitnesses.new();
  for (let index = 0; index < witnessCount; index += 1) {
    vkeys.add(
      CSL.Vkeywitness.new(
        CSL.Vkey.new(CSL.PublicKey.from_bytes(Buffer.alloc(32, index))),
        CSL.Ed25519Signature.from_bytes(Buffer.alloc(64, index))
      )
    );
  }
  witnessSet.set_vkeys(vkeys);

  return CSL.Transaction.new(reference, witnessSet, undefined);
}

/** The reference library's own fee for a transaction, under the same parameters. */
function referenceFee(transaction: ReturnType<typeof referenceTransaction>): bigint {
  const linear = CSL.LinearFee.new(
    CSL.BigNum.from_str(String(PARAMETERS.minFeeA)),
    CSL.BigNum.from_str(String(PARAMETERS.minFeeB))
  );
  return BigInt(CSL.min_fee(transaction, linear).to_str());
}

describe('cardanoStakingFeeService', () => {
  describe('who has to sign', () => {
    it('counts the sponsor, the user payment key and the user stake key as three', () => {
      // The one people miss: the stake key is a different key from the payment key even though both
      // live in the same wallet. A certificate addresses the stake credential, so it signs too.
      const keys = requiredWitnessKeys(
        {
          sponsorPaymentKeyHash: SPONSOR_KEY,
          userPaymentKeyHash: USER_PAYMENT_KEY,
          userStakeKeyHash: USER_STAKE_KEY
        },
        [CERTIFICATE]
      );

      expect(keys).toHaveLength(3);
      expect(keys).toEqual([...keys].sort());
    });

    it('counts one key once, however many times it appears', () => {
      // A wallet spending four of its own UTxOs signs once. Paying for a second witness would leave
      // the transaction over-funded, and the ledger does not hand the difference back.
      const keys = requiredWitnessKeys(
        { sponsorPaymentKeyHash: SPONSOR_KEY, userPaymentKeyHash: SPONSOR_KEY },
        []
      );

      expect(keys).toEqual([SPONSOR_KEY]);
    });

    it('is not fooled by case', () => {
      const keys = requiredWitnessKeys(
        {
          sponsorPaymentKeyHash: SPONSOR_KEY.toUpperCase(),
          userPaymentKeyHash: SPONSOR_KEY
        },
        []
      );

      expect(keys).toHaveLength(1);
    });

    it('leaves the stake key out when nothing addresses the stake credential', () => {
      // Adding it unconditionally would overcharge every plain transfer by about a hundred bytes.
      const keys = requiredWitnessKeys({
        sponsorPaymentKeyHash: SPONSOR_KEY,
        userPaymentKeyHash: USER_PAYMENT_KEY,
        userStakeKeyHash: USER_STAKE_KEY
      });

      expect(keys).toEqual([SPONSOR_KEY, USER_PAYMENT_KEY].sort());
    });

    it('brings the stake key in for a withdrawal, with no certificate at all', () => {
      const keys = requiredWitnessKeys(
        { userPaymentKeyHash: USER_PAYMENT_KEY, userStakeKeyHash: USER_STAKE_KEY },
        [],
        [{ rewardAddress: rewardAddress(STAKE_PUBLIC_KEY, 'testnet'), lovelace: 1n }]
      );

      expect(keys).toContain(USER_STAKE_KEY);
    });

    it('refuses a transaction nobody would sign', () => {
      expect(() => requiredWitnessCount({})).toThrow('CARDANO_NO_SIGNER');
      expect(() =>
        requiredWitnessCount({ sponsorPaymentKeyHash: null, userPaymentKeyHash: '' })
      ).toThrow('CARDANO_NO_SIGNER');
    });
  });

  describe('size, measured against the reference library', () => {
    it.each([1, 2, 3])('matches on a plain transfer with %d witnesses', (witnessCount) => {
      const mine = signedTransactionSize(body(false), witnessCount);

      expect(mine).toBe(referenceTransaction(false, witnessCount).to_bytes().length);
    });

    it.each([1, 2, 3])('matches on a staking transaction with %d witnesses', (witnessCount) => {
      const mine = signedTransactionSize(body(true), witnessCount);

      expect(mine).toBe(referenceTransaction(true, witnessCount).to_bytes().length);
    });

    it('charges a fixed 101 bytes per additional signature', () => {
      // Ed25519 signatures are fixed width, so the placeholder is the same size as the real thing
      // and the measurement is exact rather than an estimate that has to be padded.
      const one = signedTransactionSize(body(true), 1);
      const two = signedTransactionSize(body(true), 2);
      const three = signedTransactionSize(body(true), 3);

      expect(two - one).toBe(101);
      expect(three - two).toBe(101);
    });
  });

  describe('the fee itself', () => {
    it.each([1, 2, 3])('equals the reference fee with %d witnesses', (witnessCount) => {
      const mine = stakingTransactionFee(body(true), witnessCount, PARAMETERS);

      expect(mine.feeLovelace).toBe(referenceFee(referenceTransaction(true, witnessCount)));
    });

    it('is higher for a staking transaction than for the transfer it grew out of', () => {
      // Certificates and withdrawals are bytes, and bytes are the fee. A fee computed over the
      // transfer body would be short by the whole certificate.
      const transfer = stakingTransactionFee(body(false), 3, PARAMETERS);
      const staking = stakingTransactionFee(body(true), 3, PARAMETERS);

      expect(staking.feeLovelace).toBeGreaterThan(transfer.feeLovelace);
    });

    it('is short by one witness if the stake key is forgotten', () => {
      // The failure this module exists to prevent: the transaction is then unwitnessed, and the fee
      // it was built with is too low to rebuild it.
      const withStake = stakingTransactionFee(body(true), 3, PARAMETERS);
      const without = stakingTransactionFee(body(true), 2, PARAMETERS);

      expect(withStake.feeLovelace - without.feeLovelace).toBe(BigInt(101 * PARAMETERS.minFeeA));
    });

    it('refuses a transaction larger than the protocol allows', () => {
      expect(() => stakingTransactionFee(body(true), 3, { ...PARAMETERS, maxTxSize: 100 })).toThrow(
        'CARDANO_TX_TOO_LARGE'
      );
    });
  });

  describe('deposits, refunds and change', () => {
    const base = {
      inputsLovelace: 0n,
      withdrawalsLovelace: 0n,
      refundsLovelace: 0n,
      outputsLovelace: 0n,
      depositsLovelace: 0n,
      feeLovelace: 0n
    };

    it('takes the deposit out of the change on a registration', () => {
      const change = stakingChangeLovelace({
        ...base,
        inputsLovelace: 10_000_000n,
        depositsLovelace: DEPOSIT,
        feeLovelace: 174_345n
      });

      expect(change).toBe(10_000_000n - DEPOSIT - 174_345n);
    });

    it('puts the refund back into the change on a deregistration', () => {
      // A registration consumes ada into the deposit; a deregistration returns it. Putting either
      // on the wrong side of the equation balances against itself and is rejected on chain with no
      // clue as to which term was wrong.
      const change = stakingChangeLovelace({
        ...base,
        inputsLovelace: 5_000_000n,
        refundsLovelace: DEPOSIT,
        feeLovelace: 174_345n
      });

      expect(change).toBe(5_000_000n + DEPOSIT - 174_345n);
    });

    it('adds a withdrawal to what the transaction consumes', () => {
      const change = stakingChangeLovelace({
        ...base,
        inputsLovelace: 3_000_000n,
        withdrawalsLovelace: 1_500_000n,
        feeLovelace: 170_000n
      });

      expect(change).toBe(3_000_000n + 1_500_000n - 170_000n);
    });

    it('closes the equation on an exit that withdraws, deregisters and sends the rest', () => {
      const amounts = {
        inputsLovelace: 8_000_000n,
        withdrawalsLovelace: 1_234_567n,
        refundsLovelace: DEPOSIT,
        outputsLovelace: 9_000_000n,
        depositsLovelace: 0n,
        feeLovelace: 180_000n
      };

      const change = stakingChangeLovelace(amounts);
      expect(change).toBe(8_000_000n + 1_234_567n + DEPOSIT - 9_000_000n - 180_000n);
      expect(stakingTransactionBalances(amounts, change)).toBe(true);
    });

    it('refuses a transaction that produces more than it consumes', () => {
      // Returning a negative change would push the failure into the output encoder, which would
      // write it as an enormous unsigned integer.
      expect(() =>
        stakingChangeLovelace({ ...base, inputsLovelace: 1_000_000n, depositsLovelace: DEPOSIT })
      ).toThrow('CARDANO_UNBALANCED_TRANSACTION');
    });

    it('spots a change output that does not match the equation', () => {
      const amounts = { ...base, inputsLovelace: 10_000_000n, feeLovelace: 170_000n };

      expect(stakingTransactionBalances(amounts, 9_830_000n)).toBe(true);
      expect(stakingTransactionBalances(amounts, 9_830_001n)).toBe(false);
    });

    it('keeps amounts exact past the limit a float can hold', () => {
      const change = stakingChangeLovelace({
        ...base,
        inputsLovelace: 9_007_199_254_740_993n,
        feeLovelace: 1n
      });

      expect(change).toBe(9_007_199_254_740_992n);
    });
  });
});

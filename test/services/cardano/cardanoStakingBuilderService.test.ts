import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { describe, expect, it } from 'vitest';

import {
  baseAddress,
  decodeCardanoAddress,
  rewardAddress
} from '../../../src/services/cardano/cardanoAddressService';
import type { CardanoCredential } from '../../../src/services/cardano/cardanoCertificateService';
import {
  buildCardanoStakingTransaction,
  type CardanoStakingPlan
} from '../../../src/services/cardano/cardanoStakingBuilderService';
import type { CardanoProtocolParameters, CardanoUtxo } from '../../../src/types/cardanoType';

const USER_PAYMENT = '0x7c3ca0ade35d250f5706a17cbbc9e97402b5c230b26b24b940c77e4c00154636';
const USER_STAKE = '0xce3b525279e269bac5368d404508d9fa9c527bda6eadbf639fed17673ed50d18';
const SPONSOR_PAYMENT = '0x1111111111111111111111111111111111111111111111111111111111111111';
const SPONSOR_STAKE = '0x2222222222222222222222222222222222222222222222222222222222222222';
const RECIPIENT_PAYMENT = '0x3333333333333333333333333333333333333333333333333333333333333333';

const USER_ADDRESS = baseAddress(USER_PAYMENT, USER_STAKE, 'testnet');
const SPONSOR_ADDRESS = baseAddress(SPONSOR_PAYMENT, SPONSOR_STAKE, 'testnet');
const RECIPIENT_ADDRESS = baseAddress(RECIPIENT_PAYMENT, USER_STAKE, 'testnet');

const USER_BYTES = decodeCardanoAddress(USER_ADDRESS)?.payload ?? new Uint8Array();
const SPONSOR_BYTES = decodeCardanoAddress(SPONSOR_ADDRESS)?.payload ?? new Uint8Array();
const RECIPIENT_BYTES = decodeCardanoAddress(RECIPIENT_ADDRESS)?.payload ?? new Uint8Array();

const STAKE_CREDENTIAL: CardanoCredential = {
  type: 'key_hash',
  hashHex: 'cc2f0b60ee5c4edb7bcc46410787d389539cddf5b64f0012304b91da'
};

const REWARD_ADDRESS = rewardAddress(USER_STAKE, 'testnet');
const POOL_ID = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5';

/** Representative protocol parameters, fixed so the arithmetic is deterministic. */
const PARAMETERS: CardanoProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155_381,
  coinsPerUtxoByte: 4_310n,
  maxTxSize: 16_384
};

const DEPOSIT = 2_000_000n;

/**
 * A UTxO.
 *
 * @param seed - Distinguishes the transaction hash.
 * @param lovelace - What it holds.
 * @param assets - Native assets it carries, if any.
 * @returns The output.
 */
function utxo(seed: string, lovelace: bigint, assets: CardanoUtxo['assets'] = []): CardanoUtxo {
  return {
    txHash: seed.repeat(64).slice(0, 64),
    outputIndex: 0,
    lovelace,
    holdsOtherAssets: (assets?.length ?? 0) > 0,
    assets
  };
}

/**
 * A plan with everything a shape needs, overridable per case.
 *
 * @param overrides - What differs.
 * @returns The plan.
 */
function plan(overrides: Partial<CardanoStakingPlan> = {}): CardanoStakingPlan {
  return {
    shape: 'register_and_delegate',
    parameters: PARAMETERS,
    ttlSlot: 900,
    userAddressBytes: USER_BYTES,
    userUtxos: [utxo('a', 10_000_000n)],
    userPaymentKeyHash: 'aa'.repeat(28),
    userStakeKeyHash: STAKE_CREDENTIAL.hashHex,
    stakeCredential: STAKE_CREDENTIAL,
    rewardAddress: REWARD_ADDRESS,
    sponsorAddressBytes: SPONSOR_BYTES,
    sponsorUtxos: [utxo('b', 50_000_000n)],
    sponsorPaymentKeyHash: 'bb'.repeat(28),
    depositLovelace: DEPOSIT,
    poolId: POOL_ID,
    drep: { kind: 'always_abstain' },
    ...overrides
  };
}

/**
 * Asserts the one sentence the ledger actually checks.
 *
 * @param built - What the builder produced.
 */
function expectBalanced(built: ReturnType<typeof buildCardanoStakingTransaction>): void {
  const inputs = [...built.selectedUserUtxos, ...built.selectedSponsorUtxos].reduce(
    (sum, entry) => sum + entry.lovelace,
    0n
  );
  const consumed = inputs + built.withdrawalLovelace + built.refundLovelace;
  const produced =
    built.recipientLovelace +
    built.userChangeLovelace +
    built.sponsorChangeLovelace +
    built.networkFeeLovelace +
    built.depositLovelace;

  expect(consumed).toBe(produced);
}

describe('cardanoStakingBuilderService', () => {
  describe('register and delegate', () => {
    it('makes the user pay the deposit and the sponsor pay the fee', () => {
      // Plan B in one assertion: the deposit leaves the user's side, the network fee leaves the
      // sponsor's, and neither pays the other's.
      const built = buildCardanoStakingTransaction(plan());

      expect(built.depositLovelace).toBe(DEPOSIT);
      expect(built.userChangeLovelace).toBe(10_000_000n - DEPOSIT);
      expect(built.sponsorChangeLovelace).toBe(50_000_000n - built.networkFeeLovelace);
      expectBalanced(built);
    });

    it('needs three distinct signatures: sponsor, user payment and user stake', () => {
      const built = buildCardanoStakingTransaction(plan());

      expect(built.witnessKeys).toHaveLength(3);
      expect(built.witnessKeys).toContain(STAKE_CREDENTIAL.hashHex);
    });

    it('registers and delegates in a single certificate', () => {
      const built = buildCardanoStakingTransaction(plan());

      expect(built.certificates).toHaveLength(1);
      expect(built.certificates[0]?.kind).toBe('register_and_delegate_pool_and_vote');
      expect(built.withdrawals).toHaveLength(0);
    });

    it('refuses to guess a deposit, a pool or a DRep', () => {
      expect(() => buildCardanoStakingTransaction(plan({ depositLovelace: undefined }))).toThrow(
        'CARDANO_STAKING_DEPOSIT_REQUIRED'
      );
      expect(() => buildCardanoStakingTransaction(plan({ poolId: undefined }))).toThrow(
        'CARDANO_STAKING_POOL_REQUIRED'
      );
      expect(() => buildCardanoStakingTransaction(plan({ drep: undefined }))).toThrow(
        'CARDANO_STAKING_DREP_REQUIRED'
      );
    });

    it('builds a body the reference library parses as the transaction it is', () => {
      const built = buildCardanoStakingTransaction(plan());
      const parsed = CSL.FixedTransactionBody.from_bytes(built.bodyBytes).transaction_body();

      expect(parsed.fee().to_str()).toBe(String(built.networkFeeLovelace));
      expect(parsed.certs()?.len()).toBe(1);
      expect(CSL.FixedTransactionBody.from_bytes(built.bodyBytes).tx_hash().to_hex()).toBe(
        built.transactionId
      );
    });
  });

  describe('deregistering', () => {
    it('puts back the deposit that was actually paid, not the parameter of the day', () => {
      // Cardano refunds what was deposited. A certificate built from today's parameter fails to
      // balance if it changed in between, and the failure arrives as a rejected transaction.
      const paidBack = 2_000_000n;
      const built = buildCardanoStakingTransaction(
        plan({ shape: 'deregister', refundLovelace: paidBack, depositLovelace: undefined })
      );

      expect(built.refundLovelace).toBe(paidBack);
      expect(built.depositLovelace).toBe(0n);
      // The refund alone clears the minimum an output must hold, so the wallet's own UTxOs are not
      // touched at all: fewer inputs, a smaller transaction and a lower fee.
      expect(built.selectedUserUtxos).toHaveLength(0);
      expect(built.userChangeLovelace).toBe(paidBack);
      expectBalanced(built);
    });

    it('empties the reward account in the same transaction', () => {
      // The ledger refuses to deregister a credential whose reward balance is not zero.
      const built = buildCardanoStakingTransaction(
        plan({
          shape: 'deregister',
          refundLovelace: DEPOSIT,
          withdrawalLovelace: 1_500_000n,
          depositLovelace: undefined
        })
      );

      expect(built.withdrawals).toHaveLength(1);
      expect(built.userChangeLovelace).toBe(DEPOSIT + 1_500_000n);
      expectBalanced(built);
    });

    it('refuses to build without the refund it has to name', () => {
      expect(() =>
        buildCardanoStakingTransaction(plan({ shape: 'deregister', depositLovelace: undefined }))
      ).toThrow('CARDANO_STAKING_REFUND_REQUIRED');
    });
  });

  describe('withdrawing rewards', () => {
    it('carries no certificate and sends the rewards to the user', () => {
      const built = buildCardanoStakingTransaction(
        plan({
          shape: 'withdraw_rewards',
          withdrawalLovelace: 1_234_567n,
          depositLovelace: undefined
        })
      );

      expect(built.certificates).toHaveLength(0);
      expect(built.withdrawals).toHaveLength(1);
      expect(built.userChangeLovelace).toBe(1_234_567n);
      expectBalanced(built);
    });

    it('leaves the wallet’s own UTxOs alone when the reward already clears min-ADA', () => {
      // Pulling in an input that is not needed grows the transaction, and the size is the fee. It
      // also moves ada the user never asked to move.
      const built = buildCardanoStakingTransaction(
        plan({
          shape: 'withdraw_rewards',
          withdrawalLovelace: 2_000_000n,
          depositLovelace: undefined
        })
      );

      expect(built.selectedUserUtxos).toHaveLength(0);
      expect(built.userChangeLovelace).toBe(2_000_000n);
      expectBalanced(built);
    });

    it('still needs the stake key to sign, with no certificate at all', () => {
      const built = buildCardanoStakingTransaction(
        plan({ shape: 'withdraw_rewards', withdrawalLovelace: 1n, depositLovelace: undefined })
      );

      expect(built.witnessKeys).toContain(STAKE_CREDENTIAL.hashHex);
    });

    it('reaches for a user input when the reward alone cannot clear min-ADA', () => {
      // The change output holding the withdrawal has to exist, and an output below the protocol
      // minimum is a transaction the network rejects.
      const built = buildCardanoStakingTransaction(
        plan({
          shape: 'withdraw_rewards',
          withdrawalLovelace: 5n,
          depositLovelace: undefined,
          userUtxos: [utxo('a', 3_000_000n)]
        })
      );

      expect(built.selectedUserUtxos).toHaveLength(1);
      expect(built.userChangeLovelace).toBe(3_000_005n);
      expectBalanced(built);
    });
  });

  describe('delegation kept independent', () => {
    it('re-delegates the pool without touching the vote', () => {
      const built = buildCardanoStakingTransaction(
        plan({ shape: 'redelegate_pool', depositLovelace: undefined })
      );

      expect(built.certificates[0]?.kind).toBe('delegate_pool');
      expectBalanced(built);
    });

    it('delegates the vote without naming a pool', () => {
      const built = buildCardanoStakingTransaction(
        plan({
          shape: 'delegate_vote',
          depositLovelace: undefined,
          drep: { kind: 'always_abstain' }
        })
      );

      expect(built.certificates[0]?.kind).toBe('delegate_vote');
      expect(JSON.stringify(built.certificates[0])).not.toContain('poolId');
      expectBalanced(built);
    });
  });

  describe('exit and send everything', () => {
    const exitPlan = (overrides: Partial<CardanoStakingPlan> = {}) =>
      plan({
        shape: 'exit_and_send_max',
        depositLovelace: undefined,
        refundLovelace: DEPOSIT,
        withdrawalLovelace: 1_000_000n,
        recipientAddressBytes: RECIPIENT_BYTES,
        commercialFeeLovelace: 300_000n,
        ...overrides
      });

    it('sends UTxOs, withdrawable rewards and the recoverable deposit, less the commercial fee', () => {
      const built = buildCardanoStakingTransaction(exitPlan());

      const gross = 10_000_000n + 1_000_000n + DEPOSIT;
      expect(built.recipientLovelace).toBe(gross - 300_000n);
      expect(built.commercialFeeLovelace).toBe(300_000n);
      expectBalanced(built);
    });

    it('keeps ChatterPay’s commercial fee, which rides home in the sponsor change', () => {
      // The fee is not removed for a staking exit. It comes out of the amount and lands in the
      // sponsor's change, exactly as an ordinary transfer already does it.
      const built = buildCardanoStakingTransaction(exitPlan());

      expect(built.sponsorChangeLovelace).toBe(50_000_000n + 300_000n - built.networkFeeLovelace);
    });

    it('deregisters as part of the same transaction', () => {
      const built = buildCardanoStakingTransaction(exitPlan());

      expect(built.certificates[0]?.kind).toBe('deregister');
      expect(built.withdrawals).toHaveLength(1);
    });

    it('refuses an exit worth less than the commercial fee', () => {
      expect(() =>
        buildCardanoStakingTransaction(
          exitPlan({
            userUtxos: [utxo('a', 1_000_000n)],
            withdrawalLovelace: 0n,
            refundLovelace: 0n,
            commercialFeeLovelace: 5_000_000n
          })
        )
      ).toThrow('CARDANO_STAKING_EXIT_BELOW_COMMERCIAL_FEE');
    });
  });

  describe('native assets', () => {
    const TOKEN = [
      { policyId: 'aa'.repeat(28), assetName: '4142', quantity: 7n }
    ] as CardanoUtxo['assets'];

    it('brings the user’s tokens home in the user’s own change', () => {
      const built = buildCardanoStakingTransaction(
        plan({ userUtxos: [utxo('a', 10_000_000n, TOKEN)] })
      );

      expect(built.userChangeAssets).toHaveLength(1);
      expect(built.userChangeAssets[0]?.quantity).toBe(7n);
      expectBalanced(built);
    });

    it('brings the sponsor’s tokens home in the sponsor’s change, never the user’s', () => {
      // A sponsor input holding tokens must not drag them into the user's change; that is how a
      // sponsor quietly gives its assets away.
      const built = buildCardanoStakingTransaction(
        plan({ sponsorUtxos: [utxo('b', 50_000_000n, TOKEN)] })
      );

      expect(built.sponsorChangeAssets).toHaveLength(1);
      expect(built.userChangeAssets).toHaveLength(0);
      expectBalanced(built);
    });

    it('cannot empty a wallet that holds tokens, and says so in the change it leaves', () => {
      // The output carrying the tokens has to keep enough ada to exist. That residue is the
      // documented reason a full exit is not literally everything.
      const built = buildCardanoStakingTransaction(
        plan({
          shape: 'exit_and_send_max',
          depositLovelace: undefined,
          refundLovelace: 0n,
          withdrawalLovelace: 0n,
          recipientAddressBytes: RECIPIENT_BYTES,
          commercialFeeLovelace: 100_000n,
          userUtxos: [utxo('a', 10_000_000n, TOKEN)]
        })
      );

      expect(built.userChangeLovelace).toBeGreaterThan(0n);
      expect(built.userChangeAssets).toHaveLength(1);
      expect(built.recipientLovelace).toBe(10_000_000n - built.userChangeLovelace - 100_000n);
      expectBalanced(built);
    });

    it('empties a wallet that holds no tokens down to zero change', () => {
      const built = buildCardanoStakingTransaction(
        plan({
          shape: 'exit_and_send_max',
          depositLovelace: undefined,
          refundLovelace: 0n,
          withdrawalLovelace: 0n,
          recipientAddressBytes: RECIPIENT_BYTES,
          commercialFeeLovelace: 100_000n
        })
      );

      expect(built.userChangeLovelace).toBe(0n);
      expect(built.recipientLovelace).toBe(10_000_000n - 100_000n);
      expectBalanced(built);
    });
  });

  describe('selection', () => {
    it('reaches for more than one UTxO when one does not cover the deposit', () => {
      const built = buildCardanoStakingTransaction(
        plan({ userUtxos: [utxo('a', 1_200_000n), utxo('c', 1_300_000n), utxo('d', 1_400_000n)] })
      );

      expect(built.selectedUserUtxos.length).toBeGreaterThan(1);
      expectBalanced(built);
    });

    it('selects the same inputs for the same plan, twice running', () => {
      // A selection that changes between two identical calls is a fee that changes for no reason,
      // and a transaction id nobody can reproduce when reconciling.
      const first = buildCardanoStakingTransaction(plan());
      const second = buildCardanoStakingTransaction(plan());

      expect(first.bodyHex).toBe(second.bodyHex);
      expect(first.transactionId).toBe(second.transactionId);
    });

    it('charges more for a transaction that needed more inputs', () => {
      const few = buildCardanoStakingTransaction(plan());
      const many = buildCardanoStakingTransaction(
        plan({
          userUtxos: Array.from({ length: 6 }, (_, index) =>
            utxo(String.fromCharCode(97 + index), 400_000n)
          )
        })
      );

      expect(many.selectedUserUtxos.length).toBeGreaterThan(few.selectedUserUtxos.length);
      expect(many.networkFeeLovelace).toBeGreaterThan(few.networkFeeLovelace);
    });

    it('refuses when the user cannot cover the deposit', () => {
      expect(() =>
        buildCardanoStakingTransaction(plan({ userUtxos: [utxo('a', 500_000n)] }))
      ).toThrow('CARDANO_INSUFFICIENT_USER_FUNDS');
    });

    it('refuses when the sponsor has nothing to pay the fee with', () => {
      expect(() => buildCardanoStakingTransaction(plan({ sponsorUtxos: [] }))).toThrow(
        'CARDANO_INSUFFICIENT_SPONSOR_FUNDS'
      );
      expect(() =>
        buildCardanoStakingTransaction(plan({ sponsorUtxos: [utxo('b', 1_000n)] }))
      ).toThrow('CARDANO_INSUFFICIENT_SPONSOR_FUNDS');
    });
  });

  describe('precision', () => {
    it('keeps amounts exact past the limit a float can hold', () => {
      const huge = 9_007_199_254_740_993n;
      const built = buildCardanoStakingTransaction(
        plan({ userUtxos: [utxo('a', huge)], sponsorUtxos: [utxo('b', huge)] })
      );

      expect(built.userChangeLovelace).toBe(huge - DEPOSIT);
      expect(built.sponsorChangeLovelace).toBe(huge - built.networkFeeLovelace);
      expectBalanced(built);

      const parsed = CSL.FixedTransactionBody.from_bytes(built.bodyBytes).transaction_body();
      expect(parsed.outputs().get(0).amount().coin().to_str()).toBe(String(huge - DEPOSIT));
    });
  });
});

import mongoose, { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CardanoStakingFeeBudget from '../../../src/models/cardanoStakingFeeBudgetModel';
import CardanoStakingOperation from '../../../src/models/cardanoStakingOperationModel';
import CardanoStakingSponsorFeeEvent from '../../../src/models/cardanoStakingSponsorFeeEventModel';
import {
  baseAddress,
  decodeCardanoAddress,
  rewardAddress
} from '../../../src/services/cardano/cardanoAddressService';
import { CardanoProviderError } from '../../../src/services/cardano/cardanoProviderService';
import type { CardanoStakingPlan } from '../../../src/services/cardano/cardanoStakingBuilderService';
import {
  executeStakingOperation,
  reconcileStakingOperation
} from '../../../src/services/cardano/cardanoStakingLifecycleService';
import type { CardanoProtocolParameters, CardanoUtxo } from '../../../src/types/cardanoType';

const CHAIN_ID = 900000000001;
const WINDOW = '2026-09-23';

const USER_PAYMENT = '0x7c3ca0ade35d250f5706a17cbbc9e97402b5c230b26b24b940c77e4c00154636';
const USER_STAKE = '0xce3b525279e269bac5368d404508d9fa9c527bda6eadbf639fed17673ed50d18';
const SPONSOR_PAYMENT = '0x1111111111111111111111111111111111111111111111111111111111111111';

const USER_BYTES =
  decodeCardanoAddress(baseAddress(USER_PAYMENT, USER_STAKE, 'testnet'))?.payload ??
  new Uint8Array();
const SPONSOR_BYTES =
  decodeCardanoAddress(baseAddress(SPONSOR_PAYMENT, USER_STAKE, 'testnet'))?.payload ??
  new Uint8Array();

const PARAMETERS: CardanoProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155_381,
  coinsPerUtxoByte: 4_310n,
  maxTxSize: 16_384
};

/**
 * A UTxO.
 *
 * @param seed - Distinguishes the transaction hash.
 * @returns The output.
 */
function utxo(seed: string): CardanoUtxo {
  return {
    txHash: seed.repeat(64).slice(0, 64),
    outputIndex: 0,
    lovelace: 20_000_000n,
    holdsOtherAssets: false,
    assets: []
  };
}

/**
 * A registration plan.
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
    userUtxos: [utxo('a')],
    userPaymentKeyHash: 'aa'.repeat(28),
    userStakeKeyHash: 'cc2f0b60ee5c4edb7bcc46410787d389539cddf5b64f0012304b91da',
    stakeCredential: {
      type: 'key_hash',
      hashHex: 'cc2f0b60ee5c4edb7bcc46410787d389539cddf5b64f0012304b91da'
    },
    rewardAddress: rewardAddress(USER_STAKE, 'testnet'),
    sponsorAddressBytes: SPONSOR_BYTES,
    sponsorUtxos: [utxo('b')],
    sponsorPaymentKeyHash: 'bb'.repeat(28),
    depositLovelace: 2_000_000n,
    poolId: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5',
    drep: { kind: 'always_abstain' },
    ...overrides
  };
}

/** Three placeholder witnesses, which is what a registration needs. */
const signer = {
  witnessesFor: () =>
    Array.from({ length: 3 }, (_, index) => ({
      publicKey: Buffer.alloc(32, index).toString('hex'),
      signature: Buffer.alloc(64, index).toString('hex')
    }))
};

/**
 * Creates the operation the lifecycle moves.
 *
 * @param overrides - Fields that differ.
 * @returns The stored operation.
 */
async function seedOperation(overrides: Record<string, unknown> = {}) {
  return CardanoStakingOperation.create({
    accountId: new Types.ObjectId(),
    chainId: CHAIN_ID,
    lifecycleId: 'cycle-1',
    kind: 'register_and_delegate',
    actor: 'cron',
    idempotencyKey: `key-${new Types.ObjectId().toHexString()}`,
    ...overrides
  });
}

/** The request the lifecycle takes, with a provider the case controls. */
function request(
  operation: Awaited<ReturnType<typeof seedOperation>>,
  provider: { submit: (cbor: string) => Promise<string> },
  overrides: Partial<CardanoStakingPlan> = {}
) {
  return {
    operation,
    plan: plan(overrides),
    budget: {
      chainId: CHAIN_ID,
      window: WINDOW,
      capLovelace: '5000000',
      lifecycleId: 'cycle-1',
      kind: 'register_and_delegate'
    },
    signer,
    provider,
    estimatedFeeLovelace: 400_000
  };
}

/** The claim store, read directly. */
function claims() {
  const db = mongoose.connection.db;
  if (db === undefined) throw new Error('no database connection');
  return db.collection('cardano_utxo_claims');
}

describe('cardanoStakingLifecycleService', () => {
  beforeEach(async () => {
    await CardanoStakingOperation.deleteMany({});
    // The schemas carry `autoIndex: false`, so the credential lock only exists once something builds
    // it. In production that is the migration; here it is this line.
    await CardanoStakingOperation.syncIndexes();
    await CardanoStakingFeeBudget.deleteMany({});
    await CardanoStakingSponsorFeeEvent.deleteMany({});
    await CardanoStakingSponsorFeeEvent.syncIndexes();
    await claims().deleteMany({});
    vi.restoreAllMocks();
  });

  describe('the happy path', () => {
    it('reserves budget, claims inputs, signs, stores and submits, in that order', async () => {
      const operation = await seedOperation();
      const submitted: string[] = [];

      const result = await executeStakingOperation(
        request(operation, {
          submit: async (cbor) => {
            submitted.push(cbor);
            return 'ok';
          }
        })
      );

      expect(result.outcome).toBe('submitted');
      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.status).toBe('submitted');
      expect(stored?.chainOutcome).toBe('pending');
      expect(stored?.txId).toBe(result.transactionId);
      expect(stored?.signedCborProtected).toBe(submitted[0]);
      // Both wallets' inputs are held.
      expect(await claims().countDocuments({})).toBe(2);
      // The window was charged once.
      expect(await CardanoStakingSponsorFeeEvent.countDocuments({})).toBe(1);
    });

    it('records the deposit it actually built, so an exit can refund the same figure', async () => {
      const operation = await seedOperation();

      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));

      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.actualRegistrationDepositLovelace).toBe('2000000');
      expect(stored?.selectedOutpoints).toHaveLength(2);
      expect(stored?.ttlSlot).toBe(900);
    });
  });

  describe('a crash between signing and submitting', () => {
    it('leaves the exact transaction it was about to send', async () => {
      // The load-bearing property: without the stored bytes a restarted process cannot tell whether
      // the transaction exists, and rebuilding a different one risks a second paid deposit.
      const operation = await seedOperation();

      await executeStakingOperation(
        request(operation, {
          submit: async () => {
            throw new Error('process died');
          }
        })
      );

      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.signedCborProtected).not.toBeNull();
      expect(stored?.txId).not.toBeNull();
      expect(stored?.chainOutcome).toBe('unknown');
      expect(stored?.liveness).toBe('live');
    });

    it('resubmits the same transaction on the next attempt, never a new one', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(
        request(operation, {
          submit: async () => {
            throw new Error('process died');
          }
        })
      );
      const afterCrash = await CardanoStakingOperation.findById(operation._id);

      const sent: string[] = [];
      const retry = await executeStakingOperation(
        request(afterCrash!, {
          submit: async (cbor) => {
            sent.push(cbor);
            return 'ok';
          }
        })
      );

      expect(retry.outcome).toBe('submitted');
      expect(sent[0]).toBe(afterCrash?.signedCborProtected);
      expect(retry.transactionId).toBe(afterCrash?.txId);
    });

    it('does not charge the window a second time on that retry', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(
        request(operation, {
          submit: async () => {
            throw new Error('process died');
          }
        })
      );
      const reservedAfterFirst = (await CardanoStakingFeeBudget.findOne({}))?.reservedLovelace;

      const afterCrash = await CardanoStakingOperation.findById(operation._id);
      await executeStakingOperation(request(afterCrash!, { submit: async () => 'ok' }));

      expect((await CardanoStakingFeeBudget.findOne({}))?.reservedLovelace).toBe(
        reservedAfterFirst
      );
    });
  });

  describe('an indeterminate submit', () => {
    it('keeps the operation live, with its claims and its reservation', async () => {
      // A node answers "rejected" to a resubmission of a transaction it has already accepted, so a
      // refusal is not proof of absence. Everything is held until a lookup settles it.
      const operation = await seedOperation();

      const result = await executeStakingOperation(
        request(operation, {
          submit: async () => {
            throw new CardanoProviderError('provider_unavailable', 'timeout');
          }
        })
      );

      expect(result.outcome).toBe('unknown_submit');
      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.status).toBe('unknown_submit');
      expect(stored?.absenceProof).toBeNull();
      expect(await claims().countDocuments({})).toBe(2);
      expect((await CardanoStakingFeeBudget.findOne({}))?.reservedLovelace).toBe(400_000);
    });

    it('blocks a second operation on the same account while it is unresolved', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(
        request(operation, {
          submit: async () => {
            throw new Error('unknown');
          }
        })
      );

      await expect(
        CardanoStakingOperation.create({
          accountId: operation.accountId,
          chainId: CHAIN_ID,
          lifecycleId: 'cycle-1',
          kind: 'withdraw_rewards',
          actor: 'cron',
          idempotencyKey: 'second'
        })
      ).rejects.toThrow();
    });
  });

  describe('losing a race for the inputs', () => {
    it('goes back to the queue without signing anything', async () => {
      const first = await seedOperation();
      await executeStakingOperation(request(first, { submit: async () => 'ok' }));

      const second = await seedOperation();
      const result = await executeStakingOperation(request(second, { submit: async () => 'ok' }));

      expect(result.outcome).toBe('input_collision');
      const stored = await CardanoStakingOperation.findById(second._id);
      expect(stored?.status).toBe('queued');
      expect(stored?.signedCborProtected).toBeNull();
      expect(stored?.txId).toBeNull();
    });
  });

  describe('the budget saying no', () => {
    it('builds nothing and claims nothing', async () => {
      const operation = await seedOperation();

      const result = await executeStakingOperation({
        ...request(operation, { submit: async () => 'ok' }),
        budget: {
          chainId: CHAIN_ID,
          window: WINDOW,
          capLovelace: '1000',
          lifecycleId: 'cycle-1',
          kind: 'register_and_delegate'
        }
      });

      expect(result.outcome).toBe('budget_exhausted');
      expect(await claims().countDocuments({})).toBe(0);
      expect(
        (await CardanoStakingOperation.findById(operation._id))?.signedCborProtected
      ).toBeNull();
    });
  });

  describe('a plan that cannot produce a transaction', () => {
    it('is sent to review rather than retried forever', async () => {
      const operation = await seedOperation();

      const result = await executeStakingOperation(
        request(operation, { submit: async () => 'ok' }, { sponsorUtxos: [] })
      );

      expect(result.outcome).toBe('refused');
      expect(result.reason).toContain('CARDANO_INSUFFICIENT_SPONSOR_FUNDS');
      expect((await CardanoStakingOperation.findById(operation._id))?.status).toBe('manual_review');
    });
  });

  describe('reconciling', () => {
    it('confirms a transaction the chain knows', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      const submitted = await CardanoStakingOperation.findById(operation._id);

      const outcome = await reconcileStakingOperation(
        submitted!,
        { statusOf: async () => ({ known: true, confirmations: 3 }) },
        5_000
      );

      expect(outcome).toBe('confirmed');
      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.chainOutcome).toBe('confirmed');
      expect(stored?.liveness).toBe('settled');
    });

    it('holds everything while the TTL has not passed', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      const submitted = await CardanoStakingOperation.findById(operation._id);

      const outcome = await reconcileStakingOperation(
        submitted!,
        { statusOf: async () => ({ known: false, confirmations: 0 }) },
        100
      );

      expect(outcome).toBe('still_pending');
      expect(await claims().countDocuments({})).toBe(2);
    });

    it('holds everything when the provider cannot answer', async () => {
      // A provider that cannot answer has not told us the transaction is absent.
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      const submitted = await CardanoStakingOperation.findById(operation._id);

      const outcome = await reconcileStakingOperation(
        submitted!,
        {
          statusOf: async () => {
            throw new CardanoProviderError('provider_unavailable', 'down');
          }
        },
        99_999
      );

      expect(outcome).toBe('undetermined');
      expect(await claims().countDocuments({})).toBe(2);
      expect((await CardanoStakingOperation.findById(operation._id))?.liveness).toBe('live');
    });

    it('releases the inputs only once absence past the TTL is established', async () => {
      // Both conditions: the TTL has passed *and* a lookup found nothing. Past its TTL a Cardano
      // transaction can never become valid, so at that point absence is final.
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      const submitted = await CardanoStakingOperation.findById(operation._id);

      const outcome = await reconcileStakingOperation(
        submitted!,
        { statusOf: async () => ({ known: false, confirmations: 0 }) },
        99_999
      );

      expect(outcome).toBe('absent_past_ttl');
      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.absenceProof).toBe('ttl_expired_and_absent');
      expect(stored?.liveness).toBe('settled');
      expect(await claims().countDocuments({})).toBe(0);
    });

    it('frees the account for a new operation once it has settled', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      const submitted = await CardanoStakingOperation.findById(operation._id);
      await reconcileStakingOperation(
        submitted!,
        { statusOf: async () => ({ known: false, confirmations: 0 }) },
        99_999
      );

      const next = await CardanoStakingOperation.create({
        accountId: operation.accountId,
        chainId: CHAIN_ID,
        lifecycleId: 'cycle-2',
        kind: 'register_and_delegate',
        actor: 'cron',
        idempotencyKey: 'retry-after-expiry'
      });

      expect(next.liveness).toBe('live');
    });
  });
});

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
import { reserveStakingFee } from '../../../src/services/cardano/cardanoStakingBudgetService';
import type { CardanoStakingPlan } from '../../../src/services/cardano/cardanoStakingBuilderService';
import {
  DEFAULT_RECONCILIATION_POLICY,
  executeStakingOperation,
  reconcileStakingOperation,
  recoverStrandedStakingOperations,
  STRANDED_UNSIGNED_OPERATION_MS,
  type StakingReconciliationOutcome
} from '../../../src/services/cardano/cardanoStakingLifecycleService';
import { stakingClaimHolder } from '../../../src/services/cardano/cardanoStakingReservationService';
import { claimUtxos, pinClaims } from '../../../src/services/cardano/cardanoUtxoClaimService';
import type { CardanoProtocolParameters, CardanoUtxo } from '../../../src/types/cardanoType';

const CHAIN_ID = 900000000001;
const WINDOW = '2026-09-23';
const WINDOW_ID = `${CHAIN_ID}:${WINDOW}`;

/**
 * Reconciles repeatedly, advancing the chain between readings, until something settles.
 *
 * Absence is established over separate readings spread across slots, so a test that wants a settled
 * absence has to give the reconciler a chain that moves — which is exactly the condition a stale
 * provider cannot produce, and the reason the rule is there.
 *
 * @param operationId - The operation to reconcile.
 * @param provider - What to ask.
 * @returns The outcome that settled, or the last one seen.
 */
async function reconcileUntilSettled(
  operationId: Types.ObjectId,
  provider: { statusOf: () => Promise<{ known: boolean; confirmations: number }> }
): Promise<StakingReconciliationOutcome> {
  const step = DEFAULT_RECONCILIATION_POLICY.absenceMarginSlots;
  let outcome: StakingReconciliationOutcome = 'undetermined';
  for (
    let reading = 0;
    reading <= DEFAULT_RECONCILIATION_POLICY.requiredAbsentObservations;
    reading += 1
  ) {
    const current = await CardanoStakingOperation.findById(operationId);
    outcome = await reconcileStakingOperation(current!, provider, 99_999 + reading * step);
    if (outcome !== 'still_pending') return outcome;
  }
  return outcome;
}

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
    // it. In production an administrator creates it by hand; here it is this line.
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
    it('cancels the operation without signing anything', async () => {
      const first = await seedOperation();
      await executeStakingOperation(request(first, { submit: async () => 'ok' }));

      const second = await seedOperation();
      const result = await executeStakingOperation(request(second, { submit: async () => 'ok' }));

      expect(result.outcome).toBe('input_collision');
      const stored = await CardanoStakingOperation.findById(second._id);
      expect(stored?.status).toBe('cancelled');
      expect(stored?.chainOutcome).toBe('rejected');
      expect(stored?.absenceProof).toBe('never_submitted');
      expect(stored?.liveness).toBe('settled');
      expect(stored?.errorCode).toBe('input_collision');
      expect(stored?.signedCborProtected).toBeNull();
      expect(stored?.txId).toBeNull();
    });

    it("gives its fee reservation back and leaves the winner's in place", async () => {
      const first = await seedOperation();
      await executeStakingOperation(request(first, { submit: async () => 'ok' }));
      const second = await seedOperation();

      await executeStakingOperation(request(second, { submit: async () => 'ok' }));

      const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
      expect(budget?.reservedLovelace).toBe(400_000);
      expect([...(budget?.operationCharges.keys() ?? [])]).toEqual([
        (first._id as Types.ObjectId).toHexString()
      ]);
      expect(
        (await CardanoStakingSponsorFeeEvent.findOne({ operationId: second._id }))?.status
      ).toBe('released');
    });

    it('does not release the inputs the winner holds', async () => {
      const first = await seedOperation();
      await executeStakingOperation(request(first, { submit: async () => 'ok' }));
      const second = await seedOperation();

      await executeStakingOperation(request(second, { submit: async () => 'ok' }));

      expect(await claims().countDocuments({})).toBe(2);
      expect(
        await claims().countDocuments({ holder: stakingClaimHolder(first._id as Types.ObjectId) })
      ).toBe(2);
    });

    it('frees the account for a new operation', async () => {
      const first = await seedOperation();
      await executeStakingOperation(request(first, { submit: async () => 'ok' }));
      const second = await seedOperation();
      await executeStakingOperation(request(second, { submit: async () => 'ok' }));

      const next = await seedOperation({ accountId: second.accountId });

      expect(next.liveness).toBe('live');
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

    it('cancels the operation instead of leaving it queued', async () => {
      // A queued operation holds the account's credential and nothing ever resumes it, so every
      // later action on the account, an exit included, would be refused for good.
      const operation = await seedOperation();

      await executeStakingOperation({
        ...request(operation, { submit: async () => 'ok' }),
        budget: { ...request(operation, { submit: async () => 'ok' }).budget, capLovelace: '1000' }
      });

      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.status).toBe('cancelled');
      expect(stored?.absenceProof).toBe('never_submitted');
      expect(stored?.liveness).toBe('settled');
      expect(stored?.errorCode).toBe('budget:insufficient_budget');
      expect(await CardanoStakingSponsorFeeEvent.countDocuments({})).toBe(0);
      expect((await CardanoStakingFeeBudget.findById(WINDOW_ID))?.reservedLovelace).toBe(0);
    });

    it('cancels on an unusable cap as well', async () => {
      const operation = await seedOperation();

      const result = await executeStakingOperation({
        ...request(operation, { submit: async () => 'ok' }),
        budget: {
          ...request(operation, { submit: async () => 'ok' }).budget,
          capLovelace: 'fifty ada'
        }
      });

      expect(result).toMatchObject({ outcome: 'budget_exhausted', reason: 'invalid_cap' });
      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.status).toBe('cancelled');
      expect(stored?.errorCode).toBe('budget:invalid_cap');
    });

    it('lets the account run a new operation once a window has room', async () => {
      const refused = await seedOperation();
      await executeStakingOperation({
        ...request(refused, { submit: async () => 'ok' }),
        budget: { ...request(refused, { submit: async () => 'ok' }).budget, capLovelace: '1000' }
      });

      const next = await seedOperation({ accountId: refused.accountId });
      const result = await executeStakingOperation({
        ...request(next, { submit: async () => 'ok' }),
        budget: { ...request(next, { submit: async () => 'ok' }).budget, window: '2026-09-24' }
      });

      expect(result.outcome).toBe('submitted');
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

    it('does not settle a sighting that has no blocks on top of it yet', async () => {
      // A transaction in the tip block is reported as known and is off chain again if that block
      // loses a short fork. Settling on the first sighting is what makes a deposit appear, be
      // recorded as paid, and then not exist.
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      const submitted = await CardanoStakingOperation.findById(operation._id);

      const outcome = await reconcileStakingOperation(
        submitted!,
        { statusOf: async () => ({ known: true, confirmations: 0 }) },
        5_000
      );

      expect(outcome).toBe('still_pending');
      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.chainOutcome).toBe('pending');
      expect(stored?.liveness).toBe('live');
      expect(await claims().countDocuments({})).toBe(2);
    });

    it('refuses to call one empty lookup past the TTL an absence', async () => {
      // The slot that says the window has closed and the index that says the transaction is unknown
      // come from the same provider. A provider whose follower is current while its transaction
      // index lags is internally consistent and wrong, and one reading cannot tell the difference.
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      const submitted = await CardanoStakingOperation.findById(operation._id);

      const outcome = await reconcileStakingOperation(
        submitted!,
        { statusOf: async () => ({ known: false, confirmations: 0 }) },
        99_999
      );

      expect(outcome).toBe('still_pending');
      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.absenceProof).toBeNull();
      expect(stored?.liveness).toBe('live');
      expect(await claims().countDocuments({})).toBe(2);
    });

    it('refuses three readings taken at the same slot, however many there are', async () => {
      // Counting alone is satisfied by a tight loop against one stale provider. The readings have
      // to be spread across slots, and a stale provider's tip does not advance.
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await CardanoStakingOperation.findById(operation._id);
        const outcome = await reconcileStakingOperation(
          current!,
          { statusOf: async () => ({ known: false, confirmations: 0 }) },
          99_999
        );
        expect(outcome).toBe('still_pending');
      }

      expect(await claims().countDocuments({})).toBe(2);
      expect((await CardanoStakingOperation.findById(operation._id))?.liveness).toBe('live');
    });

    it('lets a provider that catches up undo every absence it reported while behind', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      const absent = { statusOf: async () => ({ known: false, confirmations: 0 }) };

      await reconcileStakingOperation(
        (await CardanoStakingOperation.findById(operation._id))!,
        absent,
        99_999
      );
      await reconcileStakingOperation(
        (await CardanoStakingOperation.findById(operation._id))!,
        absent,
        100_600
      );
      const caughtUp = await reconcileStakingOperation(
        (await CardanoStakingOperation.findById(operation._id))!,
        { statusOf: async () => ({ known: true, confirmations: 5 }) },
        101_200
      );

      expect(caughtUp).toBe('confirmed');
      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.absentObservations).toBe(0);
      expect(stored?.firstAbsentAtSlot).toBeNull();
    });

    it('releases the inputs once absence is established over readings spread across slots', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      const absent = { statusOf: async () => ({ known: false, confirmations: 0 }) };

      const outcome = await reconcileUntilSettled(operation._id as Types.ObjectId, absent);

      expect(outcome).toBe('absent_past_ttl');
      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.absenceProof).toBe('ttl_expired_and_absent');
      expect(stored?.liveness).toBe('settled');
      expect(await claims().countDocuments({})).toBe(0);
    });

    it('puts a confirmed transaction that left the chain under review rather than settling it', async () => {
      // A rollback deeper than the confirmation threshold. The deposit recorded as paid, the
      // rewards withdrawn and the certificates placed all have to be re-established by hand, and
      // `unknown` is what puts the credential back under lock while that happens.
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      await reconcileStakingOperation(
        (await CardanoStakingOperation.findById(operation._id))!,
        { statusOf: async () => ({ known: true, confirmations: 9 }) },
        5_000
      );

      const outcome = await reconcileStakingOperation(
        (await CardanoStakingOperation.findById(operation._id))!,
        { statusOf: async () => ({ known: false, confirmations: 0 }) },
        999_999
      );

      expect(outcome).toBe('reorg_suspected');
      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.status).toBe('manual_review');
      expect(stored?.chainOutcome).toBe('unknown');
      // No absence proof was invented, so nothing may be released on the strength of this.
      expect(stored?.absenceProof).toBeNull();
      expect(stored?.liveness).toBe('live');
    });

    it('frees the account for a new operation once it has settled', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      await reconcileUntilSettled(operation._id as Types.ObjectId, {
        statusOf: async () => ({ known: false, confirmations: 0 })
      });

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

  describe('settling the fee budget', () => {
    /** Inputs no other operation in the case spends, so several can run side by side. */
    function inputs(user: string, sponsor: string): Partial<CardanoStakingPlan> {
      return { userUtxos: [utxo(user)], sponsorUtxos: [utxo(sponsor)] };
    }

    it('settles the reservation at the fee the confirmed transaction paid', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      const submitted = await CardanoStakingOperation.findById(operation._id);
      const paid = Number(submitted?.networkFeeLovelace);

      await reconcileStakingOperation(
        submitted!,
        { statusOf: async () => ({ known: true, confirmations: 3 }) },
        5_000
      );

      expect(paid).toBeGreaterThan(0);
      expect(paid).toBeLessThan(400_000);
      const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
      expect(budget?.reservedLovelace).toBe(paid);
      expect(budget?.confirmedLovelace).toBe(paid);
      expect(
        budget?.operationCharges.get((operation._id as Types.ObjectId).toHexString())
      ).toMatchObject({ lovelace: paid, state: 'settled' });
      const event = await CardanoStakingSponsorFeeEvent.findOne({ operationId: operation._id });
      expect(event?.status).toBe('confirmed');
      expect(event?.txId).toBe(submitted?.txId);
    });

    it('counts the fee once however many times the confirmation is read', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      const confirmed = { statusOf: async () => ({ known: true, confirmations: 3 }) };

      for (let reading = 0; reading < 3; reading += 1) {
        await reconcileStakingOperation(
          (await CardanoStakingOperation.findById(operation._id))!,
          confirmed,
          5_000
        );
      }

      const paid = Number(
        (await CardanoStakingOperation.findById(operation._id))?.networkFeeLovelace
      );
      const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
      expect(budget?.confirmedLovelace).toBe(paid);
      expect(budget?.reservedLovelace).toBe(paid);
    });

    it('keeps the full reservation while the transaction is not settled', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));

      await reconcileStakingOperation(
        (await CardanoStakingOperation.findById(operation._id))!,
        { statusOf: async () => ({ known: true, confirmations: 0 }) },
        5_000
      );

      const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
      expect(budget?.reservedLovelace).toBe(400_000);
      expect(budget?.confirmedLovelace).toBe(0);
    });

    it('releases the reservation once absence is established', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));

      const outcome = await reconcileUntilSettled(operation._id as Types.ObjectId, {
        statusOf: async () => ({ known: false, confirmations: 0 })
      });

      expect(outcome).toBe('absent_past_ttl');
      const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
      expect(budget?.reservedLovelace).toBe(0);
      expect(budget?.confirmedLovelace).toBe(0);
      expect(budget?.operationCharges.size).toBe(0);
      expect(
        (await CardanoStakingSponsorFeeEvent.findOne({ operationId: operation._id }))?.status
      ).toBe('released');
    });

    it('keeps a settled fee counted when a rollback is suspected', async () => {
      // The fee was paid by a transaction the chain confirmed. What happens to it afterwards is for a
      // person to establish, and giving the room back would authorise spending that already happened.
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, { submit: async () => 'ok' }));
      await reconcileStakingOperation(
        (await CardanoStakingOperation.findById(operation._id))!,
        { statusOf: async () => ({ known: true, confirmations: 9 }) },
        5_000
      );

      const outcome = await reconcileStakingOperation(
        (await CardanoStakingOperation.findById(operation._id))!,
        { statusOf: async () => ({ known: false, confirmations: 0 }) },
        999_999
      );

      expect(outcome).toBe('reorg_suspected');
      const paid = Number(
        (await CardanoStakingOperation.findById(operation._id))?.networkFeeLovelace
      );
      const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
      expect(budget?.reservedLovelace).toBe(paid);
      expect(budget?.confirmedLovelace).toBe(paid);
    });

    it('gives back the difference between the estimate and the fee, so the window admits more', async () => {
      // A cap of 1 000 000 lovelace fits two estimates of 400 000 and refuses the third. Once the
      // first confirms at its real fee, the room it no longer needs admits the next operation.
      const capped = (
        operation: Awaited<ReturnType<typeof seedOperation>>,
        overrides: Partial<CardanoStakingPlan>
      ) => ({
        ...request(operation, { submit: async () => 'ok' }, overrides),
        budget: {
          ...request(operation, { submit: async () => 'ok' }).budget,
          capLovelace: '1000000'
        }
      });
      const first = await seedOperation();
      const second = await seedOperation();
      expect((await executeStakingOperation(capped(first, inputs('a', 'b')))).outcome).toBe(
        'submitted'
      );
      expect((await executeStakingOperation(capped(second, inputs('c', 'd')))).outcome).toBe(
        'submitted'
      );
      const refused = await seedOperation();
      expect((await executeStakingOperation(capped(refused, inputs('e', 'f')))).outcome).toBe(
        'budget_exhausted'
      );

      await reconcileStakingOperation(
        (await CardanoStakingOperation.findById(first._id))!,
        { statusOf: async () => ({ known: true, confirmations: 3 }) },
        5_000
      );

      const admitted = await seedOperation();
      expect((await executeStakingOperation(capped(admitted, inputs('1', '2')))).outcome).toBe(
        'submitted'
      );
    });

    it('confirms an operation that holds no reservation without failing', async () => {
      const operation = await seedOperation({
        status: 'submitted',
        chainOutcome: 'pending',
        txId: 'ab'.repeat(32),
        signedCborProtected: 'cafe',
        networkFeeLovelace: '170000'
      });

      const outcome = await reconcileStakingOperation(
        operation,
        { statusOf: async () => ({ known: true, confirmations: 3 }) },
        5_000
      );

      expect(outcome).toBe('confirmed');
      expect(await CardanoStakingFeeBudget.countDocuments({})).toBe(0);
    });

    it('confirms without settling when no usable fee was recorded', async () => {
      const operation = await seedOperation({
        status: 'submitted',
        chainOutcome: 'pending',
        txId: 'ab'.repeat(32),
        signedCborProtected: 'cafe',
        networkFeeLovelace: null
      });
      await reserveStakingFee({
        ...request(operation, { submit: async () => 'ok' }).budget,
        accountId: operation.accountId,
        operationId: operation._id as Types.ObjectId,
        amountLovelace: 400_000
      });

      const outcome = await reconcileStakingOperation(
        operation,
        { statusOf: async () => ({ known: true, confirmations: 3 }) },
        5_000
      );

      expect(outcome).toBe('confirmed');
      const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
      expect(budget?.reservedLovelace).toBe(400_000);
      expect(budget?.confirmedLovelace).toBe(0);
    });
  });

  describe('recovering stranded operations', () => {
    /** A moment past the stranding threshold for anything written now. */
    function later(): Date {
      return new Date(Date.now() + STRANDED_UNSIGNED_OPERATION_MS + 60_000);
    }

    /**
     * Moves an operation's last write into the past, as a process that stopped would leave it.
     *
     * @param operationId - The operation.
     */
    async function age(operationId: unknown): Promise<void> {
      await CardanoStakingOperation.collection.updateOne(
        { _id: operationId as Types.ObjectId },
        { $set: { updatedAt: new Date(Date.now() - STRANDED_UNSIGNED_OPERATION_MS - 60_000) } }
      );
    }

    it('cancels an unsigned operation left idle past the threshold', async () => {
      const operation = await seedOperation();
      await age(operation._id);

      const recovered = await recoverStrandedStakingOperations({ chainId: CHAIN_ID });

      expect(recovered).toBe(1);
      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.status).toBe('cancelled');
      expect(stored?.chainOutcome).toBe('rejected');
      expect(stored?.absenceProof).toBe('never_submitted');
      expect(stored?.liveness).toBe('settled');
      expect(stored?.errorCode).toBe('stranded_unsigned');
    });

    it('recovers an operation a budget refusal left queued', async () => {
      const operation = await seedOperation({ errorCode: 'budget:insufficient_budget' });
      await age(operation._id);

      await recoverStrandedStakingOperations({ accountId: operation.accountId });

      expect((await CardanoStakingOperation.findById(operation._id))?.status).toBe('cancelled');
      expect((await seedOperation({ accountId: operation.accountId })).liveness).toBe('live');
    });

    it('gives back the pinned inputs and the fee reservation a crashed execution held', async () => {
      // The state a process leaves when it dies after pinning its claims and before recording the
      // signature: the claims no longer expire and the window still counts the reservation.
      const operation = await seedOperation();
      const operationId = operation._id as Types.ObjectId;
      await reserveStakingFee({
        ...request(operation, { submit: async () => 'ok' }).budget,
        accountId: operation.accountId,
        operationId,
        amountLovelace: 400_000
      });
      const holder = stakingClaimHolder(operationId);
      const held = await claimUtxos([utxo('a'), utxo('b')], holder, 3_600);
      await pinClaims(held ?? [], holder);
      await age(operationId);

      await recoverStrandedStakingOperations({ chainId: CHAIN_ID });

      expect(await claims().countDocuments({})).toBe(0);
      const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
      expect(budget?.reservedLovelace).toBe(0);
      expect(budget?.operationCharges.size).toBe(0);
    });

    it('leaves an unsigned operation alone while it may still be executing', async () => {
      const operation = await seedOperation();

      const recovered = await recoverStrandedStakingOperations({ chainId: CHAIN_ID });

      expect(recovered).toBe(0);
      expect((await CardanoStakingOperation.findById(operation._id))?.status).toBe('queued');
    });

    it('never touches an operation that has signed bytes or a transaction id', async () => {
      const signed = await seedOperation({
        status: 'signed',
        signedCborProtected: 'cafe',
        txId: 'ab'.repeat(32)
      });
      const inconsistent = await seedOperation({ txId: 'cd'.repeat(32) });
      const withBytes = await seedOperation({ signedCborProtected: 'cafe' });
      for (const operation of [signed, inconsistent, withBytes]) await age(operation._id);

      const recovered = await recoverStrandedStakingOperations({ chainId: CHAIN_ID }, later());

      expect(recovered).toBe(0);
      expect((await CardanoStakingOperation.findById(signed._id))?.status).toBe('signed');
      expect((await CardanoStakingOperation.findById(inconsistent._id))?.status).toBe('queued');
      expect((await CardanoStakingOperation.findById(withBytes._id))?.status).toBe('queued');
    });

    it('never touches an operation in flight or settled', async () => {
      const submitted = await seedOperation();
      await executeStakingOperation(request(submitted, { submit: async () => 'ok' }));
      const review = await seedOperation({ status: 'manual_review' });
      for (const operation of [submitted, review]) await age(operation._id);

      expect(await recoverStrandedStakingOperations({ chainId: CHAIN_ID }, later())).toBe(0);
      expect((await CardanoStakingOperation.findById(submitted._id))?.status).toBe('submitted');
      expect((await CardanoStakingOperation.findById(review._id))?.status).toBe('manual_review');
    });

    it('only looks in the scope it is given', async () => {
      const mine = await seedOperation();
      const theirs = await seedOperation();
      await age(mine._id);
      await age(theirs._id);

      expect(await recoverStrandedStakingOperations({ chainId: CHAIN_ID + 1 })).toBe(0);
      expect(await recoverStrandedStakingOperations({ accountId: mine.accountId })).toBe(1);

      expect((await CardanoStakingOperation.findById(mine._id))?.status).toBe('cancelled');
      expect((await CardanoStakingOperation.findById(theirs._id))?.status).toBe('queued');
    });

    it('makes an execution that loses the race to the recovery submit nothing', async () => {
      // The recovery cancels the operation between the claims being pinned and the signature being
      // recorded. The signature write is conditioned on the operation still being unsigned, so it
      // does not land, and the bytes are never sent.
      const operation = await seedOperation();
      const original = CardanoStakingOperation.updateOne.bind(CardanoStakingOperation);
      let recovered = -1;
      vi.spyOn(CardanoStakingOperation, 'updateOne').mockImplementation(((
        filter: unknown,
        update: unknown,
        ...rest: unknown[]
      ) => {
        const status = (update as { $set?: { status?: string } } | undefined)?.$set?.status;
        if (status === 'signed' && recovered === -1) {
          return (async () => {
            recovered = await recoverStrandedStakingOperations({ chainId: CHAIN_ID }, later());
            return original(filter as never, update as never, ...(rest as []));
          })();
        }
        return original(filter as never, update as never, ...(rest as []));
      }) as never);
      const sent: string[] = [];

      const result = await executeStakingOperation(
        request(operation, {
          submit: async (cbor) => {
            sent.push(cbor);
            return 'ok';
          }
        })
      );

      expect(recovered).toBe(1);
      expect(result).toMatchObject({ outcome: 'refused', reason: 'cancelled' });
      expect(sent).toEqual([]);
      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.status).toBe('cancelled');
      expect(stored?.signedCborProtected).toBeNull();
      expect(stored?.txId).toBeNull();
      expect(await claims().countDocuments({})).toBe(0);
      expect((await CardanoStakingFeeBudget.findById(WINDOW_ID))?.reservedLovelace).toBe(0);
    });

    it('leaves an execution alone once its signature is recorded', async () => {
      const operation = await seedOperation();
      const original = CardanoStakingOperation.updateOne.bind(CardanoStakingOperation);
      let recovered = -1;
      vi.spyOn(CardanoStakingOperation, 'updateOne').mockImplementation(((
        filter: unknown,
        update: unknown,
        ...rest: unknown[]
      ) => {
        const status = (update as { $set?: { status?: string } } | undefined)?.$set?.status;
        if (status === 'signed' && recovered === -1) {
          return (async () => {
            const written = await original(filter as never, update as never, ...(rest as []));
            recovered = await recoverStrandedStakingOperations({ chainId: CHAIN_ID }, later());
            return written;
          })();
        }
        return original(filter as never, update as never, ...(rest as []));
      }) as never);

      const result = await executeStakingOperation(
        request(operation, { submit: async () => 'ok' })
      );

      expect(recovered).toBe(0);
      expect(result.outcome).toBe('submitted');
      expect((await CardanoStakingOperation.findById(operation._id))?.status).toBe('submitted');
      expect(await claims().countDocuments({})).toBe(2);
    });
  });
});

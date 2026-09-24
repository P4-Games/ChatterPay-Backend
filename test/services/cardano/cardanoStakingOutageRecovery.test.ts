import mongoose, { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import CardanoStakingFeeBudget from '../../../src/models/cardanoStakingFeeBudgetModel';
import CardanoStakingOperation from '../../../src/models/cardanoStakingOperationModel';
import CardanoStakingSponsorFeeEvent from '../../../src/models/cardanoStakingSponsorFeeEventModel';
import CardanoUtxoClaim from '../../../src/models/cardanoUtxoClaimModel';
import {
  baseAddress,
  decodeCardanoAddress,
  rewardAddress
} from '../../../src/services/cardano/cardanoAddressService';
import type { CardanoStakingPlan } from '../../../src/services/cardano/cardanoStakingBuilderService';
import {
  executeStakingOperation,
  reconcileStakingOperation
} from '../../../src/services/cardano/cardanoStakingLifecycleService';
import {
  releaseUnsignedStakingInputs,
  reserveStakingInputs,
  selectableStakingUtxos,
  stakingClaimHolder
} from '../../../src/services/cardano/cardanoStakingReservationService';
import type { CardanoProtocolParameters, CardanoUtxo } from '../../../src/types/cardanoType';

const CHAIN_ID = 900000000001;
const WINDOW = '2026-09-23';

/** Two days, which is twice the interval between scheduled syncs. */
const OUTAGE_MS = 48 * 60 * 60 * 1000;

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
 * @returns The plan.
 */
function plan(): CardanoStakingPlan {
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
    drep: { kind: 'always_abstain' }
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

/** The claim store, read directly. */
function claims() {
  const db = mongoose.connection.db;
  if (db === undefined) throw new Error('no database connection');
  return db.collection('cardano_utxo_claims');
}

/**
 * Everything the TTL monitor would delete at a given moment.
 *
 * This is the monitor's own selection criterion — documents whose indexed field holds a date at or
 * before now — evaluated against a clock two days ahead. Using the predicate rather than waiting
 * for the monitor keeps the test deterministic; that the server really does skip a null here was
 * measured separately against a live `mongod`.
 *
 * @param at - The moment to evaluate at.
 * @returns The claims that would be gone.
 */
async function sweptAt(at: Date) {
  return claims()
    .find({ expiresAt: { $lte: at } })
    .toArray();
}

/**
 * Creates the operation the lifecycle moves.
 *
 * @returns The stored operation.
 */
async function seedOperation() {
  return CardanoStakingOperation.create({
    accountId: new Types.ObjectId(),
    chainId: CHAIN_ID,
    lifecycleId: 'cycle-1',
    kind: 'register_and_delegate',
    actor: 'cron',
    idempotencyKey: `key-${new Types.ObjectId().toHexString()}`
  });
}

/**
 * The request the lifecycle takes.
 *
 * @param operation - The operation to move.
 * @param provider - What answers the submit.
 * @returns The request.
 */
function request(
  operation: Awaited<ReturnType<typeof seedOperation>>,
  provider: { submit: (cbor: string) => Promise<string> }
) {
  return {
    operation,
    plan: plan(),
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

/** A submit whose outcome the provider never established. */
const undeterminedSubmit = {
  submit: async () => {
    throw new Error('socket hang up');
  }
};

describe('surviving two days with nothing running', () => {
  beforeEach(async () => {
    await CardanoStakingOperation.deleteMany({});
    await CardanoStakingOperation.syncIndexes();
    await CardanoStakingFeeBudget.deleteMany({});
    await CardanoStakingSponsorFeeEvent.deleteMany({});
    await CardanoStakingSponsorFeeEvent.syncIndexes();
    await claims().deleteMany({});
  });

  describe('a submit whose outcome was never established', () => {
    it('still holds its inputs two days later, with no sync in between', async () => {
      // The scheduled sync runs once a day on an instance that scales to zero, so anything that had
      // to be refreshed on a timer would already be gone. Nothing here is refreshed.
      const operation = await seedOperation();
      const result = await executeStakingOperation(request(operation, undeterminedSubmit));
      expect(result.outcome).toBe('unknown_submit');

      const swept = await sweptAt(new Date(Date.now() + OUTAGE_MS));

      expect(swept).toEqual([]);
      expect(await claims().countDocuments({})).toBe(2);
    });

    it('holds them a year later, because nothing about the hold is a duration', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, undeterminedSubmit));

      const swept = await sweptAt(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));

      expect(swept).toEqual([]);
    });

    it('keeps the operation uncertain, so the credential stays locked', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, undeterminedSubmit));

      const stored = await CardanoStakingOperation.findById(operation._id);
      expect(stored?.chainOutcome).toBe('unknown');
      expect(stored?.liveness).toBe('live');
      expect(stored?.absenceProof).toBeNull();
    });

    it('keeps the budget it charged, which is a document and not a lease', async () => {
      // A reservation that expired on its own would let the same window be spent twice.
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, undeterminedSubmit));

      const budget = await CardanoStakingFeeBudget.findOne({});
      expect(budget?.reservedLovelace).toBe(400_000);
      const charge = budget?.operationCharges?.get((operation._id as Types.ObjectId).toHexString());
      expect(charge?.state).toBe('reserved');
      // No expiry field anywhere on it: nothing removes it but a settle or a proven release.
      expect(Object.keys(budget?.toObject() ?? {})).not.toContain('expiresAt');
    });
  });

  describe('coming back up', () => {
    it('resubmits the same bytes rather than building a second transaction', async () => {
      // What a restart looks like: the operation is re-read from the store and handed back in.
      const operation = await seedOperation();
      const first = await executeStakingOperation(request(operation, undeterminedSubmit));

      const afterRestart = await CardanoStakingOperation.findById(operation._id);
      const sent: string[] = [];
      const second = await executeStakingOperation(
        request(afterRestart!, {
          submit: async (cbor) => {
            sent.push(cbor);
            return 'ok';
          }
        })
      );

      expect(second.transactionId).toBe(first.transactionId);
      expect(sent[0]).toBe(afterRestart?.signedCborProtected);
      // One charge, not two: the window was not spent again.
      expect(await CardanoStakingSponsorFeeEvent.countDocuments({})).toBe(1);
      expect((await CardanoStakingFeeBudget.findOne({}))?.reservedLovelace).toBe(400_000);
    });

    it('goes on refusing to offer the held UTxOs to anything else', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, undeterminedSubmit));

      // What a later sweep sees when the provider offers those same outputs again.
      const offered = await selectableStakingUtxos([utxo('a'), utxo('b'), utxo('c')]);

      expect(offered.map((output) => output.txHash)).toEqual([utxo('c').txHash]);
    });

    it('does not release the inputs on the strength of the outage alone', async () => {
      const operation = await seedOperation();
      await executeStakingOperation(request(operation, undeterminedSubmit));

      // Two days on, the chain is well past the TTL and the provider still cannot answer.
      const outcome = await reconcileStakingOperation(
        (await CardanoStakingOperation.findById(operation._id))!,
        {
          statusOf: async () => {
            throw new Error('still down');
          }
        },
        999_999
      );

      expect(outcome).toBe('undetermined');
      expect(await claims().countDocuments({})).toBe(2);
    });
  });

  describe('the one hold an outage is allowed to break', () => {
    it('lets an unsigned claim lapse, because nothing could be on chain', async () => {
      // Claimed and then abandoned before a signature existed. No transaction was ever produced, so
      // the store dropping these inputs frees something provably nothing is spending.
      const operationId = new Types.ObjectId();
      await reserveStakingInputs(
        {
          selectedUserUtxos: [utxo('a')],
          selectedSponsorUtxos: []
        } as never,
        operationId
      );

      const swept = await sweptAt(new Date(Date.now() + OUTAGE_MS));

      expect(swept).toHaveLength(1);
      expect(swept[0]?.holder).toBe(stakingClaimHolder(operationId));
    });

    it('recovers the same claim deliberately when the backend does come back', async () => {
      const operationId = new Types.ObjectId();
      await CardanoStakingOperation.create({
        _id: operationId,
        accountId: new Types.ObjectId(),
        chainId: CHAIN_ID,
        lifecycleId: 'cycle-1',
        kind: 'register_and_delegate',
        actor: 'cron',
        idempotencyKey: `unsigned-${operationId.toHexString()}`
      });
      await reserveStakingInputs(
        { selectedUserUtxos: [utxo('a')], selectedSponsorUtxos: [] } as never,
        operationId
      );

      expect(await releaseUnsignedStakingInputs(operationId)).toBe('released');
      expect(await claims().countDocuments({})).toBe(0);
    });
  });

  describe('the index the whole thing rests on', () => {
    it('is declared by a model, so it can be created by hand and the guard checks it', async () => {
      // It used to be created lazily by whichever process touched the store first, which is not a
      // thing to rely on once a staking operation's safety depends on how it expires.
      const declared = CardanoUtxoClaim.schema.indexes();

      expect(declared).toHaveLength(1);
      const [spec, options] = declared[0] ?? [];
      expect(spec).toEqual({ expiresAt: 1 });
      expect(options?.expireAfterSeconds).toBe(0);
      // Pinned to the name Mongo generates, which is the name already on deployments that created
      // it lazily. A different name for the same key is a conflict the server refuses.
      expect(options?.name).toBe('expiresAt_1');
    });

    it('never builds itself at import time', async () => {
      // A read-only process must not bring the index into being, and a dry run must leave no trace.
      expect(CardanoUtxoClaim.schema.options.autoIndex).toBe(false);
      expect(CardanoUtxoClaim.schema.options.autoCreate).toBe(false);
    });
  });
});

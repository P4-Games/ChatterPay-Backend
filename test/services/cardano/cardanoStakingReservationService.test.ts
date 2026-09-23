import mongoose, { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CardanoStakingOperation from '../../../src/models/cardanoStakingOperationModel';
import type { BuiltCardanoStakingTransaction } from '../../../src/services/cardano/cardanoStakingBuilderService';
import {
  claimKeysOf,
  outpointsOf,
  releaseStakingInputs,
  releaseUnsignedStakingInputs,
  renewStakingInputs,
  reserveStakingInputs,
  STAKING_CLAIM_SECONDS,
  selectableStakingUtxos,
  stakingClaimHolder
} from '../../../src/services/cardano/cardanoStakingReservationService';
import { claimUtxos } from '../../../src/services/cardano/cardanoUtxoClaimService';
import type { CardanoUtxo } from '../../../src/types/cardanoType';

const CHAIN_ID = 900000000001;

/**
 * A UTxO.
 *
 * @param seed - Distinguishes the transaction hash.
 * @param outputIndex - Index within that transaction.
 * @returns The output.
 */
function utxo(seed: string, outputIndex = 0): CardanoUtxo {
  return {
    txHash: seed.repeat(64).slice(0, 64),
    outputIndex,
    lovelace: 5_000_000n,
    holdsOtherAssets: false,
    assets: []
  };
}

/**
 * Only the parts of a built transaction this module reads.
 *
 * @param userUtxos - The user's selected inputs.
 * @param sponsorUtxos - The sponsor's selected inputs.
 * @returns A stand-in for a built transaction.
 */
function built(
  userUtxos: CardanoUtxo[],
  sponsorUtxos: CardanoUtxo[]
): BuiltCardanoStakingTransaction {
  // Only these two fields are read here; the rest of a built transaction is irrelevant to claiming.
  return {
    selectedUserUtxos: userUtxos,
    selectedSponsorUtxos: sponsorUtxos
  } as unknown as BuiltCardanoStakingTransaction;
}

/**
 * Creates the operation a reservation belongs to.
 *
 * @param operationId - Id to give it.
 * @param absenceProof - Proof that the transaction never reached the chain, when there is one.
 */
async function seedOperation(
  operationId: Types.ObjectId,
  absenceProof: 'never_submitted' | null = null
): Promise<void> {
  await CardanoStakingOperation.create({
    _id: operationId,
    accountId: new Types.ObjectId(),
    chainId: CHAIN_ID,
    lifecycleId: 'cycle-1',
    kind: 'register_and_delegate',
    actor: 'cron',
    idempotencyKey: `key-${operationId.toHexString()}`,
    chainOutcome: absenceProof === null ? 'unknown' : 'rejected',
    absenceProof
  });
}

/** The claim store, read directly. */
function claims() {
  const db = mongoose.connection.db;
  if (db === undefined) throw new Error('no database connection');
  return db.collection('cardano_utxo_claims');
}

describe('cardanoStakingReservationService', () => {
  beforeEach(async () => {
    await CardanoStakingOperation.deleteMany({});
    await claims().deleteMany({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('selecting', () => {
    it('leaves out what another operation already holds', async () => {
      const mine = utxo('a');
      const theirs = utxo('b');
      await claimUtxos([theirs], 'someone-else');

      const available = await selectableStakingUtxos([mine, theirs]);

      expect(available).toEqual([mine]);
    });

    it('refuses to select at all when the claim store cannot be read', async () => {
      // Transfers deliberately fail open here. Staking does not: an unfiltered selection spends
      // outputs another operation has already committed to, and a staking collision does not bounce
      // off the chain harmlessly — it can build a second certificate for a settling credential.
      const db = mongoose.connection.db;
      if (db === undefined) throw new Error('no database connection');
      vi.spyOn(db, 'collection').mockReturnValue({
        createIndex: async () => undefined,
        find: () => {
          throw new Error('mongo is down');
        }
      } as never);

      await expect(selectableStakingUtxos([utxo('a')])).rejects.toThrow(
        'CARDANO_CLAIM_STORE_UNAVAILABLE'
      );
    });
  });

  describe('reserving', () => {
    it('holds every input the transaction spends, on both sides', async () => {
      const operationId = new Types.ObjectId();
      const transaction = built([utxo('a')], [utxo('b'), utxo('c')]);

      const reservation = await reserveStakingInputs(transaction, operationId);

      expect(reservation.outcome).toBe('reserved');
      expect(reservation.outpoints).toHaveLength(3);
      expect(await claims().countDocuments({})).toBe(3);
    });

    it('reports a collision and holds nothing when one output is already taken', async () => {
      // All or nothing: a partial claim denies outputs to the next operation without letting this
      // one proceed.
      const contested = utxo('b');
      await claimUtxos([contested], 'someone-else');
      const transaction = built([utxo('a')], [contested]);

      const reservation = await reserveStakingInputs(transaction, new Types.ObjectId());

      expect(reservation.outcome).toBe('collision');
      expect(reservation.outpoints).toEqual([]);
      // Only the pre-existing claim survives; nothing of this attempt was left behind.
      expect(await claims().countDocuments({})).toBe(1);
    });

    it('lets exactly one of two concurrent operations take a shared input', async () => {
      const shared = utxo('a');

      const outcomes = await Promise.all([
        reserveStakingInputs(built([shared], []), new Types.ObjectId()),
        reserveStakingInputs(built([shared], []), new Types.ObjectId())
      ]);

      expect(outcomes.filter((entry) => entry.outcome === 'reserved')).toHaveLength(1);
      expect(await claims().countDocuments({})).toBe(1);
    });

    it('records who holds the claim', async () => {
      const operationId = new Types.ObjectId();

      await reserveStakingInputs(built([utxo('a')], []), operationId);

      const claim = await claims().findOne({});
      expect(claim?.holder).toBe(`staking:${operationId.toHexString()}`);
    });
  });

  describe('releasing', () => {
    it('keeps the inputs while the transaction is still uncertain', async () => {
      const operationId = new Types.ObjectId();
      await seedOperation(operationId);
      const reservation = await reserveStakingInputs(built([utxo('a')], []), operationId);

      const outcome = await releaseStakingInputs(operationId, reservation.outpoints);

      expect(outcome).toBe('no_absence_proof');
      expect(await claims().countDocuments({})).toBe(1);
    });

    it('keeps the inputs for an operation that was never written', async () => {
      // What a crash between building and persisting leaves behind. The claim stands until a
      // reconciler establishes what happened; guessing here is what lets a second transaction spend
      // outputs the first one may yet consume.
      const operationId = new Types.ObjectId();
      const reservation = await reserveStakingInputs(built([utxo('a')], []), operationId);

      expect(await releaseStakingInputs(operationId, reservation.outpoints)).toBe(
        'no_absence_proof'
      );
      expect(await claims().countDocuments({})).toBe(1);
    });

    it('gives them back once the transaction is shown never to have reached the chain', async () => {
      const operationId = new Types.ObjectId();
      await seedOperation(operationId, 'never_submitted');
      const reservation = await reserveStakingInputs(built([utxo('a')], []), operationId);

      const outcome = await releaseStakingInputs(operationId, reservation.outpoints);

      expect(outcome).toBe('released');
      expect(await claims().countDocuments({})).toBe(0);
    });

    it('lets the outputs be reserved again after a proven release', async () => {
      const first = new Types.ObjectId();
      await seedOperation(first, 'never_submitted');
      const shared = utxo('a');
      const reservation = await reserveStakingInputs(built([shared], []), first);
      await releaseStakingInputs(first, reservation.outpoints);

      const second = await reserveStakingInputs(built([shared], []), new Types.ObjectId());

      expect(second.outcome).toBe('reserved');
    });
  });

  describe('not letting an expiry act as a release', () => {
    it('holds a staking claim far longer than a transfer claim', async () => {
      // The expiry is a backstop against a process that died holding a claim, not the mechanism
      // that frees one. An operation whose submit never resolved can sit undetermined for as long
      // as the provider takes to catch up, and its inputs have to stay held for all of it.
      const operationId = new Types.ObjectId();
      const before = Date.now();

      await reserveStakingInputs(built([utxo('a')], []), operationId);

      const claim = await claims().findOne({});
      const heldForSeconds = ((claim?.expiresAt as Date).getTime() - before) / 1000;
      expect(heldForSeconds).toBeGreaterThan(STAKING_CLAIM_SECONDS - 60);
    });

    it('pushes the expiry out again while the operation is still live', async () => {
      const operationId = new Types.ObjectId();
      await reserveStakingInputs(built([utxo('a')], []), operationId);
      // Pull the expiry back to where a lapsed claim would sit.
      await claims().updateMany({}, { $set: { expiresAt: new Date(Date.now() + 1_000) } });

      const renewed = await renewStakingInputs(operationId);

      expect(renewed).toBe(1);
      const claim = await claims().findOne({});
      expect((claim?.expiresAt as Date).getTime()).toBeGreaterThan(Date.now() + 60_000);
    });

    it('will not renew a claim that now belongs to somebody else', async () => {
      // Renewing on the strength of a stale list would extend another operation's hold.
      const mine = new Types.ObjectId();
      const shared = utxo('a');
      await claimUtxos([shared], 'someone-else');

      expect(await renewStakingInputs(mine)).toBe(0);
    });
  });

  describe('recovering a crash before the operation recorded what it took', () => {
    it('finds the claims by holder when the operation never learnt of them', async () => {
      // The window between claiming the inputs and writing them onto the operation. The claim is
      // the only trace, and the operation cannot describe it — so the holder string is what finds
      // it. Nothing was signed in that window, so nothing can be on chain.
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
      await reserveStakingInputs(built([utxo('a')], [utxo('b')]), operationId);

      expect(await releaseUnsignedStakingInputs(operationId)).toBe('released');
      expect(await claims().countDocuments({})).toBe(0);
      const stored = await CardanoStakingOperation.findById(operationId);
      expect(stored?.absenceProof).toBe('never_submitted');
      expect(stored?.liveness).toBe('settled');
    });

    it('refuses to recover an operation that does carry signed bytes', async () => {
      // Past the signing step a transaction may exist, and only the chain can settle it.
      const operationId = new Types.ObjectId();
      await CardanoStakingOperation.create({
        _id: operationId,
        accountId: new Types.ObjectId(),
        chainId: CHAIN_ID,
        lifecycleId: 'cycle-1',
        kind: 'register_and_delegate',
        actor: 'cron',
        idempotencyKey: `signed-${operationId.toHexString()}`,
        signedCborProtected: '84a4',
        txId: 'ab'.repeat(32)
      });
      await reserveStakingInputs(built([utxo('a')], []), operationId);

      expect(await releaseUnsignedStakingInputs(operationId)).toBe('still_signed');
      expect(await claims().countDocuments({})).toBe(1);
    });

    it('treats a claim whose operation vanished as signed, not as unsigned', async () => {
      // The claim does not say which side of the signing step the process died on, and guessing
      // the safe-sounding side is the one that can free an input a live transaction spends.
      const operationId = new Types.ObjectId();
      await reserveStakingInputs(built([utxo('a')], []), operationId);

      expect(await releaseUnsignedStakingInputs(operationId)).toBe('still_signed');
      expect(await claims().countDocuments({})).toBe(1);
    });

    it('releases everything the holder took, not only what the caller remembered', async () => {
      const operationId = new Types.ObjectId();
      await seedOperation(operationId, 'never_submitted');
      const reservation = await reserveStakingInputs(built([utxo('a')], [utxo('b')]), operationId);

      // What a crash between claiming and recording leaves: the operation knows about one of them.
      await releaseStakingInputs(operationId, reservation.outpoints.slice(0, 1));

      expect(await claims().countDocuments({})).toBe(0);
    });

    it('names claims after the operation that holds them', async () => {
      const operationId = new Types.ObjectId();

      await reserveStakingInputs(built([utxo('a')], []), operationId);

      expect((await claims().findOne({}))?.holder).toBe(stakingClaimHolder(operationId));
    });
  });

  describe('what the operation document records', () => {
    it('lists every input, user side first', async () => {
      const transaction = built([utxo('a'), utxo('a', 1)], [utxo('b')]);

      expect(outpointsOf(transaction)).toEqual([
        { txHash: 'a'.repeat(64), outputIndex: 0 },
        { txHash: 'a'.repeat(64), outputIndex: 1 },
        { txHash: 'b'.repeat(64), outputIndex: 0 }
      ]);
      expect(claimKeysOf(transaction)).toHaveLength(3);
    });
  });
});

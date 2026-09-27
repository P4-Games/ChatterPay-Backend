import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import CardanoStakingFeeBudget from '../../../src/models/cardanoStakingFeeBudgetModel';
import CardanoStakingOperation, {
  type CardanoStakingAbsenceProof,
  type CardanoStakingChainOutcome
} from '../../../src/models/cardanoStakingOperationModel';
import CardanoStakingSponsorFeeEvent from '../../../src/models/cardanoStakingSponsorFeeEventModel';
import {
  budgetWindowId,
  releaseStakingFee,
  reserveStakingFee,
  settleStakingFee
} from '../../../src/services/cardano/cardanoStakingBudgetService';

const CHAIN_ID = 900000000001;
const WINDOW = '2026-09-22';
const WINDOW_ID = budgetWindowId(CHAIN_ID, WINDOW);
const CAP = '1000000';

/**
 * Builds a reservation request.
 *
 * @param operationId - Operation the reservation belongs to.
 * @param amountLovelace - Lovelace to hold.
 * @param capLovelace - Cap to give the window if this call is the one that opens it.
 * @returns The request.
 */
function request(operationId: Types.ObjectId, amountLovelace: number, capLovelace = CAP) {
  return {
    chainId: CHAIN_ID,
    window: WINDOW,
    capLovelace,
    accountId: new Types.ObjectId(),
    operationId,
    lifecycleId: 'cycle-1',
    kind: 'register_and_delegate',
    amountLovelace
  };
}

/**
 * Creates the operation a reservation is for, in whatever state the test needs.
 *
 * @param operationId - Id to give it, matching the reservation.
 * @param chainOutcome - What is known about its transaction.
 * @param absenceProof - Proof that the transaction never reached the chain, when there is one.
 */
async function seedOperation(
  operationId: Types.ObjectId,
  chainOutcome: CardanoStakingChainOutcome,
  absenceProof: CardanoStakingAbsenceProof | null = null
): Promise<void> {
  await CardanoStakingOperation.create({
    _id: operationId,
    accountId: new Types.ObjectId(),
    chainId: CHAIN_ID,
    lifecycleId: 'cycle-1',
    kind: 'register_and_delegate',
    actor: 'cron',
    idempotencyKey: `key-${operationId.toHexString()}`,
    chainOutcome,
    absenceProof
  });
}

/**
 * The window's current numbers.
 *
 * @returns Reserved and confirmed totals.
 */
async function window(): Promise<{ reserved: number; confirmed: number }> {
  const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
  return { reserved: budget?.reservedLovelace ?? -1, confirmed: budget?.confirmedLovelace ?? -1 };
}

describe('cardanoStakingBudgetService', () => {
  beforeEach(async () => {
    await CardanoStakingFeeBudget.deleteMany({});
    await CardanoStakingOperation.deleteMany({});
    await CardanoStakingSponsorFeeEvent.deleteMany({});
    await CardanoStakingSponsorFeeEvent.syncIndexes();
  });

  describe('reserving', () => {
    it('opens the window on first use and holds what fits', async () => {
      const result = await reserveStakingFee(request(new Types.ObjectId(), 400000));

      expect(result.outcome).toBe('granted');
      expect(result.reservedLovelace).toBe(400000);
      expect((await window()).reserved).toBe(400000);
    });

    it('refuses what does not fit, and holds nothing', async () => {
      await reserveStakingFee(request(new Types.ObjectId(), 900000));

      const result = await reserveStakingFee(request(new Types.ObjectId(), 200000));

      expect(result.outcome).toBe('insufficient_budget');
      expect((await window()).reserved).toBe(900000);
    });

    it('records what the window was charged for', async () => {
      const operationId = new Types.ObjectId();

      await reserveStakingFee(request(operationId, 400000));

      const entry = await CardanoStakingSponsorFeeEvent.findOne({ operationId });
      expect(entry?.status).toBe('reserved');
      expect(entry?.amountLovelace).toBe('400000');
      expect(entry?.budgetWindow).toBe(WINDOW_ID);
    });

    it('refuses to work against a cap that is not a usable amount', async () => {
      // `NaN` compares false against every bound, so a coerced typo would produce a window that
      // silently grants nothing rather than one that reports a misconfiguration.
      const result = await reserveStakingFee(request(new Types.ObjectId(), 1, 'one million'));

      expect(result.outcome).toBe('invalid_cap');
      expect((await window()).reserved).toBe(0);
    });

    it('keeps the cap the window opened with when configuration changes under it', async () => {
      await reserveStakingFee(request(new Types.ObjectId(), 900000));

      // A cap that moves under the operations charging against it is not a cap.
      const result = await reserveStakingFee(request(new Types.ObjectId(), 900000, '99000000'));

      expect(result.outcome).toBe('insufficient_budget');
      expect((await window()).reserved).toBe(900000);
    });

    it('keeps windows independent', async () => {
      await reserveStakingFee(request(new Types.ObjectId(), 1000000));

      const other = await reserveStakingFee({
        ...request(new Types.ObjectId(), 1000000),
        window: '2026-09-23'
      });

      expect(other.outcome).toBe('granted');
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of two instances take the last of the budget', async () => {
      const outcomes = await Promise.all([
        reserveStakingFee(request(new Types.ObjectId(), 600000)),
        reserveStakingFee(request(new Types.ObjectId(), 600000))
      ]);

      expect(outcomes.filter((result) => result.outcome === 'granted')).toHaveLength(1);
      expect((await window()).reserved).toBe(600000);
    });

    it('never lets many concurrent writers push a window past its cap', async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 25 }, () => reserveStakingFee(request(new Types.ObjectId(), 100000)))
      );

      expect(outcomes.filter((result) => result.outcome === 'granted')).toHaveLength(10);
      expect((await window()).reserved).toBe(1000000);
    });
  });

  describe('a crash between reserving and persisting the operation', () => {
    it('does not charge the window twice when the retry uses the same operation id', async () => {
      // The reservation comes first and the operation document second, so that a crash in between
      // over-reserves rather than authorising a spend nothing recorded. That order is only safe if
      // repeating the reservation is free, which is what this asserts.
      const operationId = new Types.ObjectId();
      const first = await reserveStakingFee(request(operationId, 400000));
      expect(first.outcome).toBe('granted');

      // The process dies here: no operation document was ever written.
      expect(await CardanoStakingOperation.countDocuments({ _id: operationId })).toBe(0);

      const retry = await reserveStakingFee(request(operationId, 400000));

      expect(retry.outcome).toBe('already_reserved');
      expect((await window()).reserved).toBe(400000);
    });

    it('finishes the audit entry the crashed attempt never wrote', async () => {
      const operationId = new Types.ObjectId();
      await reserveStakingFee(request(operationId, 400000));
      // The crash landed between charging the window and recording what for.
      await CardanoStakingSponsorFeeEvent.deleteMany({ operationId });

      const retry = await reserveStakingFee(request(operationId, 400000));

      expect(retry.outcome).toBe('already_reserved');
      expect((await window()).reserved).toBe(400000);
    });

    it('does not free a reservation whose transaction is still uncertain', async () => {
      const operationId = new Types.ObjectId();
      await reserveStakingFee(request(operationId, 400000));
      await seedOperation(operationId, 'unknown');

      const result = await releaseStakingFee(CHAIN_ID, WINDOW, operationId);

      expect(result.outcome).toBe('no_absence_proof');
      expect((await window()).reserved).toBe(400000);
    });

    it('does not free a reservation on a rejection nothing has corroborated', async () => {
      const operationId = new Types.ObjectId();
      await reserveStakingFee(request(operationId, 400000));
      await seedOperation(operationId, 'rejected');

      const result = await releaseStakingFee(CHAIN_ID, WINDOW, operationId);

      expect(result.outcome).toBe('no_absence_proof');
      expect((await window()).reserved).toBe(400000);
    });

    it('does not free a reservation for an operation that was never written', async () => {
      // The very state a crash between the two steps leaves behind. The budget stays held until a
      // reconciler establishes what happened; guessing here is what would double-spend the window.
      const operationId = new Types.ObjectId();
      await reserveStakingFee(request(operationId, 400000));

      const result = await releaseStakingFee(CHAIN_ID, WINDOW, operationId);

      expect(result.outcome).toBe('no_absence_proof');
      expect((await window()).reserved).toBe(400000);
    });
  });

  describe('releasing on proof', () => {
    it('gives the room back once the transaction is shown never to have reached the chain', async () => {
      const operationId = new Types.ObjectId();
      await reserveStakingFee(request(operationId, 400000));
      await seedOperation(operationId, 'rejected', 'ttl_expired_and_absent');

      const result = await releaseStakingFee(CHAIN_ID, WINDOW, operationId);

      expect(result.outcome).toBe('applied');
      expect((await window()).reserved).toBe(0);
      expect((await CardanoStakingSponsorFeeEvent.findOne({ operationId }))?.status).toBe(
        'released'
      );
    });

    it('releases once however many times it is called', async () => {
      const operationId = new Types.ObjectId();
      await reserveStakingFee(request(operationId, 400000));
      await seedOperation(operationId, 'rejected', 'never_submitted');

      await releaseStakingFee(CHAIN_ID, WINDOW, operationId);
      const second = await releaseStakingFee(CHAIN_ID, WINDOW, operationId);

      expect(second.outcome).toBe('not_reserved');
      expect((await window()).reserved).toBe(0);
    });
  });

  describe('settling', () => {
    it('charges the fee actually paid and gives the difference back', async () => {
      const operationId = new Types.ObjectId();
      await reserveStakingFee(request(operationId, 400000));

      const result = await settleStakingFee(CHAIN_ID, WINDOW, operationId, 168405, 'tx-1');

      expect(result.outcome).toBe('applied');
      expect(await window()).toEqual({ reserved: 168405, confirmed: 168405 });
    });

    it('settles once however many times it is called', async () => {
      const operationId = new Types.ObjectId();
      await reserveStakingFee(request(operationId, 400000));

      await settleStakingFee(CHAIN_ID, WINDOW, operationId, 168405, 'tx-1');
      const second = await settleStakingFee(CHAIN_ID, WINDOW, operationId, 168405, 'tx-1');

      expect(second.outcome).toBe('already_applied');
      expect(await window()).toEqual({ reserved: 168405, confirmed: 168405 });
    });

    it('marks the audit entry with the fee the chain actually took', async () => {
      const operationId = new Types.ObjectId();
      await reserveStakingFee(request(operationId, 400000));

      await settleStakingFee(CHAIN_ID, WINDOW, operationId, 168405, 'tx-1');

      const entry = await CardanoStakingSponsorFeeEvent.findOne({ operationId });
      expect(entry?.status).toBe('confirmed');
      expect(entry?.amountLovelace).toBe('168405');
      expect(entry?.txId).toBe('tx-1');
      expect(entry?.confirmedAt).not.toBeNull();
    });

    it('refuses to settle something the window never held', async () => {
      const result = await settleStakingFee(CHAIN_ID, WINDOW, new Types.ObjectId(), 168405);

      expect(result.outcome).toBe('not_reserved');
    });

    it('does not let a settled operation be reserved again in the same window', async () => {
      const operationId = new Types.ObjectId();
      await reserveStakingFee(request(operationId, 400000));
      await settleStakingFee(CHAIN_ID, WINDOW, operationId, 168405, 'tx-1');

      const again = await reserveStakingFee(request(operationId, 400000));

      expect(again.outcome).toBe('already_reserved');
      expect(await window()).toEqual({ reserved: 168405, confirmed: 168405 });
    });
  });
});

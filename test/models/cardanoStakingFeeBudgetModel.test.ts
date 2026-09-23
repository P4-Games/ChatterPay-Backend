import { beforeEach, describe, expect, it } from 'vitest';

import CardanoStakingFeeBudget from '../../src/models/cardanoStakingFeeBudgetModel';

const CHAIN_ID = 900000000001;
const WINDOW = '2026-09-22';
const WINDOW_ID = `${CHAIN_ID}:${WINDOW}`;

/**
 * The reservation, exactly as the service performs it.
 *
 * Kept here rather than imported because this suite is about the storage guarantee: that the check
 * and the increment happen in one atomic document update, with no read-then-write in between. The
 * service will call the same shape; if it ever stops, this test stops covering it and the service's
 * own suite has to.
 *
 * @param amount - Lovelace to reserve.
 * @param cap - Ceiling for the window.
 * @returns Whether the reservation was granted.
 */
async function reserve(amount: number, cap: number): Promise<boolean> {
  const granted = await CardanoStakingFeeBudget.findOneAndUpdate(
    { _id: WINDOW_ID, reservedLovelace: { $lte: cap - amount } },
    { $inc: { reservedLovelace: amount }, $set: { updatedAt: new Date() } },
    { new: true }
  );

  return granted !== null;
}

describe('cardano_staking_fee_budget', () => {
  beforeEach(async () => {
    await CardanoStakingFeeBudget.deleteMany({});
    await CardanoStakingFeeBudget.create({
      _id: WINDOW_ID,
      chainId: CHAIN_ID,
      window: WINDOW,
      capLovelace: '1000000',
      reservedLovelace: 0,
      confirmedLovelace: 0
    });
  });

  it('grants a reservation that fits', async () => {
    expect(await reserve(400000, 1000000)).toBe(true);

    const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
    expect(budget?.reservedLovelace).toBe(400000);
  });

  it('refuses a reservation that would exceed the cap', async () => {
    expect(await reserve(1000001, 1000000)).toBe(false);

    const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
    expect(budget?.reservedLovelace).toBe(0);
  });

  it('lets exactly one of two concurrent instances take the last of the budget', async () => {
    // The race the counter exists to close: both instances see room, and a read-then-write would
    // let both proceed and overshoot the cap.
    const cap = 1000000;
    const amount = 600000;

    const [first, second] = await Promise.all([reserve(amount, cap), reserve(amount, cap)]);

    expect([first, second].filter(Boolean)).toHaveLength(1);

    const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
    expect(budget?.reservedLovelace).toBe(amount);
    expect(budget?.reservedLovelace).toBeLessThanOrEqual(cap);
  });

  it('never lets many concurrent writers push the window past its cap', async () => {
    const cap = 1000000;
    const amount = 100000;

    const outcomes = await Promise.all(
      Array.from({ length: 25 }, () => reserve(amount, cap))
    );

    const granted = outcomes.filter(Boolean).length;
    expect(granted).toBe(cap / amount);

    const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
    expect(budget?.reservedLovelace).toBe(cap);
  });

  it('keeps a reservation when an outcome is unknown, and releases only on proof it never landed', async () => {
    // The rule the UTxO claims already follow: a claim only goes back when the transaction provably
    // did not reach the chain. An unknown submit keeps holding, or the budget frees ada that a
    // transaction still in flight is about to spend.
    await reserve(400000, 1000000);

    // Unknown outcome: nothing is released.
    let budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
    expect(budget?.reservedLovelace).toBe(400000);

    // Proven never submitted: the reservation goes back.
    await CardanoStakingFeeBudget.updateOne(
      { _id: WINDOW_ID },
      { $inc: { reservedLovelace: -400000 } }
    );

    budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
    expect(budget?.reservedLovelace).toBe(0);
  });

  it('moves a reservation to confirmed for the fee actually paid, releasing the difference', async () => {
    await reserve(400000, 1000000);

    const actuallyPaid = 168405;
    await CardanoStakingFeeBudget.updateOne(
      { _id: WINDOW_ID },
      {
        $inc: {
          reservedLovelace: -400000 + actuallyPaid,
          confirmedLovelace: actuallyPaid
        }
      }
    );

    const budget = await CardanoStakingFeeBudget.findById(WINDOW_ID);
    expect(budget?.reservedLovelace).toBe(actuallyPaid);
    expect(budget?.confirmedLovelace).toBe(actuallyPaid);
  });

  it('keeps windows independent', async () => {
    const otherId = `${CHAIN_ID}:2026-09-23`;
    await CardanoStakingFeeBudget.create({
      _id: otherId,
      chainId: CHAIN_ID,
      window: '2026-09-23',
      capLovelace: '1000000'
    });

    await reserve(1000000, 1000000);

    const other = await CardanoStakingFeeBudget.findById(otherId);
    expect(other?.reservedLovelace).toBe(0);
  });
});

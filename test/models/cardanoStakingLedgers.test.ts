import { Types } from 'mongoose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import CardanoStakingDepositEvent from '../../src/models/cardanoStakingDepositEventModel';
import CardanoStakingGovernanceEvent from '../../src/models/cardanoStakingGovernanceEventModel';
import CardanoStakingReward from '../../src/models/cardanoStakingRewardModel';
import CardanoStakingSponsorFeeEvent from '../../src/models/cardanoStakingSponsorFeeEventModel';
import CardanoStakingSyncRun from '../../src/models/cardanoStakingSyncRunModel';

const CHAIN_ID = 900000000001;

describe('cardano staking ledgers', () => {
  beforeAll(async () => {
    await Promise.all([
      CardanoStakingReward.syncIndexes(),
      CardanoStakingDepositEvent.syncIndexes(),
      CardanoStakingGovernanceEvent.syncIndexes(),
      CardanoStakingSponsorFeeEvent.syncIndexes(),
      CardanoStakingSyncRun.syncIndexes()
    ]);
  });

  beforeEach(async () => {
    await Promise.all([
      CardanoStakingReward.deleteMany({}),
      CardanoStakingDepositEvent.deleteMany({}),
      CardanoStakingGovernanceEvent.deleteMany({}),
      CardanoStakingSponsorFeeEvent.deleteMany({}),
      CardanoStakingSyncRun.deleteMany({})
    ]);
  });

  describe('reward history', () => {
    const reward = (accountId: Types.ObjectId, overrides = {}) => ({
      accountId,
      chainId: CHAIN_ID,
      epoch: 520,
      amountLovelace: '400000',
      sourceKey: 'member-520',
      ...overrides
    });

    it('does not double count when the same epoch is read again', async () => {
      // The sweep re-reads epochs it has already seen. Without this, lifetime earnings climb every
      // run and the figure shown to the user drifts away from the chain.
      const accountId = new Types.ObjectId();
      await CardanoStakingReward.create(reward(accountId));

      await expect(CardanoStakingReward.create(reward(accountId))).rejects.toThrow();
      expect(await CardanoStakingReward.countDocuments({ accountId })).toBe(1);
    });

    it('keeps two distinct credits in the same epoch', async () => {
      const accountId = new Types.ObjectId();
      await CardanoStakingReward.create(reward(accountId, { sourceKey: 'member-520' }));

      const leader = await CardanoStakingReward.create(
        reward(accountId, { sourceKey: 'leader-520', sourceType: 'leader' })
      );

      expect(leader.epoch).toBe(520);
      expect(await CardanoStakingReward.countDocuments({ accountId })).toBe(2);
    });

    it('sums lifetime earnings exactly, past the float limit', async () => {
      const accountId = new Types.ObjectId();
      await CardanoStakingReward.create(
        reward(accountId, { sourceKey: 'a', amountLovelace: '9007199254740993' })
      );
      await CardanoStakingReward.create(reward(accountId, { sourceKey: 'b', amountLovelace: '1' }));

      const rows = await CardanoStakingReward.find({ accountId });
      const total = rows.reduce((sum, row) => sum + BigInt(row.amountLovelace), 0n);

      expect(total).toBe(9007199254740994n);
    });
  });

  describe('deposit events', () => {
    const deposit = (accountId: Types.ObjectId, overrides = {}) => ({
      userId: new Types.ObjectId(),
      chainId: CHAIN_ID,
      accountId,
      lifecycleId: 'cycle-1',
      depositPaidLovelace: '2000000',
      ...overrides
    });

    it('allows one deposit per registration cycle', async () => {
      const accountId = new Types.ObjectId();
      await CardanoStakingDepositEvent.create(deposit(accountId));

      await expect(CardanoStakingDepositEvent.create(deposit(accountId))).rejects.toThrow();
    });

    it('opens a new deposit for a later cycle on the same account', async () => {
      const accountId = new Types.ObjectId();
      await CardanoStakingDepositEvent.create(deposit(accountId));

      const second = await CardanoStakingDepositEvent.create(
        deposit(accountId, { lifecycleId: 'cycle-2' })
      );

      expect(second.lifecycleId).toBe('cycle-2');
    });

    it('records the deposit as the user, never the sponsor, under Plan B', async () => {
      const created = await CardanoStakingDepositEvent.create(deposit(new Types.ObjectId()));

      expect(created.economicOwner).toBe('user');
      expect(created.refundAmountLovelace).toBeNull();
    });

    it('keeps the amount actually paid, which is what an exit has to refund', async () => {
      // Cardano refunds what was deposited, not the current protocol parameter. A parameter that
      // changed in between would make a certificate built from today's value fail to balance.
      const paidUnderOldParameter = '2000000';
      const created = await CardanoStakingDepositEvent.create(
        deposit(new Types.ObjectId(), { depositPaidLovelace: paidUnderOldParameter })
      );

      expect(created.depositPaidLovelace).toBe(paidUnderOldParameter);
    });
  });

  describe('governance history', () => {
    it('records one event per operation, so a re-read does not log a change twice', async () => {
      const operationId = new Types.ObjectId();
      const event = {
        accountId: new Types.ObjectId(),
        chainId: CHAIN_ID,
        kind: 'drep' as const,
        drepIdCip129: 'drep1abc',
        actor: 'dashboard',
        operationId
      };

      await CardanoStakingGovernanceEvent.create(event);

      await expect(CardanoStakingGovernanceEvent.create(event)).rejects.toThrow();
    });

    it('keeps the previous delegation, so the sequence can be rebuilt', async () => {
      const created = await CardanoStakingGovernanceEvent.create({
        accountId: new Types.ObjectId(),
        chainId: CHAIN_ID,
        kind: 'always_no_confidence',
        previousKind: 'always_abstain',
        actor: 'dashboard',
        operationId: new Types.ObjectId()
      });

      expect(created.previousKind).toBe('always_abstain');
      expect(created.drepIdCip129).toBeNull();
    });
  });

  describe('sponsor fee ledger', () => {
    it('charges a window once per operation, so a scheduler retry does not double charge', async () => {
      const operationId = new Types.ObjectId();
      const entry = {
        chainId: CHAIN_ID,
        accountId: new Types.ObjectId(),
        operationId,
        lifecycleId: 'cycle-1',
        kind: 'register_and_delegate',
        amountLovelace: '168405',
        budgetWindow: `${CHAIN_ID}:2026-09-22`
      };

      await CardanoStakingSponsorFeeEvent.create(entry);

      await expect(CardanoStakingSponsorFeeEvent.create(entry)).rejects.toThrow();
    });

    it('starts as reserved rather than confirmed', async () => {
      const created = await CardanoStakingSponsorFeeEvent.create({
        chainId: CHAIN_ID,
        accountId: new Types.ObjectId(),
        operationId: new Types.ObjectId(),
        lifecycleId: 'cycle-1',
        kind: 'delegate_vote',
        amountLovelace: '168405',
        budgetWindow: `${CHAIN_ID}:2026-09-22`
      });

      expect(created.status).toBe('reserved');
      expect(created.confirmedAt).toBeNull();
    });
  });

  describe('sync runs', () => {
    const runId = `preprod:staking-sync:2026-09-22T03:00:00Z`;

    it('makes a scheduler retry resume the same run instead of starting a parallel one', async () => {
      const run = {
        _id: runId,
        chainId: CHAIN_ID,
        scheduledTime: new Date('2026-09-22T03:00:00Z')
      };

      await CardanoStakingSyncRun.create(run);

      await expect(CardanoStakingSyncRun.create(run)).rejects.toThrow();
      expect(await CardanoStakingSyncRun.countDocuments({})).toBe(1);
    });

    it('starts running, reconciling, with no cursor and an empty backlog', async () => {
      const created = await CardanoStakingSyncRun.create({
        _id: runId,
        chainId: CHAIN_ID,
        scheduledTime: new Date('2026-09-22T03:00:00Z')
      });

      expect(created.status).toBe('running');
      // Reconciling before discovering: settling what is already in flight comes first.
      expect(created.phase).toBe('reconciling');
      expect(created.userCursor).toBeNull();
      expect(created.backlogCount).toBe(0);
    });

    it('records a partial run with its backlog and how old the tail is', async () => {
      const oldest = new Date('2026-09-20T03:00:00Z');
      const created = await CardanoStakingSyncRun.create({
        _id: runId,
        chainId: CHAIN_ID,
        scheduledTime: new Date('2026-09-22T03:00:00Z'),
        status: 'partial',
        backlogCount: 1200,
        backlogOldestAt: oldest
      });

      // Size alone does not show a tail that is never reached; age does.
      expect(created.status).toBe('partial');
      expect(created.backlogOldestAt).toEqual(oldest);
    });
  });
});

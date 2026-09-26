import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import { resolveSyncTrigger } from '../../../src/controllers/cardanoStakingSyncController';
import CardanoStakingAccount from '../../../src/models/cardanoStakingAccountModel';
import CardanoStakingSyncLock from '../../../src/models/cardanoStakingSyncLockModel';
import CardanoStakingSyncRun from '../../../src/models/cardanoStakingSyncRunModel';
import { UserModel } from '../../../src/models/userModel';
import {
  acquireNetworkLock,
  runStakingSync,
  type StakingSyncProvider,
  syncRunId
} from '../../../src/services/cardano/cardanoStakingSyncService';
import { stakingConfigFixture } from '../../helpers/stakingConfigFixture';
import { enableCardanoPreprod, setCardanoFeeEnv } from '../../support/cardanoEnv';

vi.mock('../../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  const { cardanoConstantsMock } = await import('../../support/cardanoEnv');
  return cardanoConstantsMock(actual);
});

const CHAIN_ID = CARDANO_PREPROD_CHAIN_ID;
const JOB = 'cardano-staking-sync';
/** The tick a daily schedule delivers, and the "now" every case is judged against. */
const TICK = new Date('2026-03-01T03:00:00.000Z');
const NEXT_TICK = new Date('2026-03-02T03:00:00.000Z');

/**
 * A provider that reads an empty chain and never submits.
 *
 * @returns The provider.
 */
function emptyChain(): StakingSyncProvider {
  return {
    tip: async () => ({ slot: 90_000_000, height: 3_000_000 }),
    utxosFor: async () => [],
    submit: async () => {
      throw new Error('the suite never submits');
    },
    statusOf: async () => ({ known: false, confirmations: 0 }),
    stakingProtocolParameters: async () => ({
      minFeeA: 44,
      minFeeB: 155_381,
      coinsPerUtxoByte: 4_310n,
      maxTxSize: 16_384,
      stakeAddressDeposit: 2_000_000n,
      drepDeposit: 500_000_000n
    }),
    stakeAccount: async () => ({
      registered: false,
      poolId: null,
      governanceDelegation: { kind: 'not_registered' },
      withdrawableRewardsLovelace: 0n,
      lifetimeRewardsLovelace: null,
      withdrawnLovelace: null,
      depositLovelace: null
    }),
    rewardHistory: async () => ({ credits: [], completeness: 'complete' as const }),
    registrationHistory: async () => []
  };
}

/**
 * A request for one run.
 *
 * @param overrides - What differs.
 * @returns The request.
 */
function request(overrides: Partial<Parameters<typeof runStakingSync>[0]> = {}) {
  return {
    chainId: CHAIN_ID,
    jobName: JOB,
    scheduledTime: TICK,
    owner: 'instance-a',
    batchLimit: 50,
    provider: emptyChain(),
    execute: false,
    config: stakingConfigFixture(),
    now: TICK,
    ...overrides
  } as Parameters<typeof runStakingSync>[0];
}

/**
 * An account the refresh pass can read.
 *
 * @param index - Makes it unique.
 */
async function seedAccount(index: number): Promise<void> {
  const user = await UserModel.create({
    phone_number: `54911000${String(index).padStart(5, '0')}`,
    name: `user-${index}`,
    wallets: [],
    settings: {}
  });
  await CardanoStakingAccount.create({
    userId: user._id,
    chainId: CHAIN_ID,
    walletAddress: `addr_test_fake_${index}`,
    rewardAddress: `stake_test_fake_${index}`,
    stakeCredentialHex: new Types.ObjectId().toHexString().padEnd(56, '0'),
    state: 'awaiting_funds'
  });
}

beforeEach(async () => {
  enableCardanoPreprod();
  setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: 'test-sponsor' });
  await CardanoStakingAccount.deleteMany({});
  await CardanoStakingSyncRun.deleteMany({});
  await CardanoStakingSyncLock.deleteMany({});
  await UserModel.deleteMany({});
});

describe('resolveSyncTrigger', () => {
  it('reads a current header as the scheduled tick', () => {
    const trigger = resolveSyncTrigger(TICK.toISOString(), undefined, TICK);

    expect(trigger).toEqual({ kind: 'scheduled', scheduledTime: TICK, reason: 'scheduler_header' });
  });

  it('keeps a header a little ahead of the clock as the tick', () => {
    // Cloud Scheduler and the instance do not share a clock. Two minutes of skew is still this tick.
    const early = new Date(TICK.getTime() - 2 * 60 * 1000);

    expect(resolveSyncTrigger(TICK.toISOString(), undefined, early).kind).toBe('scheduled');
  });

  it('reads a Force run, which carries the next tick, as manual', () => {
    const trigger = resolveSyncTrigger(NEXT_TICK.toISOString(), undefined, TICK);

    expect(trigger.kind).toBe('manual');
    expect(trigger.reason).toBe('schedule_time_in_future');
    // The next tick is not adopted, so the real delivery tomorrow still has its own run.
    expect(trigger.scheduledTime).toEqual(TICK);
  });

  it('reads an unreadable header as manual', () => {
    expect(resolveSyncTrigger('yesterday', undefined, TICK)).toMatchObject({
      kind: 'manual',
      reason: 'schedule_time_unreadable'
    });
  });

  it('lets a body name a past tick to resume', () => {
    const trigger = resolveSyncTrigger(undefined, '2026-02-27T03:00:00Z', TICK);

    expect(trigger).toMatchObject({ kind: 'scheduled', reason: 'body_tick' });
  });

  it('refuses to let a body name a future tick', () => {
    expect(resolveSyncTrigger(undefined, NEXT_TICK.toISOString(), TICK)).toMatchObject({
      kind: 'manual',
      reason: 'body_time_in_future'
    });
  });

  it('reads a call with no time as manual', () => {
    expect(resolveSyncTrigger(undefined, undefined, TICK)).toMatchObject({
      kind: 'manual',
      reason: 'no_schedule_time'
    });
  });

  it('prefers the header over a fixed body date', () => {
    const trigger = resolveSyncTrigger(TICK.toISOString(), '2026-01-01T00:00:00Z', TICK);

    expect(trigger.scheduledTime).toEqual(TICK);
  });
});

describe('scheduled and manual runs', () => {
  it('resolves every retry of a tick to the same run, and does nothing the second time', async () => {
    await seedAccount(1);
    const first = await runStakingSync(request());
    const retry = await runStakingSync(request({ owner: 'instance-b' }));

    expect(retry.runId).toBe(first.runId);
    expect(retry.executed).toBe(false);
    expect(retry.refusal).toBe('already_completed');
  });

  it('reports what the completed tick did, not zeroes, on a redelivery', async () => {
    await seedAccount(2);
    await seedAccount(3);
    await runStakingSync(request());

    const retry = await runStakingSync(request());

    expect(retry.accountsScanned).toBe(2);
    expect(retry.status).toBe('completed');
  });

  it('does not let a Force run complete the next tick ahead of time', async () => {
    await seedAccount(4);
    const forced = resolveSyncTrigger(NEXT_TICK.toISOString(), undefined, TICK);
    const manual = await runStakingSync(
      request({ scheduledTime: forced.scheduledTime, trigger: forced.kind, now: TICK })
    );
    expect(manual.executed).toBe(true);
    expect(manual.runId).not.toBe(syncRunId(CHAIN_ID, JOB, NEXT_TICK));

    const real = await runStakingSync(request({ scheduledTime: NEXT_TICK, now: NEXT_TICK }));

    expect(real.executed).toBe(true);
    expect(real.refusal).toBeNull();
    expect(real.runId).toBe(syncRunId(CHAIN_ID, JOB, NEXT_TICK));
  });

  it('gives two consecutive manual runs identities of their own, and runs both', async () => {
    const first = await runStakingSync(request({ trigger: 'manual' }));
    const second = await runStakingSync(request({ trigger: 'manual' }));

    expect(second.runId).not.toBe(first.runId);
    expect(first.executed).toBe(true);
    expect(second.executed).toBe(true);
    const stored = await CardanoStakingSyncRun.findById(second.runId).lean();
    expect(stored?.trigger).toBe('manual');
  });

  it('runs a manual pass after the tick already completed', async () => {
    await runStakingSync(request());

    const manual = await runStakingSync(request({ trigger: 'manual' }));

    expect(manual.executed).toBe(true);
    expect(manual.refusal).toBeNull();
  });

  it('refuses a run while another run holds the network', async () => {
    await seedAccount(5);
    expect(await acquireNetworkLock(CHAIN_ID, 'other-run', 'instance-z', TICK)).toBe(true);

    const blocked = await runStakingSync(request({ trigger: 'manual' }));

    expect(blocked.executed).toBe(false);
    expect(blocked.refusal).toBe('overlap_held');
    const account = await CardanoStakingAccount.findOne({}).lean();
    expect(account?.lastSyncAt).toBeNull();
  });

  it('takes the network over once the other run stopped renewing', async () => {
    const stale = new Date(TICK.getTime() - 60 * 60 * 1000);
    await acquireNetworkLock(CHAIN_ID, 'dead-run', 'instance-z', stale);

    const result = await runStakingSync(request());

    expect(result.executed).toBe(true);
  });

  it('lets exactly one of a scheduled and a manual run work at the same time', async () => {
    await seedAccount(6);
    await seedAccount(7);

    const [scheduled, manual] = await Promise.all([
      runStakingSync(request({ owner: 'instance-a' })),
      runStakingSync(request({ owner: 'instance-b', trigger: 'manual' }))
    ]);

    const executed = [scheduled, manual].filter((run) => run.executed);
    expect(executed).toHaveLength(1);
    const refused = [scheduled, manual].find((run) => !run.executed);
    expect(refused?.refusal).toBe('overlap_held');
  });

  it('releases the network when it finishes', async () => {
    await runStakingSync(request());

    expect(await CardanoStakingSyncLock.countDocuments({})).toBe(0);
  });

  it('keeps the lease-held answer for a second delivery of a tick that is still running', async () => {
    await CardanoStakingSyncRun.create({
      _id: syncRunId(CHAIN_ID, JOB, TICK),
      chainId: CHAIN_ID,
      scheduledTime: TICK,
      startedAt: TICK,
      lease: { owner: 'instance-b', expiresAt: new Date(TICK.getTime() + 600_000) },
      status: 'running'
    });

    const result = await runStakingSync(request());

    expect(result.executed).toBe(false);
    expect(result.refusal).toBe('lease_held');
    // The network lock this call took is given back, so the owner of the lease is not blocked.
    expect(await CardanoStakingSyncLock.countDocuments({})).toBe(0);
  });
});

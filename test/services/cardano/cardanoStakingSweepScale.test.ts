import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import type { CardanoStakingConfig } from '../../../src/config/cardanoStakingConfig';
import CardanoStakingAccount from '../../../src/models/cardanoStakingAccountModel';
import CardanoStakingOperation from '../../../src/models/cardanoStakingOperationModel';
import CardanoStakingSyncLock from '../../../src/models/cardanoStakingSyncLockModel';
import CardanoStakingSyncRun from '../../../src/models/cardanoStakingSyncRunModel';
import { UserModel } from '../../../src/models/userModel';
import {
  rewardAddress,
  stakeCredentialHex
} from '../../../src/services/cardano/cardanoAddressService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import type { CardanoStakeAccountState } from '../../../src/services/cardano/cardanoStakingProviderService';
import { requestStakingRefresh } from '../../../src/services/cardano/cardanoStakingRefreshService';
import {
  runStakingSync,
  type StakingSyncProvider
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
const T0 = new Date('2026-07-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A moment after {@link T0}.
 *
 * @param ms - Offset.
 * @returns The date.
 */
function later(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

/** A fake chain: what each reward address holds, and every read counted by method. */
interface FakeChain {
  holdings: Map<string, bigint>;
  registered: Set<string>;
  calls: Record<string, number>;
}

/**
 * A chain on which nothing is registered and nothing is held.
 *
 * @returns The chain.
 */
function emptyChain(): FakeChain {
  return { holdings: new Map(), registered: new Set(), calls: {} };
}

/**
 * The sweep's provider over a fake chain.
 *
 * @param chain - The chain.
 * @returns The provider.
 */
function providerOver(chain: FakeChain): StakingSyncProvider {
  const hit = (method: string): void => {
    chain.calls[method] = (chain.calls[method] ?? 0) + 1;
  };
  return {
    tip: async () => {
      hit('tip');
      return { slot: 90_000_000, height: 3_000_000 };
    },
    utxosFor: async () => {
      hit('utxosFor');
      return [];
    },
    submit: async () => {
      throw new Error('the suite never submits');
    },
    statusOf: async () => {
      hit('statusOf');
      return { known: false, confirmations: 0 };
    },
    stakingProtocolParameters: async () => {
      hit('stakingProtocolParameters');
      return {
        minFeeA: 44,
        minFeeB: 155_381,
        coinsPerUtxoByte: 4_310n,
        maxTxSize: 16_384,
        stakeAddressDeposit: 2_000_000n,
        drepDeposit: 500_000_000n
      };
    },
    stakeAccount: async (reward: string): Promise<CardanoStakeAccountState> => {
      hit('stakeAccount');
      const registered = chain.registered.has(reward);
      return {
        registered,
        poolId: null,
        governanceDelegation: registered ? { kind: 'always_abstain' } : { kind: 'not_registered' },
        withdrawableRewardsLovelace: 0n,
        lifetimeRewardsLovelace: null,
        withdrawnLovelace: null,
        depositLovelace: null,
        controlledLovelace: chain.holdings.get(reward) ?? 0n
      };
    },
    rewardHistory: async () => {
      hit('rewardHistory');
      return { credits: [], completeness: 'complete' as const };
    },
    registrationHistory: async () => {
      hit('registrationHistory');
      return [];
    }
  };
}

/**
 * Total reads a fake chain served.
 *
 * @param chain - The chain.
 * @returns The count.
 */
function totalCalls(chain: FakeChain): number {
  return Object.values(chain.calls).reduce((sum, value) => sum + value, 0);
}

/**
 * Inserts `count` accounts in bulk, with no user behind them.
 *
 * @param count - How many.
 * @param prefix - Keeps batches apart.
 * @returns Their reward addresses.
 */
async function insertAccounts(count: number, prefix: string): Promise<string[]> {
  const rewards = Array.from({ length: count }, (_, index) => `stake_test_${prefix}_${index}`);
  await CardanoStakingAccount.insertMany(
    rewards.map((reward, index) => ({
      userId: new Types.ObjectId(),
      chainId: CHAIN_ID,
      walletAddress: `addr_test_${prefix}_${index}`,
      rewardAddress: reward,
      stakeCredentialHex: `${prefix}${String(index).padStart(10, '0')}`.padEnd(56, '0'),
      state: 'awaiting_funds'
    })),
    { ordered: false }
  );
  return rewards;
}

/**
 * A user with a derivable wallet and its account, so the full decision can run.
 *
 * @param phoneNumber - Whose.
 * @returns The account id and its reward address.
 */
async function seedSignableAccount(
  phoneNumber: string
): Promise<{ accountId: Types.ObjectId; reward: string }> {
  const derived = cardanoSignerService.getAccount(phoneNumber, 'testnet', CHAIN_ID);
  const user = await UserModel.create({
    phone_number: phoneNumber,
    name: `user-${phoneNumber}`,
    wallets: [],
    settings: {}
  });
  const reward = rewardAddress(derived.stakePublicKey, 'testnet');
  const account = await CardanoStakingAccount.create({
    userId: user._id,
    chainId: CHAIN_ID,
    walletAddress: derived.address,
    rewardAddress: reward,
    stakeCredentialHex: stakeCredentialHex(derived.stakePublicKey),
    state: 'awaiting_funds'
  });
  return { accountId: account._id as Types.ObjectId, reward };
}

/**
 * One sweep.
 *
 * @param chain - The chain.
 * @param now - The clock.
 * @param overrides - Batch limit and configuration.
 * @returns The result.
 */
function sweep(
  chain: FakeChain,
  now: Date,
  overrides: { batchLimit?: number; config?: Partial<CardanoStakingConfig>; owner?: string } = {}
) {
  return runStakingSync({
    chainId: CHAIN_ID,
    jobName: 'scale',
    scheduledTime: now,
    owner: overrides.owner ?? 'instance-a',
    batchLimit: overrides.batchLimit ?? 500,
    provider: providerOver(chain),
    execute: false,
    now,
    config: stakingConfigFixture({ maxProviderRequestsPerRun: 100_000, ...overrides.config })
  });
}

beforeEach(async () => {
  enableCardanoPreprod();
  setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: 'test-sponsor' });
  await CardanoStakingAccount.deleteMany({});
  await CardanoStakingOperation.deleteMany({});
  await CardanoStakingSyncRun.deleteMany({});
  await CardanoStakingSyncLock.deleteMany({});
  await UserModel.deleteMany({});
});

describe('the sweep over 10,000 wallets', () => {
  it('checks every wallet once per cycle, empty ones with one request each', async () => {
    const chain = emptyChain();
    const empty = await insertAccounts(9_700, 'e');
    const funded = await insertAccounts(300, 'f');
    for (const reward of funded) chain.holdings.set(reward, 50_000_000n);

    const runs: Awaited<ReturnType<typeof sweep>>[] = [];
    for (let run = 0; run < 10; run += 1) {
      const result = await sweep(chain, later(run * HOUR), { batchLimit: 2_000 });
      runs.push(result);
      if (result.status === 'completed') break;
    }

    // Five hourly runs of 2,000 cover the universe, and the last one says so.
    expect(runs).toHaveLength(5);
    expect(runs.at(-1)?.backlogCount).toBe(0);
    expect(runs.slice(0, -1).every((run) => run.stopReason === 'batch_limit')).toBe(true);
    expect(await CardanoStakingAccount.countDocuments({ lastSyncAt: null })).toBe(0);

    // One stake-account read per wallet. The funded ones are not registered and have no user in
    // this fixture, so they stop after the read too; the full decision is measured separately.
    expect(chain.calls.stakeAccount).toBe(10_000);
    expect(chain.calls.rewardHistory ?? 0).toBe(300);
    expect(chain.calls.utxosFor ?? 0).toBe(0);
    expect(totalCalls(chain)).toBe(10_300);

    // Empty wallets come back in a day, funded ones in hours.
    const emptySample = await CardanoStakingAccount.findOne({ rewardAddress: empty[0] }).lean();
    const fundedSample = await CardanoStakingAccount.findOne({ rewardAddress: funded[0] }).lean();
    expect(emptySample?.lastKnownBalanceLovelace).toBe('0');
    expect(fundedSample?.lastKnownBalanceLovelace).toBe('50000000');
    const emptyGap =
      (emptySample?.nextEligibleCheckAt?.getTime() ?? 0) -
      (emptySample?.lastSyncAt?.getTime() ?? 0);
    const fundedGap =
      (fundedSample?.nextEligibleCheckAt?.getTime() ?? 0) -
      (fundedSample?.lastSyncAt?.getTime() ?? 0);
    expect(emptyGap).toBe(DAY);
    expect(fundedGap).toBe(6 * HOUR);
  }, 600_000);

  it('reads nothing a second time inside the cadence, and the funded ones first when due', async () => {
    const chain = emptyChain();
    await insertAccounts(900, 'e');
    const funded = await insertAccounts(100, 'f');
    for (const reward of funded) chain.holdings.set(reward, 50_000_000n);

    await sweep(chain, T0, { batchLimit: 1_000 });
    const firstPass = totalCalls(chain);

    const quiet = await sweep(chain, later(HOUR), { batchLimit: 1_000 });
    expect(quiet.accountsScanned).toBe(0);
    expect(totalCalls(chain)).toBe(firstPass);

    const sixHours = await sweep(chain, later(6 * HOUR + 1), { batchLimit: 1_000 });
    expect(sixHours.accountsScanned).toBe(100);
  }, 120_000);

  it('picks up wallets added while the universe is being swept, ahead of rechecks', async () => {
    const chain = emptyChain();
    await insertAccounts(300, 'a');
    // Part way through the first cycle, new wallets arrive.
    await sweep(chain, T0, { batchLimit: 100 });
    await insertAccounts(50, 'late');
    await sweep(chain, later(HOUR), { batchLimit: 250 });

    // Every wallet, old and new, was reached within the cycle.
    expect(await CardanoStakingAccount.countDocuments({ lastSyncAt: null })).toBe(0);

    // A day later everything is due again, and a wallet created then is read before the rechecks.
    await insertAccounts(10, 'newer');
    const next = await sweep(chain, later(DAY + 2 * HOUR), { batchLimit: 10 });

    const newer = await CardanoStakingAccount.countDocuments({
      rewardAddress: /^stake_test_newer_/,
      lastSyncAt: { $ne: null }
    });
    expect(newer).toBe(10);
    expect(next.accountsScanned).toBe(10);
  }, 120_000);

  it('resumes after an interrupted batch without re-reading what it finished', async () => {
    const chain = emptyChain();
    await insertAccounts(30, 'r');

    const first = await sweep(chain, T0, { batchLimit: 12 });
    expect(first.status).toBe('partial');
    expect(chain.calls.stakeAccount).toBe(12);

    // A redelivery of the same tick on another instance, as after a container was replaced.
    const retry = await sweep(chain, T0, { batchLimit: 100, owner: 'instance-b' });

    expect(retry.executed).toBe(true);
    expect(retry.status).toBe('completed');
    expect(chain.calls.stakeAccount).toBe(30);
  });

  it('reports the backlog and how long its oldest wallet has waited', async () => {
    const chain = emptyChain();
    await insertAccounts(50, 'b');
    await sweep(chain, T0, { batchLimit: 50 });

    const nextDay = await sweep(chain, later(DAY + HOUR), { batchLimit: 20 });

    expect(nextDay.status).toBe('partial');
    expect(nextDay.backlogCount).toBe(30);
    const run = await CardanoStakingSyncRun.findById(nextDay.runId).lean();
    expect(run?.backlogOldestAt?.getTime()).toBe(later(DAY).getTime());
  });
});

describe('a deposit from outside ChatterPay', () => {
  it('is discovered on the next check of an empty wallet, which then decides to enrol it', async () => {
    const chain = emptyChain();
    const { accountId, reward } = await seedSignableAccount('5491100088001');

    const before = await sweep(chain, T0);
    expect(before.refusals.empty_wallet).toBe(1);

    // Somebody outside ChatterPay sends ada. Nothing in this backend saw it happen.
    chain.holdings.set(reward, 50_000_000n);
    const within = await sweep(chain, later(HOUR));
    expect(within.accountsScanned).toBe(0);

    const next = await sweep(chain, later(DAY + 1));

    expect(next.accountsScanned).toBe(1);
    expect(next.refusals.empty_wallet ?? 0).toBe(0);
    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.lastKnownBalanceLovelace).toBe('50000000');
    // The full decision ran: parameters and outputs were read for this wallet and no other.
    expect(chain.calls.stakingProtocolParameters).toBe(1);
    expect(chain.calls.utxosFor).toBe(1);
  });

  it('does not enrol a wallet that holds 0 ada', async () => {
    const chain = emptyChain();
    await seedSignableAccount('5491100088002');

    const result = await sweep(chain, T0);

    expect(result.refusals.empty_wallet).toBe(1);
    expect(Object.keys(result.refusals).some((key) => key.startsWith('would_'))).toBe(false);
    expect(chain.calls.stakingProtocolParameters ?? 0).toBe(0);
  });

  it('leaves an opt-out exactly where it was when ada arrives', async () => {
    const chain = emptyChain();
    const { accountId, reward } = await seedSignableAccount('5491100088003');
    const optOut = { at: T0, reason: 'user_request', source: 'dashboard', preferenceVersion: 1 };
    await CardanoStakingAccount.updateOne({ _id: accountId }, { $set: { optOut } });
    chain.holdings.set(reward, 80_000_000n);
    await requestStakingRefresh({ accountIds: [accountId] }, 'transfer_in', T0);

    const result = await sweep(chain, T0);

    expect(result.refusals.opted_out).toBe(1);
    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.optOut).toMatchObject({ reason: 'user_request', source: 'dashboard' });
    expect(stored?.preference.enabled).toBe(false);
  });
});

describe('a refresh this backend asked for', () => {
  it('brings the wallet forward, and survives a read that ran before the transfer could land', async () => {
    const chain = emptyChain();
    const [reward] = await insertAccounts(1, 't');
    await sweep(chain, T0);
    const account = await CardanoStakingAccount.findOne({ rewardAddress: reward }).lean();
    const accountId = account?._id as Types.ObjectId;

    // A transfer in, readable from ten minutes on.
    await requestStakingRefresh(
      { accountIds: [accountId] },
      'transfer_in',
      later(HOUR),
      10 * 60_000
    );
    // Another signal makes it due right now; the read it triggers comes too early for the transfer.
    await requestStakingRefresh({ accountIds: [accountId] }, 'operation_settled', later(HOUR));
    await sweep(chain, later(HOUR + 60_000));

    const early = await CardanoStakingAccount.findById(accountId).lean();
    expect(early?.refreshRequestedAt?.getTime()).toBe(later(HOUR + 10 * 60_000).getTime());
    expect(early?.nextEligibleCheckAt?.getTime()).toBe(later(HOUR + 10 * 60_000).getTime());

    chain.holdings.set(reward as string, 7_000_000n);
    await sweep(chain, later(HOUR + 10 * 60_000));

    const settled = await CardanoStakingAccount.findById(accountId).lean();
    expect(settled?.lastKnownBalanceLovelace).toBe('7000000');
    expect(settled?.refreshRequestedAt).toBeNull();
  });

  it('never touches consent or opt-out', async () => {
    const [reward] = await insertAccounts(1, 'c');
    const account = await CardanoStakingAccount.findOne({ rewardAddress: reward }).lean();
    const optOut = { at: T0, reason: 'user_exit', source: 'dashboard', preferenceVersion: 3 };
    await CardanoStakingAccount.updateOne({ _id: account?._id }, { $set: { optOut } });

    await requestStakingRefresh(
      { chainId: CHAIN_ID, walletAddresses: [account?.walletAddress as string] },
      'transfer_in',
      T0
    );

    const stored = await CardanoStakingAccount.findById(account?._id).lean();
    expect(stored?.optOut).toMatchObject({ reason: 'user_exit', preferenceVersion: 3 });
    expect(stored?.preference.enabled).toBe(false);
    expect(stored?.refreshReason).toBe('transfer_in');
  });
});

import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import CardanoProviderQuota from '../../../src/models/cardanoProviderQuotaModel';
import CardanoStakingAccount from '../../../src/models/cardanoStakingAccountModel';
import CardanoStakingSyncLock from '../../../src/models/cardanoStakingSyncLockModel';
import CardanoStakingSyncRun from '../../../src/models/cardanoStakingSyncRunModel';
import { UserModel } from '../../../src/models/userModel';
import {
  createMongoProviderMeter,
  DEFAULT_PROVIDER_QUOTA_LIMITS,
  type ProviderQuotaLimits,
  providerFamily,
  quotaScope,
  quotaWindow
} from '../../../src/services/cardano/cardanoProviderQuotaService';
import {
  BlockfrostProvider,
  CardanoProviderQuotaError,
  setCardanoProviderMeter,
  withCardanoProviderContext
} from '../../../src/services/cardano/cardanoProviderService';
import { BlockfrostStakingProvider } from '../../../src/services/cardano/cardanoStakingProviderService';
import {
  runStakingSync,
  type StakingSyncProvider
} from '../../../src/services/cardano/cardanoStakingSyncService';
import { stakingConfigFixture } from '../../helpers/stakingConfigFixture';
import { enableCardanoPreprod } from '../../support/cardanoEnv';

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

const ROOT = 'https://cardano-preprod.blockfrost.io/api/v0';
const KEY = 'preprodSECRETKEYVALUE0123456789';
const T0 = new Date('2026-06-10T12:00:00.000Z');

/** Requests the fake provider received, by path. */
let received: string[] = [];

/** Status and headers the fake answers every request with, when set. */
let forced: { status: number; headers?: Record<string, string> } | null = null;

/**
 * A JSON answer.
 *
 * @param body - The body.
 * @param status - The status.
 * @returns The response.
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/**
 * The fake Blockfrost: an empty chain whose UTxO paging is scripted per address.
 *
 * @param input - The request URL.
 * @returns The answer.
 */
async function fakeBlockfrost(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  const path = url.pathname.replace('/api/v0', '');
  received.push(`${path}${url.search}`);
  if (forced !== null) {
    return new Response('{"error":"forced"}', {
      status: forced.status,
      headers: forced.headers ?? {}
    });
  }
  if (path === '/blocks/latest') return json({ slot: 90_000_000, height: 3_000_000 });
  if (path.startsWith('/txs/')) return json({ block_height: 2_999_998 });
  if (path.startsWith('/accounts/')) return json({ error: 'Not Found' }, 404);
  if (path.startsWith('/addresses/') && path.endsWith('/utxos')) {
    const page = Number(url.searchParams.get('page'));
    // Two full pages and a short one: three requests for one logical read.
    const size = page <= 2 ? 100 : 5;
    return json(
      Array.from({ length: size }, (_, index) => ({
        tx_hash: `${'a'.repeat(62)}${String(page).padStart(2, '0')}`,
        output_index: index,
        amount: [{ unit: 'lovelace', quantity: '1000000' }],
        block: 'b'.repeat(64)
      }))
    );
  }
  return json({ error: 'Not Found' }, 404);
}

/**
 * A meter with fixed limits and a controllable clock.
 *
 * @param limits - What differs from the defaults.
 * @param clock - The clock.
 * @returns The meter.
 */
function meterWith(limits: Partial<ProviderQuotaLimits>, clock: { now: Date }) {
  return createMongoProviderMeter({
    limits: async () => ({ ...DEFAULT_PROVIDER_QUOTA_LIMITS, ...limits }),
    now: () => clock.now
  });
}

/**
 * Today's quota document for the test credential.
 *
 * @param now - Which day.
 * @returns The document.
 */
async function usage(now: Date = T0) {
  return CardanoProviderQuota.findById(`${quotaScope(ROOT, KEY)}|${quotaWindow(now, 0)}`).lean();
}

/**
 * A reservation of one request, as the provider would make it.
 *
 * @param priority - Its priority.
 * @returns The metadata.
 */
function meta(priority: 'critical' | 'interactive' | 'pending' | 'background') {
  return {
    baseUrl: ROOT,
    credential: KEY,
    path: '/blocks/latest',
    method: 'GET',
    priority,
    origin: 'test'
  };
}

beforeEach(async () => {
  enableCardanoPreprod();
  received = [];
  forced = null;
  vi.stubGlobal('fetch', vi.fn(fakeBlockfrost));
  await CardanoProviderQuota.deleteMany({});
  await CardanoStakingAccount.deleteMany({});
  await CardanoStakingSyncRun.deleteMany({});
  await CardanoStakingSyncLock.deleteMany({});
  await UserModel.deleteMany({});
});

afterEach(() => {
  setCardanoProviderMeter(null);
  vi.unstubAllGlobals();
});

describe('what the meter counts', () => {
  it('counts every page of a paged read, not the logical read once', async () => {
    const clock = { now: T0 };
    setCardanoProviderMeter(meterWith({}, clock));

    await new BlockfrostProvider(ROOT, 5_000, KEY).utxosFor('addr_test1qqexample');

    expect(received).toHaveLength(3);
    const stored = await usage();
    expect(stored?.total).toBe(3);
    expect(stored?.byFamily).toEqual({ 'addresses:utxos': 3 });
  });

  it('counts the tip a transaction lookup reads for itself', async () => {
    const clock = { now: T0 };
    setCardanoProviderMeter(meterWith({}, clock));

    await new BlockfrostProvider(ROOT, 5_000, KEY).statusOf('c'.repeat(64));

    expect((await usage())?.total).toBe(2);
  });

  it('attributes requests to the flow that caused them', async () => {
    const clock = { now: T0 };
    setCardanoProviderMeter(meterWith({}, clock));
    const provider = new BlockfrostProvider(ROOT, 5_000, KEY);

    await provider.tip();
    await withCardanoProviderContext({ priority: 'background', origin: 'sync.refresh' }, () =>
      provider.tip()
    );

    const stored = await usage();
    expect(stored?.byPriority).toEqual({ interactive: 1, background: 1 });
    expect(stored?.byOrigin).toEqual({ unattributed: 1, sync_refresh: 1 });
  });

  it('keeps addresses, hashes and keys out of the counter', async () => {
    const clock = { now: T0 };
    setCardanoProviderMeter(meterWith({}, clock));

    await new BlockfrostStakingProvider(ROOT, 5_000, KEY).stakeAccount('stake_test1uexample0');

    const stored = await usage();
    const text = JSON.stringify(stored);
    expect(text).not.toContain('stake_test1');
    expect(text).not.toContain(KEY);
    expect(stored?.byFamily).toEqual({ accounts: 1 });
    expect(providerFamily('/txs/abc123/utxos')).toBe('txs:utxos');
  });
});

describe('the shared daily limit', () => {
  it('lets exactly the shared allowance through when two instances race', async () => {
    const clock = { now: T0 };
    // Two meters stand for two Cloud Run instances: nothing is shared between them but Mongo.
    const first = meterWith({ dailyLimit: 10, criticalReserve: 2 }, clock);
    const second = meterWith({ dailyLimit: 10, criticalReserve: 2 }, clock);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).reserve(meta('interactive'))
      )
    );

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(8);
    expect((await usage())?.total).toBe(8);
  });

  it('refuses background work at its own share while interactive reads continue', async () => {
    const clock = { now: T0 };
    const meter = meterWith(
      { dailyLimit: 100, backgroundDailyLimit: 3, criticalReserve: 5 },
      clock
    );

    for (let index = 0; index < 3; index += 1) await meter.reserve(meta('background'));
    await expect(meter.reserve(meta('background'))).rejects.toBeInstanceOf(
      CardanoProviderQuotaError
    );
    await expect(meter.reserve(meta('interactive'))).resolves.toBeUndefined();

    const stored = await usage();
    expect(stored?.refused).toEqual({ background: 1 });
  });

  it('refuses nothing under concurrency while the limit is far away', async () => {
    // Concurrent writers used to collide on the document's `_id`, and the collision was read as a
    // spent quota: most requests of a busy first minute were refused with the quota nearly empty.
    const clock = { now: T0 };
    for (const priority of ['interactive', 'background', 'critical'] as const) {
      for (let round = 0; round < 5; round += 1) {
        await CardanoProviderQuota.deleteMany({});
        const meter = meterWith({}, clock);

        const outcomes = await Promise.allSettled(
          Array.from({ length: 10 }, () => meter.reserve(meta(priority)))
        );

        expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(0);
        expect((await usage())?.total).toBe(10);
      }
    }
  });

  it('keeps the reserve for submissions', async () => {
    const clock = { now: T0 };
    const meter = meterWith({ dailyLimit: 3, criticalReserve: 1 }, clock);

    await meter.reserve(meta('interactive'));
    await meter.reserve(meta('pending'));
    await expect(meter.reserve(meta('interactive'))).rejects.toBeInstanceOf(
      CardanoProviderQuotaError
    );
    await expect(meter.reserve(meta('critical'))).resolves.toBeUndefined();
    // A submission is never refused here, even past the limit: the provider enforces its own.
    await expect(meter.reserve(meta('critical'))).resolves.toBeUndefined();
  });

  it('starts a new count when the quota day rolls over', async () => {
    const clock = { now: new Date('2026-06-10T23:59:59.000Z') };
    const meter = meterWith({ dailyLimit: 2, criticalReserve: 0 }, clock);

    await meter.reserve(meta('interactive'));
    await meter.reserve(meta('interactive'));
    await expect(meter.reserve(meta('interactive'))).rejects.toBeInstanceOf(
      CardanoProviderQuotaError
    );

    clock.now = new Date('2026-06-11T00:00:01.000Z');
    await expect(meter.reserve(meta('interactive'))).resolves.toBeUndefined();
  });

  it('places the day boundary where the configured offset says', () => {
    const late = new Date('2026-06-11T02:00:00.000Z');

    expect(quotaWindow(late, 0)).toBe('2026-06-11');
    expect(quotaWindow(late, 180)).toBe('2026-06-10');
  });

  it('pauses background work for as long as a 429 says, and not interactive work', async () => {
    const clock = { now: T0 };
    setCardanoProviderMeter(meterWith({}, clock));
    forced = { status: 429, headers: { 'retry-after': '120' } };

    await expect(new BlockfrostProvider(ROOT, 5_000, KEY).tip()).rejects.toMatchObject({
      failure: 'rate_limited'
    });

    forced = null;
    const meter = meterWith({}, clock);
    await expect(meter.reserve(meta('background'))).rejects.toBeInstanceOf(
      CardanoProviderQuotaError
    );
    await expect(meter.reserve(meta('interactive'))).resolves.toBeUndefined();

    clock.now = new Date(T0.getTime() + 121_000);
    await expect(meter.reserve(meta('background'))).resolves.toBeUndefined();
    expect((await usage())?.rateLimited).toBe(1);
  });
});

describe("a run's own ceiling", () => {
  it('refuses the request past the ceiling without sending it', async () => {
    const provider = new BlockfrostProvider(ROOT, 5_000, KEY);
    const runBudget = { limit: 2, used: 0 };

    const outcome = await withCardanoProviderContext(
      { priority: 'background', origin: 'sync.refresh', runBudget },
      async () => {
        await provider.tip();
        await provider.tip();
        return provider.tip().catch((error: unknown) => error);
      }
    );

    expect(outcome).toBeInstanceOf(CardanoProviderQuotaError);
    expect((outcome as CardanoProviderQuotaError).scope).toBe('run');
    expect(received).toHaveLength(2);
  });
});

describe('the sweep under a quota', () => {
  /**
   * Accounts the fake chain has never seen: each costs the sweep one request.
   *
   * @param count - How many.
   */
  async function seedEmptyAccounts(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const user = await UserModel.create({
        phone_number: `549110077${String(index).padStart(4, '0')}`,
        name: `quota-${index}`,
        wallets: [],
        settings: {}
      });
      await CardanoStakingAccount.create({
        userId: user._id,
        chainId: CARDANO_PREPROD_CHAIN_ID,
        walletAddress: `addr_test_quota_${index}`,
        rewardAddress: `stake_test_quota_${index}`,
        stakeCredentialHex: new Types.ObjectId().toHexString().padEnd(56, '0'),
        state: 'awaiting_funds'
      });
    }
  }

  /**
   * The sweep's provider, built from the real HTTP clients against the fake chain.
   *
   * @returns The provider.
   */
  function httpProvider(): StakingSyncProvider {
    const base = new BlockfrostProvider(ROOT, 5_000, KEY);
    const staking = new BlockfrostStakingProvider(ROOT, 5_000, KEY);
    return {
      tip: () => base.tip(),
      utxosFor: (address) => base.utxosFor(address),
      submit: (cbor) => base.submit(cbor),
      statusOf: (id) => base.statusOf(id),
      stakingProtocolParameters: () => staking.stakingProtocolParameters(),
      stakeAccount: (reward) => staking.stakeAccount(reward),
      rewardHistory: (reward) => staking.rewardHistory(reward),
      registrationHistory: (reward) => staking.registrationHistory(reward)
    };
  }

  /**
   * One sweep.
   *
   * @param maxProviderRequestsPerRun - The run's ceiling.
   * @param now - The clock.
   * @returns The result.
   */
  function sweep(maxProviderRequestsPerRun: number, now: Date) {
    return runStakingSync({
      chainId: CARDANO_PREPROD_CHAIN_ID,
      jobName: 'quota-test',
      scheduledTime: now,
      trigger: 'manual',
      owner: 'instance-a',
      batchLimit: 50,
      provider: httpProvider(),
      execute: false,
      now,
      config: stakingConfigFixture({ maxProviderRequestsPerRun })
    });
  }

  it('checks an empty wallet with one request', async () => {
    await seedEmptyAccounts(4);

    const result = await sweep(1000, T0);

    expect(result.status).toBe('completed');
    expect(result.providerRequests).toBe(4);
    expect(received.every((path) => path.startsWith('/accounts/'))).toBe(true);
  });

  it('stops at its own ceiling with a checkpoint, and the next run finishes the rest', async () => {
    await seedEmptyAccounts(5);

    const first = await sweep(3, T0);

    expect(first.status).toBe('partial');
    expect(first.stopReason).toBe('run_request_limit');
    expect(first.accountsScanned).toBe(3);
    expect(first.providerRequests).toBe(3);
    expect(first.backlogCount).toBe(2);

    const second = await sweep(3, new Date(T0.getTime() + 60_000));

    expect(second.status).toBe('completed');
    expect(second.accountsScanned).toBe(2);
    expect(await CardanoStakingAccount.countDocuments({ nextEligibleCheckAt: null })).toBe(0);
  });

  it('stops when the shared background share is spent, marking nothing it did not check', async () => {
    await seedEmptyAccounts(4);
    const clock = { now: T0 };
    setCardanoProviderMeter(meterWith({ backgroundDailyLimit: 2 }, clock));

    const result = await sweep(1000, T0);

    expect(result.status).toBe('partial');
    expect(result.stopReason).toBe('rate_limited');
    expect(result.accountsScanned).toBe(2);
    expect(await CardanoStakingAccount.countDocuments({ nextEligibleCheckAt: null })).toBe(2);
  });

  it('stops on a provider 429 instead of pressing on', async () => {
    await seedEmptyAccounts(3);
    forced = { status: 429 };

    const result = await sweep(1000, T0);

    expect(result.stopReason).toBe('rate_limited');
    expect(received).toHaveLength(1);
    expect(await CardanoStakingAccount.countDocuments({ nextEligibleCheckAt: null })).toBe(3);
  });

  it('stops when the plan says its daily limit is spent, and holds background work back', async () => {
    // Blockfrost answers 402 once the day's requests are used up, and bans a caller that keeps
    // sending after it. Read as a credential failure, the sweep used to spend one request per wallet.
    await seedEmptyAccounts(3);
    const clock = { now: new Date() };
    setCardanoProviderMeter(meterWith({}, clock));
    forced = { status: 402 };

    const result = await sweep(1000, T0);

    expect(result.stopReason).toBe('rate_limited');
    expect(received).toHaveLength(1);
    expect(await CardanoStakingAccount.countDocuments({ nextEligibleCheckAt: null })).toBe(3);
    const stored = await CardanoProviderQuota.findOne({}).lean();
    expect(stored?.backgroundPausedUntil?.getUTCHours()).toBe(0);
    expect(stored?.backgroundPausedUntil?.getUTCMinutes()).toBe(0);
  });
});

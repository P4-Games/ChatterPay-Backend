import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import type { CardanoStakingConfig } from '../../../src/config/cardanoStakingConfig';
import CardanoStakingAccount from '../../../src/models/cardanoStakingAccountModel';
import CardanoStakingSyncRun from '../../../src/models/cardanoStakingSyncRunModel';
import { UserModel } from '../../../src/models/userModel';
import {
  rewardAddress,
  stakeCredentialHex
} from '../../../src/services/cardano/cardanoAddressService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import type { CardanoStakeAccountState } from '../../../src/services/cardano/cardanoStakingProviderService';
import {
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
const POOL = 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx';
const TICK = new Date('2026-01-01T03:00:00.000Z');

/**
 * A staking configuration.
 *
 * @param overrides - What differs.
 * @returns The configuration.
 */
function config(overrides: Partial<CardanoStakingConfig> = {}): CardanoStakingConfig {
  return stakingConfigFixture({
    defaultPoolId: POOL,
    termsVersion: 'dev-v1',
    consentRequired: true,
    ...overrides
  });
}

/**
 * A stake account as the chain has it.
 *
 * @param overrides - What differs.
 * @returns The state.
 */
function chainState(overrides: Partial<CardanoStakeAccountState> = {}): CardanoStakeAccountState {
  return {
    registered: false,
    poolId: null,
    governanceDelegation: { kind: 'not_registered' },
    withdrawableRewardsLovelace: 0n,
    lifetimeRewardsLovelace: null,
    withdrawnLovelace: null,
    depositLovelace: null,
    ...overrides
  };
}

/**
 * A provider answering from fixed data.
 *
 * @param state - What the stake account read returns.
 * @returns The provider.
 */
function providerFor(state: CardanoStakeAccountState = chainState()): StakingSyncProvider {
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
    stakeAccount: async () => state,
    rewardHistory: async () => ({ credits: [], completeness: 'complete' as const }),
    registrationHistory: async () => []
  };
}

/**
 * Creates a user and its staking account, derived so the signer check passes.
 *
 * @param phoneNumber - Whose wallet it is.
 * @returns The account id.
 */
async function seedAccount(phoneNumber: string): Promise<Types.ObjectId> {
  const derived = cardanoSignerService.getAccount(phoneNumber, 'testnet', CHAIN_ID);
  const user = await UserModel.create({
    phone_number: phoneNumber,
    name: `user-${phoneNumber}`,
    wallets: [],
    settings: {}
  });

  const account = await CardanoStakingAccount.create({
    userId: user._id,
    chainId: CHAIN_ID,
    walletAddress: derived.address,
    rewardAddress: rewardAddress(derived.stakePublicKey, 'testnet'),
    stakeCredentialHex: stakeCredentialHex(derived.stakePublicKey),
    preference: { enabled: true, version: 1, updatedAt: new Date() },
    termsConsent: { version: 'dev-v1', acceptedAt: new Date(), source: 'web' },
    currentLifecycleId: `cycle-${phoneNumber}`,
    state: 'awaiting_funds'
  });

  return account._id as Types.ObjectId;
}

/**
 * A request with everything the suite holds constant.
 *
 * @param overrides - What differs.
 * @returns The request.
 */
function request(overrides: Record<string, unknown> = {}) {
  return {
    chainId: CHAIN_ID,
    jobName: JOB,
    scheduledTime: TICK,
    owner: 'instance-a',
    batchLimit: 50,
    provider: providerFor(),
    execute: false,
    config: config(),
    ...overrides
  } as Parameters<typeof runStakingSync>[0];
}

beforeEach(async () => {
  enableCardanoPreprod();
  setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: 'test-sponsor' });
  await CardanoStakingAccount.deleteMany({});
  await CardanoStakingSyncRun.deleteMany({});
  await UserModel.deleteMany({});
});

describe('syncRunId', () => {
  it('derives the same id for the same tick', () => {
    // The whole idempotency story rests on this: a redelivery carries the same scheduled time.
    expect(syncRunId(CHAIN_ID, JOB, TICK)).toBe(syncRunId(CHAIN_ID, JOB, new Date(TICK)));
  });

  it('separates networks, jobs and ticks', () => {
    const base = syncRunId(CHAIN_ID, JOB, TICK);

    expect(syncRunId(CHAIN_ID + 1, JOB, TICK)).not.toBe(base);
    expect(syncRunId(CHAIN_ID, 'other-job', TICK)).not.toBe(base);
    expect(syncRunId(CHAIN_ID, JOB, new Date('2026-01-02T03:00:00.000Z'))).not.toBe(base);
  });
});

describe('runStakingSync', () => {
  it('refuses to run while staking is disabled', async () => {
    const result = await runStakingSync(request({ config: config({ enabled: false }) }));

    expect(result.refusal).toBe('staking_disabled');
  });

  it('records a run for the tick it was asked for', async () => {
    const result = await runStakingSync(request());
    const stored = await CardanoStakingSyncRun.findById(result.runId).lean();

    expect(result.runId).toBe(syncRunId(CHAIN_ID, JOB, TICK));
    expect(stored?.status).toBe('completed');
    expect(stored?.phase).toBe('done');
  });

  it('releases the lease when it finishes', async () => {
    // Held to its expiry, a lease from a finished run would block the next delivery for no reason.
    const result = await runStakingSync(request());
    const stored = await CardanoStakingSyncRun.findById(result.runId).lean();

    expect(stored?.lease).toBeNull();
  });

  it('does nothing on a redelivery of a tick that already completed', async () => {
    await runStakingSync(request());
    const again = await runStakingSync(request({ owner: 'instance-b' }));

    expect(again.refusal).toBe('already_completed');
    expect(again.accountsScanned).toBe(0);
  });

  it('refuses while another instance holds an unexpired lease', async () => {
    await CardanoStakingSyncRun.create({
      _id: syncRunId(CHAIN_ID, JOB, TICK),
      chainId: CHAIN_ID,
      scheduledTime: TICK,
      startedAt: new Date(),
      lease: { owner: 'instance-b', expiresAt: new Date(Date.now() + 600_000) },
      status: 'running'
    });

    const result = await runStakingSync(request());

    expect(result.refusal).toBe('lease_held');
  });

  it('takes over a run whose owner died and whose lease lapsed', async () => {
    await CardanoStakingSyncRun.create({
      _id: syncRunId(CHAIN_ID, JOB, TICK),
      chainId: CHAIN_ID,
      scheduledTime: TICK,
      startedAt: new Date(Date.now() - 3_600_000),
      lease: { owner: 'instance-b', expiresAt: new Date(Date.now() - 60_000) },
      status: 'running'
    });

    const result = await runStakingSync(request());

    expect(result.refusal).toBeNull();
    expect(result.status).toBe('completed');
  });

  it('resumes its own run rather than fighting itself for it', async () => {
    await CardanoStakingSyncRun.create({
      _id: syncRunId(CHAIN_ID, JOB, TICK),
      chainId: CHAIN_ID,
      scheduledTime: TICK,
      startedAt: new Date(),
      lease: { owner: 'instance-a', expiresAt: new Date(Date.now() + 600_000) },
      status: 'partial'
    });

    const result = await runStakingSync(request({ owner: 'instance-a' }));

    expect(result.refusal).toBeNull();
  });

  it('observes every account it reaches', async () => {
    await seedAccount('5491100000001');
    await seedAccount('5491100000002');

    const result = await runStakingSync(request());

    expect(result.accountsScanned).toBe(2);
    expect(result.status).toBe('completed');
  });

  it('writes the snapshot it read', async () => {
    const accountId = await seedAccount('5491100000003');

    await runStakingSync(
      request({ provider: providerFor(chainState({ registered: true, poolId: POOL })) })
    );

    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.onChain.registered).toBe(true);
    expect(stored?.onChain.asOf).not.toBeNull();
    expect(stored?.lastSyncAt).not.toBeNull();
  });

  it('stops at the batch limit and reports the rest as backlog', async () => {
    await seedAccount('5491100000004');
    await seedAccount('5491100000005');
    await seedAccount('5491100000006');

    const result = await runStakingSync(request({ batchLimit: 2 }));

    expect(result.accountsScanned).toBe(2);
    expect(result.status).toBe('partial');
    expect(result.backlogCount).toBe(1);
  });

  it('keeps a cursor so the next pass continues instead of restarting', async () => {
    await seedAccount('5491100000007');
    await seedAccount('5491100000008');
    await seedAccount('5491100000009');

    const first = await runStakingSync(request({ batchLimit: 2 }));
    const stored = await CardanoStakingSyncRun.findById(first.runId).lean();
    expect(stored?.userCursor).not.toBeNull();

    // Same tick, same run: this is what a Cloud Scheduler retry looks like after a run that did not
    // finish, and it has to pick up the tail rather than the head.
    const second = await runStakingSync(request({ batchLimit: 2 }));
    expect(second.accountsScanned).toBe(1);
    expect(second.status).toBe('completed');
  });

  it('clears the cursor once it reaches the end', async () => {
    await seedAccount('5491100000010');

    const result = await runStakingSync(request());
    const stored = await CardanoStakingSyncRun.findById(result.runId).lean();

    expect(stored?.userCursor).toBeNull();
  });

  it('decides without acting while execution is off', async () => {
    await seedAccount('5491100000011');

    const result = await runStakingSync(request({ execute: false }));

    expect(result.actionsStarted).toBe(0);
    // The wallet holds nothing, so the sweep refuses on eligibility rather than proposing anything.
    expect(Object.keys(result.refusals).length).toBeGreaterThan(0);
  });

  it('counts why it did nothing, by reason', async () => {
    await seedAccount('5491100000012');

    const result = await runStakingSync(request());
    const total = Object.values(result.refusals).reduce((sum, count) => sum + count, 0);

    expect(total).toBe(1);
  });

  it('records the reason on the account when one wallet cannot be read', async () => {
    const accountId = await seedAccount('5491100000013');
    const failing: StakingSyncProvider = {
      ...providerFor(),
      stakeAccount: async () => {
        throw new Error('CARDANO_PROVIDER_UNAVAILABLE');
      }
    };

    const result = await runStakingSync(request({ provider: failing }));

    // Scanned, not skipped: the pass goes on, and the failure is on the account where the next pass
    // will see it.
    expect(result.accountsScanned).toBe(1);
    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.lastError).not.toBeNull();
  });

  it('leaves a snapshot alone when the read that would have replaced it failed', async () => {
    const accountId = await seedAccount('5491100000014');
    await runStakingSync(
      request({ provider: providerFor(chainState({ registered: true, poolId: POOL })) })
    );
    const before = await CardanoStakingAccount.findById(accountId).lean();

    const failing: StakingSyncProvider = {
      ...providerFor(),
      stakeAccount: async () => {
        throw new Error('CARDANO_PROVIDER_UNAVAILABLE');
      }
    };
    await runStakingSync(
      request({ provider: failing, scheduledTime: new Date('2026-01-02T03:00:00.000Z') })
    );

    const after = await CardanoStakingAccount.findById(accountId).lean();
    expect(after?.onChain.registered).toBe(before?.onChain.registered);
    expect(after?.onChain.asOf?.getTime()).toBe(before?.onChain.asOf?.getTime());
  });
});

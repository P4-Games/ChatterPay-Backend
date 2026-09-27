import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import type { CardanoStakingConfig } from '../../../src/config/cardanoStakingConfig';
import CardanoStakingAccount, {
  type ICardanoStakingAccount
} from '../../../src/models/cardanoStakingAccountModel';
import CardanoStakingOperation from '../../../src/models/cardanoStakingOperationModel';
import CardanoStakingSyncLock from '../../../src/models/cardanoStakingSyncLockModel';
import CardanoStakingSyncRun from '../../../src/models/cardanoStakingSyncRunModel';
import { UserModel } from '../../../src/models/userModel';
import {
  rewardAddress,
  stakeCredentialHex
} from '../../../src/services/cardano/cardanoAddressService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import {
  decideAutomaticAction,
  decideRequestedAction,
  type StakingDecisionContext
} from '../../../src/services/cardano/cardanoStakingPlanService';
import type {
  CardanoPoolState,
  CardanoStakeAccountState
} from '../../../src/services/cardano/cardanoStakingProviderService';
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
const NEW_POOL = 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx';
const OLD_POOL = 'pool190dapqls3y9dxuqtexmm80sppjha7e8rhu62xydgwn4jjj07pqm';
const USER_DREP = 'drep1ytcw6qzpqqclx2yd0zy64ztvlkkhnf6yrzza8whgnq4vz5gh89626';
const T0 = new Date('2026-08-01T00:00:00.000Z');

const PARAMETERS = {
  minFeeA: 44,
  minFeeB: 155_381,
  coinsPerUtxoByte: 4_310n,
  maxTxSize: 16_384,
  stakeAddressDeposit: 2_000_000n,
  drepDeposit: 500_000_000n
};

/**
 * A staking position already delegated somewhere.
 *
 * @param onChain - What differs on chain.
 * @param overrides - What differs on the account.
 * @returns The account.
 */
function position(
  onChain: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {}
): ICardanoStakingAccount {
  return {
    _id: new Types.ObjectId(),
    walletAddress: 'addr_test_position',
    preference: { enabled: true, version: 1, updatedAt: T0 },
    termsConsent: { version: 'v1', acceptedAt: T0, source: 'web' },
    optOut: null,
    onChain: {
      registered: true,
      poolId: OLD_POOL,
      governanceDelegation: { kind: 'always_abstain' },
      depositLovelace: '2000000',
      registrationOrigin: 'chatterpay',
      withdrawableRewardsLovelace: '0',
      pendingRewardsLovelace: '0',
      lifetimeRewardsLovelace: '0',
      historicalCompleteness: 'complete',
      asOf: T0,
      ...onChain
    },
    ...overrides
  } as unknown as ICardanoStakingAccount;
}

/**
 * The decision context, with the default pool moved to {@link NEW_POOL}.
 *
 * @param overrides - What differs.
 * @returns The context.
 */
function context(overrides: Partial<StakingDecisionContext> = {}): StakingDecisionContext {
  return {
    config: stakingConfigFixture({ defaultPoolId: NEW_POOL }),
    parameters: PARAMETERS,
    addressBytes: new Uint8Array(57),
    spendableLovelace: 10_000_000n,
    poolState: null,
    operationInFlight: false,
    signerAvailable: true,
    sponsoredRegistrationsInWindow: 0,
    ...overrides
  };
}

/**
 * A pool with a retirement on record.
 *
 * @param poolId - Which.
 * @returns Its state.
 */
function retiring(poolId: string): CardanoPoolState {
  return { poolId, retirementScheduled: true, retiringEpoch: 400, activeStakeLovelace: 0n };
}

describe('changing the default pool', () => {
  it('leaves a position on the old pool where it is', () => {
    // Editing `defaultPoolId` decides where new registrations go. It is not a migration.
    const decision = decideAutomaticAction(position(), context());

    expect(decision.action).toBe('none');
  });

  it('moves a position off a pool that is retiring, to the new default', () => {
    const decision = decideAutomaticAction(position(), context({ poolState: retiring(OLD_POOL) }));

    expect(decision.action).toBe('redelegate_pool');
  });

  it('does not move a wallet that opted out, even off a retiring pool', () => {
    const optedOut = position(
      {},
      { optOut: { at: T0, reason: 'user_request', source: 'web', preferenceVersion: 1 } }
    );

    const decision = decideAutomaticAction(optedOut, context({ poolState: retiring(OLD_POOL) }));

    expect(decision).toMatchObject({ action: 'none', refusal: 'opted_out' });
  });

  it('lets a user leave a pool that was removed from the list', () => {
    const config = stakingConfigFixture({
      defaultPoolId: NEW_POOL,
      allowlistedPools: [
        { poolId: NEW_POOL, enabled: true },
        { poolId: OLD_POOL, enabled: false }
      ]
    });

    const exit = decideRequestedAction(position(), 'exit_and_send_max', context({ config }));
    const deregister = decideRequestedAction(position(), 'deregister', context({ config }));

    expect(exit.refusal).toBeNull();
    expect(deregister.refusal).toBeNull();
  });
});

describe('a vote a user chose', () => {
  it('is never replaced by the automatic delegation', () => {
    const chosen = position({
      governanceDelegation: { kind: 'drep', idCip129: USER_DREP }
    });

    const decision = decideAutomaticAction(
      chosen,
      context({ config: stakingConfigFixture({ defaultGovernance: 'always_no_confidence' }) })
    );

    expect(decision.action).not.toBe('delegate_vote');
  });

  it('is not overtaken while the user delegation is still on its way', () => {
    const pending = position({ governanceDelegation: { kind: 'none' } });

    const decision = decideAutomaticAction(pending, context({ operationInFlight: true }));

    expect(decision.action).toBe('none');
  });

  it('gets the automatic delegation only when the chain says there is none', () => {
    const never = position({ governanceDelegation: { kind: 'none' } });

    expect(decideAutomaticAction(never, context()).action).toBe('delegate_vote');
  });
});

describe('the sweep and pool state', () => {
  /** Pool reads the fake served, by pool id. */
  let poolReads: Record<string, number>;

  /**
   * A chain on which every account is registered and delegates to {@link OLD_POOL}.
   *
   * @param pool - What the pool read answers.
   * @returns The provider.
   */
  function chain(
    pool: CardanoPoolState | null,
    vote: CardanoStakeAccountState['governanceDelegation'] = { kind: 'always_abstain' }
  ): StakingSyncProvider {
    return {
      tip: async () => ({ slot: 90_000_000, height: 3_000_000 }),
      utxosFor: async () => [],
      submit: async () => {
        throw new Error('the suite never submits');
      },
      statusOf: async () => ({ known: false, confirmations: 0 }),
      stakingProtocolParameters: async () => PARAMETERS,
      stakeAccount: async (): Promise<CardanoStakeAccountState> => ({
        registered: true,
        poolId: OLD_POOL,
        governanceDelegation: vote,
        withdrawableRewardsLovelace: 0n,
        lifetimeRewardsLovelace: 0n,
        withdrawnLovelace: null,
        depositLovelace: 2_000_000n,
        controlledLovelace: 20_000_000n
      }),
      rewardHistory: async () => ({ credits: [], completeness: 'complete' as const }),
      registrationHistory: async () => [],
      poolState: async (poolId: string) => {
        poolReads[poolId] = (poolReads[poolId] ?? 0) + 1;
        return pool;
      }
    };
  }

  /**
   * Accounts whose keys this deployment derives, so the decision runs in full.
   *
   * @param count - How many.
   */
  async function seedPositions(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const phone = `549110099${String(index).padStart(4, '0')}`;
      const derived = cardanoSignerService.getAccount(phone, 'testnet', CHAIN_ID);
      const user = await UserModel.create({
        phone_number: phone,
        name: `pool-${index}`,
        wallets: [],
        settings: {}
      });
      await CardanoStakingAccount.create({
        userId: user._id,
        chainId: CHAIN_ID,
        walletAddress: derived.address,
        rewardAddress: rewardAddress(derived.stakePublicKey, 'testnet'),
        stakeCredentialHex: stakeCredentialHex(derived.stakePublicKey),
        state: 'active',
        onChain: { registrationOrigin: 'chatterpay' }
      });
    }
  }

  /**
   * One sweep that decides without acting.
   *
   * @param provider - The chain.
   * @param config - What differs in the settings.
   * @returns The result.
   */
  function sweep(provider: StakingSyncProvider, config: Partial<CardanoStakingConfig>) {
    return runStakingSync({
      chainId: CHAIN_ID,
      jobName: 'pools',
      scheduledTime: T0,
      trigger: 'manual',
      owner: 'instance-a',
      batchLimit: 50,
      provider,
      execute: false,
      now: T0,
      config: stakingConfigFixture({ defaultPoolId: NEW_POOL, ...config })
    });
  }

  beforeEach(async () => {
    enableCardanoPreprod();
    setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: 'test-sponsor' });
    poolReads = {};
    await CardanoStakingAccount.deleteMany({});
    await CardanoStakingSyncRun.deleteMany({});
    await CardanoStakingSyncLock.deleteMany({});
    await CardanoStakingOperation.deleteMany({});
    await UserModel.deleteMany({});
  });

  it('spends nothing on pools while automatic re-delegation is off', async () => {
    await seedPositions(3);

    const result = await sweep(chain(retiring(OLD_POOL)), { autoRedelegateRetiredPools: false });

    expect(poolReads).toEqual({});
    expect(result.refusals.would_redelegate_pool ?? 0).toBe(0);
  });

  it('reads each pool once per run and moves every position off a retiring one', async () => {
    await seedPositions(3);

    const result = await sweep(chain(retiring(OLD_POOL)), { autoRedelegateRetiredPools: true });

    expect(poolReads).toEqual({ [OLD_POOL]: 1 });
    expect(result.refusals.would_redelegate_pool).toBe(3);
  });

  it('does not give the default vote to a credential whose owner asked for their own', async () => {
    await seedPositions(1);
    const account = await CardanoStakingAccount.findOne({}).lean();
    await CardanoStakingOperation.create({
      accountId: account?._id,
      chainId: CHAIN_ID,
      lifecycleId: 'cycle',
      kind: 'delegate_vote',
      actor: 'web',
      idempotencyKey: 'user-vote',
      status: 'expired_unconfirmed',
      chainOutcome: 'rejected',
      absenceProof: 'ttl_expired_and_absent',
      governanceTarget: 'drep',
      governanceDrepIdCip129: USER_DREP
    });

    const result = await sweep(chain(null, { kind: 'none' }), {});

    expect(result.refusals.would_delegate_vote ?? 0).toBe(0);
    expect(result.refusals.not_available).toBe(1);
  });

  it('gives the default vote when nobody chose one', async () => {
    await seedPositions(1);

    const result = await sweep(chain(null, { kind: 'none' }), {});

    expect(result.refusals.would_delegate_vote).toBe(1);
  });

  it('leaves positions on a healthy old pool after the default changed', async () => {
    await seedPositions(2);

    const result = await sweep(
      chain({
        poolId: OLD_POOL,
        retirementScheduled: false,
        retiringEpoch: null,
        activeStakeLovelace: 1n
      }),
      { autoRedelegateRetiredPools: true }
    );

    expect(result.refusals.would_redelegate_pool ?? 0).toBe(0);
  });
});

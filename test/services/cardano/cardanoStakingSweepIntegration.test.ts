import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import CardanoStakingAccount from '../../../src/models/cardanoStakingAccountModel';
import { STAKING_COLLECTIONS } from '../../../src/models/cardanoStakingCollections';
import CardanoStakingFeeBudget from '../../../src/models/cardanoStakingFeeBudgetModel';
import CardanoStakingOperation from '../../../src/models/cardanoStakingOperationModel';
import CardanoStakingSyncLock from '../../../src/models/cardanoStakingSyncLockModel';
import CardanoStakingSyncRun from '../../../src/models/cardanoStakingSyncRunModel';
import CardanoUtxoClaim from '../../../src/models/cardanoUtxoClaimModel';
import { UserModel } from '../../../src/models/userModel';
import { rewardAddress } from '../../../src/services/cardano/cardanoAddressService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import { resetStakingSchemaVerification } from '../../../src/services/cardano/cardanoStakingOperationService';
import type { CardanoStakeAccountState } from '../../../src/services/cardano/cardanoStakingProviderService';
import { stakingSponsorFor } from '../../../src/services/cardano/cardanoStakingSignerService';
import {
  runStakingSync,
  type StakingSyncProvider
} from '../../../src/services/cardano/cardanoStakingSyncService';
import type { CardanoUtxo } from '../../../src/types/cardanoType';
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
const T0 = new Date('2026-09-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/**
 * A moment after {@link T0}.
 *
 * @param ms - Offset.
 * @returns The date.
 */
function later(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

/** One wallet's chain, as the test moves it along. */
interface WalletChain {
  held: bigint;
  registered: boolean;
  submitted: string[];
  confirmations: number;
}

/**
 * The sweep's provider over one wallet and the sponsor.
 *
 * @param chain - The wallet's chain.
 * @param walletAddress - The wallet's base address.
 * @returns The provider.
 */
function providerOver(chain: WalletChain, walletAddress: string): StakingSyncProvider {
  const sponsor = stakingSponsorFor();
  const output = (lovelace: bigint, index: number): CardanoUtxo => ({
    txHash: `${index}`.repeat(64).slice(0, 64),
    outputIndex: index,
    lovelace,
    holdsOtherAssets: false
  });
  return {
    tip: async () => ({ slot: 90_000_000, height: 3_000_000 }),
    utxosFor: async (address: string) => {
      if (sponsor.available && address === sponsor.account.address) {
        return [output(100_000_000n, 1)];
      }
      return address === walletAddress && chain.held > 0n ? [output(chain.held, 2)] : [];
    },
    submit: async (cbor: string) => {
      chain.submitted.push(cbor);
      return 'submitted';
    },
    statusOf: async () =>
      chain.confirmations > 0
        ? { known: true, confirmations: chain.confirmations }
        : { known: false, confirmations: 0 },
    stakingProtocolParameters: async () => ({
      minFeeA: 44,
      minFeeB: 155_381,
      coinsPerUtxoByte: 4_310n,
      maxTxSize: 16_384,
      stakeAddressDeposit: 2_000_000n,
      drepDeposit: 500_000_000n
    }),
    stakeAccount: async (): Promise<CardanoStakeAccountState> => ({
      registered: chain.registered,
      poolId: null,
      governanceDelegation: chain.registered
        ? { kind: 'always_abstain' }
        : { kind: 'not_registered' },
      withdrawableRewardsLovelace: 0n,
      lifetimeRewardsLovelace: null,
      withdrawnLovelace: null,
      depositLovelace: null,
      controlledLovelace: chain.held
    }),
    rewardHistory: async () => ({ credits: [], completeness: 'complete' as const }),
    registrationHistory: async () => []
  };
}

/**
 * A user with a Cardano wallet and no staking account yet, as before this feature existed.
 *
 * @param phoneNumber - Whose.
 * @returns The wallet's base address and the user id.
 */
async function seedWallet(phoneNumber: string) {
  const derived = cardanoSignerService.getAccount(phoneNumber, 'testnet', CHAIN_ID);
  const user = await UserModel.create({
    phone_number: phoneNumber,
    name: `user-${phoneNumber}`,
    wallets: [
      {
        wallet_proxy: derived.address,
        wallet_eoa: derived.address,
        created_with_chatterpay_proxy_address: '',
        created_with_factory_address: '',
        chain_id: CHAIN_ID,
        status: 'active',
        address_type: 'cardano_base',
        cardano_public_key: derived.publicKey,
        cardano_stake_public_key: derived.stakePublicKey
      }
    ],
    settings: {}
  });
  return {
    address: derived.address,
    reward: rewardAddress(derived.stakePublicKey, 'testnet'),
    userId: user._id
  };
}

/**
 * One executing sweep.
 *
 * @param provider - The chain.
 * @param now - The clock.
 * @returns The result.
 */
function sweep(provider: StakingSyncProvider, now: Date) {
  return runStakingSync({
    chainId: CHAIN_ID,
    jobName: 'integration',
    scheduledTime: now,
    owner: 'instance-a',
    batchLimit: 50,
    provider,
    execute: true,
    now,
    config: stakingConfigFixture()
  });
}

beforeEach(async () => {
  enableCardanoPreprod();
  setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: 'test-sponsor' });
  for (const { model } of STAKING_COLLECTIONS) await model.createIndexes();
  resetStakingSchemaVerification();
  await CardanoStakingAccount.deleteMany({});
  await CardanoStakingOperation.deleteMany({});
  await CardanoStakingFeeBudget.deleteMany({});
  await CardanoStakingSyncRun.deleteMany({});
  await CardanoStakingSyncLock.deleteMany({});
  await CardanoUtxoClaim.deleteMany({});
  await UserModel.deleteMany({});
});

describe('a deposit from outside, end to end', () => {
  it('is discovered, enrolled, and settled by the sweep alone', async () => {
    const wallet = await seedWallet('5491100066001');
    const chain: WalletChain = { held: 0n, registered: false, submitted: [], confirmations: 0 };
    const provider = providerOver(chain, wallet.address);

    // Day one: the wallet gets an account and holds nothing. Nothing is built.
    const first = await sweep(provider, T0);
    expect(first.accountsCreated).toBe(1);
    expect(first.refusals.empty_wallet).toBe(1);
    expect(chain.submitted).toHaveLength(0);

    // Ada arrives from outside ChatterPay. Nothing in this backend was told.
    chain.held = 20_000_000n;

    const second = await sweep(provider, later(DAY + 1));
    expect(second.actionsStarted).toBe(1);
    expect(chain.submitted).toHaveLength(1);
    const operation = await CardanoStakingOperation.findOne({
      kind: 'register_and_delegate'
    }).lean();
    expect(operation?.status).toBe('submitted');
    expect(operation?.actor).toBe('cron');

    // Two confirmations are not enough.
    chain.confirmations = 2;
    await sweep(provider, later(DAY + 2 * 60_000));
    expect((await CardanoStakingOperation.findById(operation?._id).lean())?.status).toBe(
      'submitted'
    );

    chain.confirmations = 3;
    await sweep(provider, later(DAY + 4 * 60_000));
    const settled = await CardanoStakingOperation.findById(operation?._id).lean();
    expect(settled?.status).toBe('confirmed');
    // Marked for a full read when it confirmed, and read again by the same run.
    const account = await CardanoStakingAccount.findOne({ userId: wallet.userId }).lean();
    expect(account?.lastSyncAt?.getTime()).toBe(later(DAY + 4 * 60_000).getTime());
    expect(account?.refreshRequestedAt).toBeNull();
  });

  it('builds nothing for a wallet that opted out, however much arrives', async () => {
    const wallet = await seedWallet('5491100066002');
    const chain: WalletChain = { held: 0n, registered: false, submitted: [], confirmations: 0 };
    const provider = providerOver(chain, wallet.address);
    await sweep(provider, T0);
    const optOut = { at: T0, reason: 'user_request', source: 'dashboard', preferenceVersion: 1 };
    await CardanoStakingAccount.updateOne({ userId: wallet.userId }, { $set: { optOut } });

    chain.held = 500_000_000n;
    const result = await sweep(provider, later(DAY + 1));

    expect(result.actionsStarted).toBe(0);
    expect(result.refusals.opted_out).toBe(1);
    expect(chain.submitted).toHaveLength(0);
    expect(await CardanoStakingOperation.countDocuments({})).toBe(0);
    const account = await CardanoStakingAccount.findOne({ userId: wallet.userId }).lean();
    expect(account?.optOut).toMatchObject({ reason: 'user_request' });
  });

  it('does not build a second transaction when the tick is redelivered', async () => {
    const wallet = await seedWallet('5491100066003');
    const chain: WalletChain = {
      held: 20_000_000n,
      registered: false,
      submitted: [],
      confirmations: 0
    };
    const provider = providerOver(chain, wallet.address);

    const first = await sweep(provider, T0);
    // Enrolled on the pass that first observed it, not a pass later.
    expect(first.actionsStarted).toBe(1);
    await sweep(provider, T0);
    await runStakingSync({
      chainId: CHAIN_ID,
      jobName: 'integration',
      scheduledTime: T0,
      trigger: 'manual',
      owner: 'instance-b',
      batchLimit: 50,
      provider,
      execute: true,
      now: T0,
      config: stakingConfigFixture()
    });

    expect(chain.submitted).toHaveLength(1);
    expect(await CardanoStakingOperation.countDocuments({})).toBe(1);
  });
});

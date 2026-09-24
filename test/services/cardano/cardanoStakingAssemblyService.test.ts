import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import type { CardanoStakingConfig } from '../../../src/config/cardanoStakingConfig';
import type { ICardanoStakingAccount } from '../../../src/models/cardanoStakingAccountModel';
import type { IUser } from '../../../src/models/userModel';
import {
  rewardAddress,
  stakeCredentialHex
} from '../../../src/services/cardano/cardanoAddressService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import {
  assembleStakingPlan,
  type StakingAssemblyProvider
} from '../../../src/services/cardano/cardanoStakingAssemblyService';
import type { CardanoStakeAccountState } from '../../../src/services/cardano/cardanoStakingProviderService';
import {
  stakingSignerFor,
  stakingSponsorFor
} from '../../../src/services/cardano/cardanoStakingSignerService';
import type { CardanoUtxo } from '../../../src/types/cardanoType';
import { enableCardanoPreprod, setCardanoEnv, setCardanoFeeEnv } from '../../support/cardanoEnv';

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

const PHONE = '5491122223333';
const POOL = 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx';
const RECIPIENT = 'addr_test1vrhdandhv2ngazdseql7v5fkg5utnu629anv9zt25x8vrsqn2mhal';

/**
 * A staking configuration.
 *
 * @param overrides - What differs.
 * @returns The configuration.
 */
function stakingConfig(overrides: Partial<CardanoStakingConfig> = {}): CardanoStakingConfig {
  return {
    enabled: true,
    disabledReason: '',
    minimumEnrolmentLovelace: 5_000_000n,
    defaultPoolId: POOL,
    termsVersion: 'dev-v1',
    feeDailyCapLovelace: 50_000_000n,
    drepOwnEnabled: false,
    enrolmentAllowlist: null,
    maxSponsoredRegistrationsPerWindow: 2,
    sponsorWindowDays: 30,
    ...overrides
  };
}

/**
 * The user the derivation is bound to.
 *
 * @param phoneNumber - Whose wallet it is.
 * @returns A stand-in for the document.
 */
function user(phoneNumber = PHONE): IUser {
  return { _id: new Types.ObjectId(), phone_number: phoneNumber } as unknown as IUser;
}

/**
 * An account whose credential this deployment really derives.
 *
 * Built from the derivation rather than from literals, so the suite proves the plan carries the keys
 * that match the address instead of proving that two constants were typed consistently.
 *
 * @param onChain - The snapshot.
 * @param overrides - Anything else that differs.
 * @returns A stand-in for the account.
 */
function account(
  onChain: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {}
): ICardanoStakingAccount {
  const derived = cardanoSignerService.getAccount(PHONE, 'testnet', CARDANO_PREPROD_CHAIN_ID);
  return {
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    chainId: CARDANO_PREPROD_CHAIN_ID,
    walletAddress: derived.address,
    rewardAddress: rewardAddress(derived.stakePublicKey, 'testnet'),
    stakeCredentialHex: stakeCredentialHex(derived.stakePublicKey),
    preference: { enabled: true, version: 1, updatedAt: new Date() },
    termsConsent: { version: 'dev-v1', acceptedAt: new Date(), source: 'web' },
    currentLifecycleId: 'cycle-1',
    onChain: {
      registered: false,
      poolId: null,
      governanceDelegation: null,
      depositLovelace: null,
      registrationOrigin: 'unknown',
      withdrawableRewardsLovelace: '0',
      pendingRewardsLovelace: '0',
      lifetimeRewardsLovelace: '0',
      historicalCompleteness: 'complete',
      asOf: new Date(),
      ...onChain
    },
    ...overrides
  } as unknown as ICardanoStakingAccount;
}

/**
 * An output.
 *
 * @param lovelace - What it holds.
 * @param index - Output index, so several are distinct.
 * @returns The output.
 */
function utxo(lovelace: bigint, index = 0): CardanoUtxo {
  return { txHash: 'ab'.repeat(32), outputIndex: index, lovelace, holdsOtherAssets: false };
}

/**
 * A stake account as the chain has it.
 *
 * @param overrides - What differs.
 * @returns The state.
 */
function chainState(overrides: Partial<CardanoStakeAccountState> = {}): CardanoStakeAccountState {
  return {
    registered: true,
    poolId: POOL,
    governanceDelegation: { kind: 'always_abstain' },
    withdrawableRewardsLovelace: 0n,
    lifetimeRewardsLovelace: 0n,
    withdrawnLovelace: 0n,
    depositLovelace: null,
    ...overrides
  };
}

/** What each address holds, and what the stake account read answers. */
interface ProviderState {
  state: CardanoStakeAccountState;
  userUtxos: CardanoUtxo[];
  sponsorUtxos: CardanoUtxo[];
  failTip?: boolean;
}

/**
 * A provider answering from fixed data.
 *
 * @param options - What it should report.
 * @returns The provider.
 */
function providerFor(options: Partial<ProviderState> = {}): StakingAssemblyProvider {
  const state = options.state ?? chainState();
  const userUtxos = options.userUtxos ?? [utxo(10_000_000n, 0)];
  const sponsorUtxos = options.sponsorUtxos ?? [utxo(100_000_000n, 1)];
  const sponsorAddress = stakingSponsorFor();

  return {
    tip: async () => {
      if (options.failTip) throw new Error('CARDANO_PROVIDER_UNAVAILABLE');
      return { slot: 90_000_000, height: 3_000_000 };
    },
    stakingProtocolParameters: async () => ({
      minFeeA: 44,
      minFeeB: 155_381,
      coinsPerUtxoByte: 4_310n,
      maxTxSize: 16_384,
      stakeAddressDeposit: 2_000_000n,
      drepDeposit: 500_000_000n
    }),
    stakeAccount: async () => state,
    utxosFor: async (address: string) =>
      sponsorAddress.available && address === sponsorAddress.account.address
        ? sponsorUtxos
        : userUtxos
  };
}

beforeEach(() => {
  enableCardanoPreprod();
  setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: 'test-sponsor' });
});

describe('stakingSignerFor', () => {
  it('finds the keys for a credential this deployment derived', () => {
    const availability = stakingSignerFor(account(), user());
    expect(availability.available).toBe(true);
  });

  it('refuses a wallet this deployment did not derive', () => {
    // The shape of every externally-owned wallet: legible on chain, unsignable here.
    const foreign = account({}, { walletAddress: RECIPIENT });
    const availability = stakingSignerFor(foreign, user());

    expect(availability).toMatchObject({ available: false, reason: 'address_mismatch' });
  });

  it('keeps the two addresses out of the refusal detail', () => {
    const foreign = account({}, { walletAddress: RECIPIENT });
    const availability = stakingSignerFor(foreign, user());

    if (availability.available) throw new Error('expected a refusal');
    expect(availability.detail).not.toContain(RECIPIENT);
  });

  it('refuses when the address matches and the stake credential does not', () => {
    const tampered = account({}, { stakeCredentialHex: 'ff'.repeat(28) });
    expect(stakingSignerFor(tampered, user())).toMatchObject({
      available: false,
      reason: 'credential_mismatch'
    });
  });

  it('refuses an account belonging to another network', () => {
    const other = account({}, { chainId: 900_764_824_073 });
    expect(stakingSignerFor(other, user())).toMatchObject({
      available: false,
      reason: 'network_mismatch'
    });
  });

  it('refuses while the Cardano family is off', () => {
    setCardanoEnv({ enabled: false });
    expect(stakingSignerFor(account(), user())).toMatchObject({
      available: false,
      reason: 'cardano_disabled'
    });
  });
});

describe('stakingSponsorFor', () => {
  it('derives the sponsor when sponsorship is on', () => {
    expect(stakingSponsorFor().available).toBe(true);
  });

  it('refuses when sponsorship is off', () => {
    setCardanoFeeEnv({ sponsorFees: false });
    expect(stakingSponsorFor()).toMatchObject({ available: false, reason: 'sponsor_disabled' });
  });
});

describe('assembleStakingPlan', () => {
  it('assembles a registration with the deposit the chain charges now', async () => {
    const result = await assembleStakingPlan({
      account: account(),
      user: user(),
      action: 'register_and_delegate',
      provider: providerFor({ state: chainState({ registered: false }) }),
      config: stakingConfig()
    });

    if (result.outcome !== 'assembled') throw new Error(`refused: ${result.refusal}`);
    expect(result.plan.shape).toBe('register_and_delegate');
    // From the parameters read this epoch, never from configuration.
    expect(result.plan.depositLovelace).toBe(2_000_000n);
    expect(result.plan.poolId).toBe(POOL);
    expect(result.plan.drep).toEqual({ kind: 'always_abstain' });
  });

  it('carries the keys that match the address it spends from', async () => {
    const subject = account();
    const result = await assembleStakingPlan({
      account: subject,
      user: user(),
      action: 'register_and_delegate',
      provider: providerFor({ state: chainState({ registered: false }) }),
      config: stakingConfig()
    });

    if (result.outcome !== 'assembled') throw new Error(`refused: ${result.refusal}`);
    expect(result.plan.userStakeKeyHash).toBe(subject.stakeCredentialHex);
    expect(result.plan.stakeCredential).toEqual({
      type: 'key_hash',
      hashHex: subject.stakeCredentialHex
    });
    expect(result.plan.rewardAddress).toBe(subject.rewardAddress);
  });

  it('refuses a wallet it cannot sign for before reading the chain', async () => {
    let reads = 0;
    const provider = providerFor();
    const counting: StakingAssemblyProvider = {
      ...provider,
      tip: async () => {
        reads += 1;
        return provider.tip();
      }
    };

    const result = await assembleStakingPlan({
      account: account({}, { walletAddress: RECIPIENT }),
      user: user(),
      action: 'withdraw_rewards',
      provider: counting,
      config: stakingConfig()
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'signer_unavailable' });
    // The point of ordering the check first: an unsignable wallet costs no provider quota.
    expect(reads).toBe(0);
  });

  it('refuses a registration the chain says already happened', async () => {
    // The snapshot the decision used said unregistered; a read taken now disagrees.
    const result = await assembleStakingPlan({
      account: account({ registered: false }),
      user: user(),
      action: 'register_and_delegate',
      provider: providerFor({ state: chainState({ registered: true }) }),
      config: stakingConfig()
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'already_registered' });
  });

  it('refuses everything else when the chain says the credential is gone', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true }),
      user: user(),
      action: 'withdraw_rewards',
      provider: providerFor({ state: chainState({ registered: false }) }),
      config: stakingConfig()
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'not_registered' });
  });

  it('withdraws the balance read now, not the one in the snapshot', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true, withdrawableRewardsLovelace: '8183734' }),
      user: user(),
      action: 'withdraw_rewards',
      provider: providerFor({
        state: chainState({ withdrawableRewardsLovelace: 11_500_000n })
      }),
      config: stakingConfig()
    });

    if (result.outcome !== 'assembled') throw new Error(`refused: ${result.refusal}`);
    expect(result.plan.withdrawalLovelace).toBe(11_500_000n);
  });

  it('refuses a withdrawal whose rewards were claimed in the meantime', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true, withdrawableRewardsLovelace: '8183734' }),
      user: user(),
      action: 'withdraw_rewards',
      provider: providerFor({ state: chainState({ withdrawableRewardsLovelace: 0n }) }),
      config: stakingConfig()
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'no_rewards' });
  });

  it('refuses a withdrawal from a credential that never delegated its vote', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true }),
      user: user(),
      action: 'withdraw_rewards',
      provider: providerFor({
        state: chainState({
          governanceDelegation: { kind: 'none' },
          withdrawableRewardsLovelace: 8_183_734n
        })
      }),
      config: stakingConfig()
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'vote_delegation_required' });
  });

  it('refunds what was paid, not what the parameter says today', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true, depositLovelace: '2000000' }),
      user: user(),
      action: 'exit_and_send_max',
      provider: providerFor({
        // The parameter rose after this credential was registered.
        state: chainState()
      }),
      recipientAddress: RECIPIENT,
      config: stakingConfig()
    });

    if (result.outcome !== 'assembled') throw new Error(`refused: ${result.refusal}`);
    expect(result.plan.refundLovelace).toBe(2_000_000n);
    expect(result.plan.recipientAddressBytes).toBeDefined();
  });

  it('refuses an exit whose paid deposit is unknown', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true, depositLovelace: null }),
      user: user(),
      action: 'exit_and_send_max',
      provider: providerFor(),
      recipientAddress: RECIPIENT,
      config: stakingConfig()
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'deposit_unknown' });
  });

  it('refuses an exit that would have to empty rewards it cannot withdraw', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true, depositLovelace: '2000000' }),
      user: user(),
      action: 'exit_and_send_max',
      provider: providerFor({
        state: chainState({
          governanceDelegation: { kind: 'none' },
          withdrawableRewardsLovelace: 8_183_734n
        })
      }),
      recipientAddress: RECIPIENT,
      config: stakingConfig()
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'vote_delegation_required' });
  });

  it('refuses an exit with no usable destination', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true, depositLovelace: '2000000' }),
      user: user(),
      action: 'exit_and_send_max',
      provider: providerFor(),
      recipientAddress: 'not-an-address',
      config: stakingConfig()
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'recipient_invalid' });
  });

  it('refuses when no sponsor can pay the network fee', async () => {
    setCardanoFeeEnv({ sponsorFees: false });
    const result = await assembleStakingPlan({
      account: account({ registered: true }),
      user: user(),
      action: 'delegate_vote',
      provider: providerFor(),
      config: stakingConfig()
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'sponsor_unavailable' });
  });

  it('refuses when the chain cannot be read', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true }),
      user: user(),
      action: 'delegate_vote',
      provider: providerFor({ failTip: true }),
      config: stakingConfig()
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'provider_unavailable' });
  });

  it('refuses a registration with nothing to spend', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: false }),
      user: user(),
      action: 'register_and_delegate',
      provider: providerFor({ state: chainState({ registered: false }), userUtxos: [] }),
      config: stakingConfig()
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'no_spendable_inputs' });
  });

  it('assembles a withdrawal even when the user holds nothing', async () => {
    // The sponsor pays the fee and the rewards arrive from the reward account, so this one shape
    // does not need an input from the user at all.
    const result = await assembleStakingPlan({
      account: account({ registered: true }),
      user: user(),
      action: 'withdraw_rewards',
      provider: providerFor({
        state: chainState({ withdrawableRewardsLovelace: 8_183_734n }),
        userUtxos: []
      }),
      config: stakingConfig()
    });

    expect(result.outcome).toBe('assembled');
  });

  it('refuses when the sponsor holds nothing', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true }),
      user: user(),
      action: 'delegate_vote',
      provider: providerFor({ sponsorUtxos: [] }),
      config: stakingConfig()
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'sponsor_empty' });
  });

  it('refuses a kind that has no transaction shape', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true }),
      user: user(),
      action: 'register_drep',
      provider: providerFor(),
      config: stakingConfig()
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'unsupported_action' });
  });

  it('refuses a re-delegation with no pool configured', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true }),
      user: user(),
      action: 'redelegate_pool',
      provider: providerFor(),
      config: stakingConfig({ defaultPoolId: null })
    });

    expect(result).toMatchObject({ outcome: 'refused', refusal: 'no_pool_configured' });
  });

  it('sets the ttl ahead of the tip it read', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true }),
      user: user(),
      action: 'delegate_vote',
      provider: providerFor(),
      config: stakingConfig()
    });

    if (result.outcome !== 'assembled') throw new Error(`refused: ${result.refusal}`);
    expect(result.plan.ttlSlot).toBeGreaterThan(90_000_000);
  });

  it('signs with the user payment key, the user stake key and the sponsor', async () => {
    const result = await assembleStakingPlan({
      account: account({ registered: true }),
      user: user(),
      action: 'delegate_vote',
      provider: providerFor(),
      config: stakingConfig()
    });

    if (result.outcome !== 'assembled') throw new Error(`refused: ${result.refusal}`);
    const witnesses = result.signer.witnessesFor('ab'.repeat(32));
    expect(witnesses).toHaveLength(3);
    expect(new Set(witnesses.map((witness) => witness.publicKey)).size).toBe(3);
  });
});

import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import type { CardanoStakingConfig } from '../../../src/config/cardanoStakingConfig';
import CardanoStakingAccount, {
  type ICardanoStakingAccount
} from '../../../src/models/cardanoStakingAccountModel';
import CardanoStakingOperation from '../../../src/models/cardanoStakingOperationModel';
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
  CardanoStakeAccountState,
  CardanoStakingProtocolParameters
} from '../../../src/services/cardano/cardanoStakingProviderService';
import {
  runStakingSync,
  type StakingSyncProvider
} from '../../../src/services/cardano/cardanoStakingSyncService';
import { setStakingConsent } from '../../../src/services/cardano/cardanoStakingUserService';
import type { CardanoUtxo } from '../../../src/types/cardanoType';
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

/**
 * Leaving, and staying left.
 *
 * This file exists because of a regression seen on a real network. A wallet was registered, the user
 * deregistered it, the deposit came back — and the next sweep enrolled it again, because everything the
 * sweep looks at still said yes: the consent was on file, the balance cleared the threshold, the
 * address was on the enrolment list, and `preference.enabled` had never been touched. The user had paid
 * a sponsor fee to leave and another one to be brought back.
 *
 * So the decision to leave is a stored fact, written before anything is built, and the tests below are
 * about the three ways a stored fact normally gets lost: a crash in the middle, a retry, and two
 * requests at once.
 */

const PHONE = '5491177778888';
const POOL = 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx';
const JOB = 'cardano-staking-sync';

const PARAMETERS: CardanoStakingProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155_381,
  coinsPerUtxoByte: 4_310n,
  maxTxSize: 16_384,
  stakeAddressDeposit: 2_000_000n,
  drepDeposit: 500_000_000n
};

/**
 * A staking configuration.
 *
 * @param overrides - What differs.
 * @returns The configuration.
 */
function config(overrides: Partial<CardanoStakingConfig> = {}): CardanoStakingConfig {
  return {
    enabled: true,
    disabledReason: '',
    minimumEnrolmentLovelace: 5_000_000n,
    defaultPoolId: POOL,
    termsVersion: 'dev-v1',
    feeDailyCapLovelace: 50_000_000n,
    drepOwnEnabled: false,
    enrolmentAllowlist: null,
    ...overrides
  };
}

const ADDRESS_BYTES = cardanoSignerService.getAccount(
  PHONE,
  'testnet',
  CARDANO_PREPROD_CHAIN_ID
).addressBytes;

/**
 * The context a decision is taken in, with everything saying "yes, enrol this".
 *
 * Deliberately generous: consent on file, ten ada spendable, no confinement, keys available. The point
 * of every case below is that the opt-out outranks all of it.
 *
 * @param overrides - What differs.
 * @returns The context.
 */
function context(overrides: Partial<StakingDecisionContext> = {}): StakingDecisionContext {
  return {
    config: config(),
    parameters: PARAMETERS,
    addressBytes: ADDRESS_BYTES,
    spendableLovelace: 10_000_000n,
    poolState: null,
    operationInFlight: false,
    signerAvailable: true,
    ...overrides
  };
}

/**
 * An account, shaped like the document without needing a database.
 *
 * @param onChain - The snapshot.
 * @param overrides - Anything else that differs.
 * @returns A stand-in for the account.
 */
function account(
  onChain: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {}
): ICardanoStakingAccount {
  return {
    _id: new Types.ObjectId(),
    walletAddress: 'addr_test1_whatever',
    preference: { enabled: false, version: 3, updatedAt: new Date() },
    termsConsent: { version: 'dev-v1', acceptedAt: new Date(), source: 'web' },
    optOut: { at: new Date(), reason: 'user_exit', source: 'web', preferenceVersion: 2 },
    onChain: {
      registered: false,
      poolId: null,
      governanceDelegation: null,
      depositLovelace: null,
      registrationOrigin: 'chatterpay',
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

beforeEach(async () => {
  enableCardanoPreprod();
  setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: 'test-sponsor' });
  await CardanoStakingAccount.deleteMany({});
  await CardanoStakingOperation.deleteMany({});
  await UserModel.deleteMany({});
});

describe('the sweep and a wallet that left', () => {
  it('does not enrol it, though everything else says to', () => {
    // The regression, as a unit: consent on file, funds over the threshold, no confinement.
    const decision = decideAutomaticAction(account(), context());

    expect(decision).toMatchObject({ action: 'none', refusal: 'opted_out', detail: 'user_exit' });
  });

  it('does not enrol it because ChatterPay registered it before', () => {
    // An account ChatterPay enrolled is exempt from the allowlist, because dropping it from the list
    // must not abandon a position we opened. That exemption must not become an exemption from the
    // user's decision to leave.
    const decision = decideAutomaticAction(
      account({ registrationOrigin: 'chatterpay' }),
      context({ config: config({ enrolmentAllowlist: ['somebody-else'] }) })
    );

    expect(decision.refusal).toBe('opted_out');
  });

  it('does not enrol it because it is on the enrolment list', () => {
    const subject = account({}, { walletAddress: 'addr_test1_on_the_list' });
    const decision = decideAutomaticAction(
      subject,
      context({ config: config({ enrolmentAllowlist: ['addr_test1_on_the_list'] }) })
    );

    expect(decision.refusal).toBe('opted_out');
  });

  it('does not delegate its vote', () => {
    const decision = decideAutomaticAction(
      account({ registered: true, poolId: POOL, governanceDelegation: { kind: 'none' } }),
      context()
    );

    expect(decision.refusal).toBe('opted_out');
  });

  it('does not move it off a retiring pool', () => {
    const decision = decideAutomaticAction(
      account({
        registered: true,
        poolId: POOL,
        governanceDelegation: { kind: 'always_abstain' }
      }),
      context({
        poolState: {
          poolId: POOL,
          retirementScheduled: true,
          retiringEpoch: 320,
          activeStakeLovelace: null
        }
      })
    );

    expect(decision.refusal).toBe('opted_out');
  });

  it('still brings its rewards back', () => {
    // Leaving is a decision about future participation, not a forfeit of ada already earned.
    const decision = decideAutomaticAction(
      account({
        registered: true,
        poolId: POOL,
        governanceDelegation: { kind: 'always_abstain' },
        withdrawableRewardsLovelace: '8183734'
      }),
      context()
    );

    expect(decision.action).toBe('withdraw_rewards');
  });

  it('does not invent a vote delegation in order to reach stranded rewards', () => {
    // A withdrawal needs a vote delegation under Conway. For a wallet that left, delegating one is a
    // participation decision nobody asked for, so the rewards stay where they are and the refusal says
    // why rather than a certificate being sent on the user's behalf.
    const decision = decideAutomaticAction(
      account({
        registered: true,
        poolId: POOL,
        governanceDelegation: { kind: 'none' },
        withdrawableRewardsLovelace: '8183734'
      }),
      context()
    );

    expect(decision.refusal).toBe('opted_out');
  });
});

describe('an empty wallet is not a wallet that left', () => {
  it('reports the funds, not a decision nobody took', () => {
    // Zero outputs is a balance, not an opt-out. Conflating them would take a wallet out of staking
    // because it spent its ada, and then require an explicit opt-in to put it back.
    const stillIn = account(
      {},
      {
        optOut: null,
        preference: { enabled: true, version: 1, updatedAt: new Date() }
      }
    );

    const decision = decideAutomaticAction(stillIn, context({ spendableLovelace: 0n }));

    expect(decision.refusal).toBe('not_eligible');
  });

  it('keeps an opted-in wallet enrollable once funds arrive', async () => {
    const stillIn = account(
      {},
      { optOut: null, preference: { enabled: true, version: 1, updatedAt: new Date() } }
    );

    expect(decideAutomaticAction(stillIn, context({ spendableLovelace: 0n })).refusal).toBe(
      'not_eligible'
    );
    expect(decideAutomaticAction(stillIn, context()).action).toBe('register_and_delegate');
  });
});

describe('what a wallet that left may still ask for', () => {
  it('refuses to register again', () => {
    const decision = decideRequestedAction(account(), 'register_and_delegate', context());

    expect(decision.refusal).toBe('opted_out');
  });

  it('refuses to delegate a vote', () => {
    // Pressing a participation button is not an opt-in. Treating it as one would make the recorded
    // decision revocable by any control that happens to need staking to be on.
    const decision = decideRequestedAction(
      account({ registered: true }),
      'delegate_vote',
      context()
    );

    expect(decision.refusal).toBe('opted_out');
  });

  it('refuses to re-delegate a pool', () => {
    const decision = decideRequestedAction(
      account({ registered: true, poolId: 'pool1other' }),
      'redelegate_pool',
      context()
    );

    expect(decision.refusal).toBe('opted_out');
  });

  it('allows a withdrawal', () => {
    const decision = decideRequestedAction(
      account({
        registered: true,
        governanceDelegation: { kind: 'always_abstain' },
        withdrawableRewardsLovelace: '8183734'
      }),
      'withdraw_rewards',
      context()
    );

    expect(decision.action).toBe('withdraw_rewards');
  });

  it('allows a deregistration', () => {
    const decision = decideRequestedAction(
      account({
        registered: true,
        depositLovelace: '2000000',
        governanceDelegation: { kind: 'always_abstain' }
      }),
      'deregister',
      context()
    );

    expect(decision.action).toBe('deregister');
  });

  it('allows an exit', () => {
    const decision = decideRequestedAction(
      account({
        registered: true,
        depositLovelace: '2000000',
        governanceDelegation: { kind: 'always_abstain' }
      }),
      'exit_and_send_max',
      context()
    );

    expect(decision.action).toBe('exit_and_send_max');
  });
});

/**
 * Creates a user and its staking account, opted in and consented.
 *
 * @param phoneNumber - Whose wallet it is.
 * @returns The account id.
 */
async function seed(phoneNumber: string): Promise<Types.ObjectId> {
  const derived = cardanoSignerService.getAccount(phoneNumber, 'testnet', CARDANO_PREPROD_CHAIN_ID);
  const user = await UserModel.create({
    phone_number: phoneNumber,
    name: `user-${phoneNumber}`,
    wallets: [],
    settings: {}
  });

  const created = await CardanoStakingAccount.create({
    userId: user._id,
    chainId: CARDANO_PREPROD_CHAIN_ID,
    walletAddress: derived.address,
    rewardAddress: rewardAddress(derived.stakePublicKey, 'testnet'),
    stakeCredentialHex: stakeCredentialHex(derived.stakePublicKey),
    preference: { enabled: true, version: 1, updatedAt: new Date() },
    termsConsent: { version: 'dev-v1', acceptedAt: new Date(), source: 'web' },
    currentLifecycleId: 'cycle-1',
    state: 'active',
    onChain: {
      registered: true,
      poolId: POOL,
      governanceDelegation: { kind: 'always_abstain' },
      depositLovelace: '2000000',
      registrationOrigin: 'chatterpay',
      asOf: new Date()
    }
  });

  return created._id as Types.ObjectId;
}

describe('recording the decision', () => {
  it('stores it when the user switches staking off', async () => {
    const accountId = await seed(PHONE);

    await setStakingConsent(PHONE, false, 'web');

    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.preference.enabled).toBe(false);
    expect(stored?.optOut).toMatchObject({ reason: 'user_request', source: 'web' });
  });

  it('keeps the consent on file', async () => {
    const accountId = await seed(PHONE);

    await setStakingConsent(PHONE, false, 'web');

    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.termsConsent?.version).toBe('dev-v1');
  });

  it('does not move the moment the decision was taken when it is repeated', async () => {
    // A retry is the same decision, not a new one.
    const accountId = await seed(PHONE);
    await setStakingConsent(PHONE, false, 'web');
    const first = (await CardanoStakingAccount.findById(accountId).lean())?.optOut?.at;

    await setStakingConsent(PHONE, false, 'bot');

    const second = (await CardanoStakingAccount.findById(accountId).lean())?.optOut;
    expect(second?.at?.getTime()).toBe(first?.getTime());
    expect(second?.source).toBe('web');
  });

  it('writes one record when two requests arrive at once', async () => {
    // No transactions here, so the filter is the condition: the conditional update matches for exactly
    // one of the two and the other finds the record already in place.
    const accountId = await seed(PHONE);

    await Promise.all([
      setStakingConsent(PHONE, false, 'web'),
      setStakingConsent(PHONE, false, 'bot')
    ]);

    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.optOut).not.toBeNull();
    expect(stored?.preference.enabled).toBe(false);
  });

  it('is cleared only by an explicit opt-in', async () => {
    const accountId = await seed(PHONE);
    await setStakingConsent(PHONE, false, 'web');

    await setStakingConsent(PHONE, true, 'web');

    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.optOut ?? null).toBeNull();
    expect(stored?.preference.enabled).toBe(true);
  });

  it('records the preference version it was taken against', async () => {
    const accountId = await seed(PHONE);

    await setStakingConsent(PHONE, false, 'web');

    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.optOut?.preferenceVersion).toBe(1);
    expect(stored?.preference.version).toBe(2);
  });
});

/**
 * A provider that reports a funded wallet and a credential the chain says is gone.
 *
 * This is the state right after a deregistration confirms: money in the wallet, nothing registered.
 *
 * @param state - What the stake account read returns.
 * @param utxos - What the address holds.
 * @returns The provider.
 */
function providerFor(state: CardanoStakeAccountState, utxos: CardanoUtxo[]): StakingSyncProvider {
  return {
    tip: async () => ({ slot: 90_000_000, height: 3_000_000 }),
    utxosFor: async () => utxos,
    submit: async () => {
      throw new Error('this suite never submits');
    },
    statusOf: async () => ({ known: false, confirmations: 0 }),
    stakingProtocolParameters: async () => PARAMETERS,
    stakeAccount: async () => state,
    rewardHistory: async () => ({ credits: [], completeness: 'complete' as const }),
    registrationHistory: async () => []
  };
}

/** The chain, right after the deposit came back. */
const GONE: CardanoStakeAccountState = {
  registered: false,
  poolId: null,
  governanceDelegation: { kind: 'not_registered' },
  withdrawableRewardsLovelace: 0n,
  lifetimeRewardsLovelace: null,
  withdrawnLovelace: null,
  depositLovelace: null
};

describe('the sync, the day after a wallet left', () => {
  it('does not enrol it again', async () => {
    // The regression end to end, through the real sweep: funded, consented, unconfined, and out.
    await seed(PHONE);
    await setStakingConsent(PHONE, false, 'web');

    const result = await runStakingSync({
      chainId: CARDANO_PREPROD_CHAIN_ID,
      jobName: JOB,
      scheduledTime: new Date('2026-02-01T03:00:00.000Z'),
      owner: 'instance-a',
      batchLimit: 10,
      provider: providerFor(GONE, [
        {
          txHash: 'ab'.repeat(32),
          outputIndex: 0,
          lovelace: 9_998_000_000n,
          holdsOtherAssets: false
        }
      ]),
      execute: true,
      config: config()
    });

    expect(result.actionsStarted).toBe(0);
    expect(result.refusals.opted_out).toBe(1);
  });

  it('creates no operation for it', async () => {
    const accountId = await seed(PHONE);
    await setStakingConsent(PHONE, false, 'web');

    await runStakingSync({
      chainId: CARDANO_PREPROD_CHAIN_ID,
      jobName: JOB,
      scheduledTime: new Date('2026-02-02T03:00:00.000Z'),
      owner: 'instance-a',
      batchLimit: 10,
      provider: providerFor(GONE, [
        {
          txHash: 'ab'.repeat(32),
          outputIndex: 0,
          lovelace: 9_998_000_000n,
          holdsOtherAssets: false
        }
      ]),
      execute: true,
      config: config()
    });

    expect(await CardanoStakingOperation.countDocuments({ accountId })).toBe(0);
  });

  it('leaves it out across a crash that happened before the deregistration landed', async () => {
    // The dangerous window. The decision was recorded, the transaction was sent, the process died, and
    // the sweep runs while the credential is still registered. Nothing must be started on it — and the
    // next pass, once the deregistration confirms, must still refuse.
    const accountId = await seed(PHONE);
    await setStakingConsent(PHONE, false, 'web');

    const stillRegistered: CardanoStakeAccountState = {
      ...GONE,
      registered: true,
      poolId: POOL,
      governanceDelegation: { kind: 'always_abstain' }
    };

    const during = await runStakingSync({
      chainId: CARDANO_PREPROD_CHAIN_ID,
      jobName: JOB,
      scheduledTime: new Date('2026-02-03T03:00:00.000Z'),
      owner: 'instance-a',
      batchLimit: 10,
      provider: providerFor(stillRegistered, []),
      execute: true,
      config: config()
    });
    expect(during.actionsStarted).toBe(0);

    const after = await runStakingSync({
      chainId: CARDANO_PREPROD_CHAIN_ID,
      jobName: JOB,
      scheduledTime: new Date('2026-02-04T03:00:00.000Z'),
      owner: 'instance-a',
      batchLimit: 10,
      provider: providerFor(GONE, [
        {
          txHash: 'cd'.repeat(32),
          outputIndex: 0,
          lovelace: 9_998_000_000n,
          holdsOtherAssets: false
        }
      ]),
      execute: true,
      config: config()
    });

    expect(after.actionsStarted).toBe(0);
    expect(await CardanoStakingOperation.countDocuments({ accountId })).toBe(0);
  });

  it('enrols it again once the user opts back in', async () => {
    // The decision is reversible, deliberately and only this way.
    await seed(PHONE);
    await setStakingConsent(PHONE, false, 'web');
    await setStakingConsent(PHONE, true, 'web');

    const stored = await CardanoStakingAccount.findOne({}).lean();
    expect(stored?.optOut ?? null).toBeNull();

    const decision = decideAutomaticAction(
      { ...(stored as unknown as ICardanoStakingAccount), optOut: null } as ICardanoStakingAccount,
      context()
    );
    expect(decision.refusal).not.toBe('opted_out');
  });
});

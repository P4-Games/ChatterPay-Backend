import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import Blockchain from '../../../src/models/blockchainModel';
import CardanoStakingAccount from '../../../src/models/cardanoStakingAccountModel';
import CardanoStakingOperation from '../../../src/models/cardanoStakingOperationModel';
import { UserModel } from '../../../src/models/userModel';
import {
  rewardAddress,
  stakeCredentialHex
} from '../../../src/services/cardano/cardanoAddressService';
import {
  CardanoProviderError,
  type CardanoTransactionStatus
} from '../../../src/services/cardano/cardanoProviderService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import { reconcileWhenDue } from '../../../src/services/cardano/cardanoStakingLifecycleService';
import type { CardanoStakeAccountState } from '../../../src/services/cardano/cardanoStakingProviderService';
import {
  getStakingOperationStatus,
  settleLiveOperation
} from '../../../src/services/cardano/cardanoStakingUserService';
import { enableCardanoPreprod } from '../../support/cardanoEnv';
import { seedStakingNetwork } from '../../support/cardanoStakingNetwork';

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
const PHONE = '5491133334444';
const OTHER_PHONE = '5491155556666';
const INTERVAL_MS = 30_000;
const T0 = new Date('2026-05-01T12:00:00.000Z');
const TTL_SLOT = 100_000;

/**
 * A moment `seconds` after {@link T0}.
 *
 * @param seconds - Offset.
 * @returns The date.
 */
function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

/** A chain whose answers a test sets and whose reads are counted. */
interface ScriptedChain {
  slot: number;
  status: CardanoTransactionStatus | Error;
  tipFails: boolean;
  calls: { tip: number; statusOf: number; stakeAccount: number; rewardHistory: number };
  state: CardanoStakeAccountState;
}

/**
 * A scripted chain with nothing on it.
 *
 * @returns The chain.
 */
function scriptedChain(): ScriptedChain {
  return {
    slot: 90_000,
    status: { known: false, confirmations: 0 },
    tipFails: false,
    calls: { tip: 0, statusOf: 0, stakeAccount: 0, rewardHistory: 0 },
    state: {
      registered: true,
      poolId: 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx',
      governanceDelegation: { kind: 'always_abstain' },
      withdrawableRewardsLovelace: 0n,
      lifetimeRewardsLovelace: null,
      withdrawnLovelace: null,
      depositLovelace: 2_000_000n
    }
  };
}

/**
 * The two providers a read is given, backed by one scripted chain.
 *
 * @param chain - The chain.
 * @returns The providers.
 */
function providersFor(chain: ScriptedChain) {
  return {
    base: {
      tip: async () => {
        chain.calls.tip += 1;
        if (chain.tipFails) throw new CardanoProviderError('timeout', 'tip timed out');
        return { slot: chain.slot, height: 1_000 };
      },
      statusOf: async () => {
        chain.calls.statusOf += 1;
        if (chain.status instanceof Error) throw chain.status;
        return chain.status;
      },
      protocolParameters: async () => {
        throw new Error('not read by a status check');
      },
      utxosFor: async () => {
        throw new Error('not read by a status check');
      },
      confirmedUtxosFor: async () => {
        throw new Error('not read by a status check');
      },
      submit: async () => {
        throw new Error('never submits');
      }
    },
    staking: {
      stakeAccount: async () => {
        chain.calls.stakeAccount += 1;
        return chain.state;
      },
      rewardHistory: async () => {
        chain.calls.rewardHistory += 1;
        return { credits: [], completeness: 'complete' as const };
      },
      registrationHistory: async () => [],
      currentEpoch: async () => {
        throw new Error('not read by a status check');
      },
      stakingProtocolParameters: async () => {
        throw new Error('not read by a status check');
      },
      poolState: async () => {
        throw new Error('not read by a status check');
      },
      drepState: async () => {
        throw new Error('not read by a status check');
      },
      listDReps: async () => {
        throw new Error('not read by a status check');
      },
      drepNames: async () => {
        throw new Error('not read by a status check');
      }
    }
  };
}

/**
 * A user and a staking account on a chain.
 *
 * @param phoneNumber - Whose.
 * @param chainId - Which network.
 * @returns The account id.
 */
async function seedAccount(phoneNumber: string, chainId = CHAIN_ID): Promise<Types.ObjectId> {
  const derived = cardanoSignerService.getAccount(phoneNumber, 'testnet', CHAIN_ID);
  const user =
    (await UserModel.findOne({ phone_number: phoneNumber })) ??
    (await UserModel.create({
      phone_number: phoneNumber,
      name: `user-${phoneNumber}`,
      wallets: [],
      settings: {}
    }));
  const account = await CardanoStakingAccount.create({
    userId: user._id,
    chainId,
    walletAddress: derived.address,
    rewardAddress: rewardAddress(derived.stakePublicKey, 'testnet'),
    stakeCredentialHex: stakeCredentialHex(derived.stakePublicKey),
    state: 'active',
    onChain: {
      registered: true,
      poolId: 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx',
      governanceDelegation: { kind: 'none' },
      asOf: T0
    }
  });
  return account._id as Types.ObjectId;
}

/**
 * A vote delegation the dashboard just submitted.
 *
 * @param accountId - Whose.
 * @returns The operation id.
 */
async function seedSubmittedVote(accountId: Types.ObjectId): Promise<Types.ObjectId> {
  const operation = await CardanoStakingOperation.create({
    accountId,
    chainId: CHAIN_ID,
    lifecycleId: `cycle-${accountId.toHexString()}`,
    kind: 'delegate_vote',
    actor: 'dashboard',
    idempotencyKey: `vote-${accountId.toHexString()}`,
    status: 'submitted',
    chainOutcome: 'pending',
    txId: 'a'.repeat(64),
    ttlSlot: TTL_SLOT,
    governanceTarget: 'always_abstain'
  });
  return operation._id as Types.ObjectId;
}

/**
 * The account as stored.
 *
 * @param accountId - Which.
 * @returns The document.
 */
async function accountOf(accountId: Types.ObjectId) {
  const account = await CardanoStakingAccount.findById(accountId).exec();
  if (account === null) throw new Error('account missing');
  return account;
}

beforeEach(async () => {
  enableCardanoPreprod();
  await CardanoStakingAccount.deleteMany({});
  await CardanoStakingOperation.deleteMany({});
  await UserModel.deleteMany({});
  await Blockchain.deleteMany({});
  await seedStakingNetwork({ operationStatusCheckIntervalSeconds: INTERVAL_MS / 1000 });
});

describe('settling a dashboard operation without the sweep', () => {
  it('shows a freshly submitted operation as pending', async () => {
    const accountId = await seedAccount(PHONE);
    await seedSubmittedVote(accountId);
    const chain = scriptedChain();

    const result = await getStakingOperationStatus(PHONE, { ...providersFor(chain), now: T0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.operation?.status).toBe('submitted');
    expect(result.data.operation?.settled).toBe(false);
    expect(result.data.operation?.chainOutcome).toBe('pending');
  });

  it('holds at one and two confirmations and confirms at three', async () => {
    const accountId = await seedAccount(PHONE);
    const operationId = await seedSubmittedVote(accountId);
    const chain = scriptedChain();
    const { base, staking } = providersFor(chain);

    for (const [index, confirmations] of [1, 2].entries()) {
      chain.status = { known: true, confirmations };
      await settleLiveOperation(
        await accountOf(accountId),
        INTERVAL_MS,
        base,
        staking,
        at(index * 31)
      );
      const pending = await CardanoStakingOperation.findById(operationId).lean();
      expect(pending?.status).toBe('submitted');
      expect(pending?.chainOutcome).toBe('pending');
    }

    chain.status = { known: true, confirmations: 3 };
    const changed = await settleLiveOperation(
      await accountOf(accountId),
      INTERVAL_MS,
      base,
      staking,
      at(62)
    );

    expect(changed).toBe(true);
    const confirmed = await CardanoStakingOperation.findById(operationId).lean();
    expect(confirmed?.status).toBe('confirmed');
    const account = await CardanoStakingAccount.findById(accountId).lean();
    // The vote delegation on screen is the chain's, read once after the confirmation.
    expect(account?.onChain.governanceDelegation?.kind).toBe('always_abstain');
    expect(account?.refreshRequestedAt).not.toBeNull();
    // The light re-read does not page through the reward history.
    expect(chain.calls.rewardHistory).toBe(0);
  });

  it('reflects the confirmation in the light status read', async () => {
    const accountId = await seedAccount(PHONE);
    await seedSubmittedVote(accountId);
    const chain = scriptedChain();
    chain.status = { known: true, confirmations: 3 };

    const result = await getStakingOperationStatus(PHONE, { ...providersFor(chain), now: T0 });

    expect(result.ok && result.data.operation?.status).toBe('confirmed');
    expect(result.ok && result.data.governanceDelegation).toMatchObject({ kind: 'always_abstain' });
  });

  it('never reads a submitted operation as confirmed', async () => {
    const accountId = await seedAccount(PHONE);
    await seedSubmittedVote(accountId);
    const chain = scriptedChain();
    chain.status = { known: false, confirmations: 0 };

    const result = await getStakingOperationStatus(PHONE, { ...providersFor(chain), now: T0 });

    expect(result.ok && result.data.operation?.chainOutcome).toBe('pending');
    expect(result.ok && result.data.operation?.settled).toBe(false);
  });

  it('asks the chain at most once per interval, however often the page reloads', async () => {
    const accountId = await seedAccount(PHONE);
    await seedSubmittedVote(accountId);
    const chain = scriptedChain();
    const deps = providersFor(chain);

    for (const seconds of [0, 1, 5, 10, 29]) {
      await getStakingOperationStatus(PHONE, { ...deps, now: at(seconds) });
    }
    expect(chain.calls.statusOf).toBe(1);

    await getStakingOperationStatus(PHONE, { ...deps, now: at(30) });
    expect(chain.calls.statusOf).toBe(2);
  });

  it('lets only one of two concurrent tabs make the lookup', async () => {
    const accountId = await seedAccount(PHONE);
    await seedSubmittedVote(accountId);
    const chain = scriptedChain();
    const deps = providersFor(chain);

    await Promise.all([
      getStakingOperationStatus(PHONE, { ...deps, now: T0 }),
      getStakingOperationStatus(PHONE, { ...deps, now: T0 }),
      getStakingOperationStatus(PHONE, { ...deps, now: T0 })
    ]);

    expect(chain.calls.statusOf).toBe(1);
    expect(chain.calls.tip).toBe(1);
  });

  it('keeps the operation pending on a 429 and backs off', async () => {
    const accountId = await seedAccount(PHONE);
    const operationId = await seedSubmittedVote(accountId);
    const chain = scriptedChain();
    chain.status = new CardanoProviderError('rate_limited', 'CARDANO_PROVIDER_429', false, 429);
    const { base } = providersFor(chain);

    const due = await reconcileWhenDue(operationId, base, INTERVAL_MS, T0);

    expect(due.outcome).toBe('undetermined');
    const stored = await CardanoStakingOperation.findById(operationId).lean();
    expect(stored?.status).toBe('submitted');
    expect(stored?.chainOutcome).toBe('pending');
    expect(stored?.absentObservations).toBe(0);
    expect(stored?.reconcileFailures).toBe(1);
    expect(stored?.nextCheckAt?.getTime()).toBe(T0.getTime() + 2 * INTERVAL_MS);
  });

  it('keeps the operation pending when the tip times out', async () => {
    const accountId = await seedAccount(PHONE);
    const operationId = await seedSubmittedVote(accountId);
    const chain = scriptedChain();
    chain.tipFails = true;
    const { base } = providersFor(chain);

    const due = await reconcileWhenDue(operationId, base, INTERVAL_MS, T0);

    expect(due.outcome).toBe('undetermined');
    expect(chain.calls.statusOf).toBe(0);
    const stored = await CardanoStakingOperation.findById(operationId).lean();
    expect(stored?.status).toBe('submitted');
  });

  it('does not conclude absence from repeated readings while the chain does not advance', async () => {
    const accountId = await seedAccount(PHONE);
    const operationId = await seedSubmittedVote(accountId);
    const chain = scriptedChain();
    chain.slot = TTL_SLOT + 601;
    const { base } = providersFor(chain);

    for (let reading = 0; reading < 6; reading += 1) {
      const due = await reconcileWhenDue(operationId, base, INTERVAL_MS, at(reading * 31));
      expect(due.outcome).toBe('still_pending');
    }

    const stored = await CardanoStakingOperation.findById(operationId).lean();
    expect(stored?.status).toBe('submitted');
  });

  it('concludes absence only after three readings spread over 600 slots', async () => {
    const accountId = await seedAccount(PHONE);
    const operationId = await seedSubmittedVote(accountId);
    const chain = scriptedChain();
    const { base } = providersFor(chain);
    const outcomes: string[] = [];

    for (const [index, offset] of [601, 700, 1300].entries()) {
      chain.slot = TTL_SLOT + offset;
      const due = await reconcileWhenDue(operationId, base, INTERVAL_MS, at(index * 31));
      outcomes.push(due.outcome ?? 'none');
    }

    expect(outcomes).toEqual(['still_pending', 'still_pending', 'absent_past_ttl']);
    const stored = await CardanoStakingOperation.findById(operationId).lean();
    expect(stored?.status).toBe('expired_unconfirmed');
  });

  it("does not look at another user's operation", async () => {
    await seedAccount(PHONE);
    const otherAccount = await seedAccount(OTHER_PHONE);
    const otherOperation = await seedSubmittedVote(otherAccount);
    const chain = scriptedChain();

    await getStakingOperationStatus(PHONE, { ...providersFor(chain), now: T0 });

    expect(chain.calls.statusOf).toBe(0);
    const stored = await CardanoStakingOperation.findById(otherOperation).lean();
    expect(stored?.lastReconcileAttemptAt).toBeNull();
  });

  it('ignores an operation of the same user on another network', async () => {
    await seedAccount(PHONE);
    const mainnetAccount = await seedAccount(PHONE, 900_764_824_073);
    await seedSubmittedVote(mainnetAccount);
    const chain = scriptedChain();

    await getStakingOperationStatus(PHONE, { ...providersFor(chain), now: T0 });

    expect(chain.calls.statusOf).toBe(0);
  });

  it('spends no provider request when nothing is live', async () => {
    await seedAccount(PHONE);
    const chain = scriptedChain();

    const result = await getStakingOperationStatus(PHONE, { ...providersFor(chain), now: T0 });

    expect(result.ok).toBe(true);
    expect(chain.calls).toEqual({ tip: 0, statusOf: 0, stakeAccount: 0, rewardHistory: 0 });
  });

  it('shows a queued operation without asking the chain about it', async () => {
    const accountId = await seedAccount(PHONE);
    await CardanoStakingOperation.create({
      accountId,
      chainId: CHAIN_ID,
      lifecycleId: 'cycle',
      kind: 'withdraw_rewards',
      actor: 'cron',
      idempotencyKey: 'queued-op',
      status: 'queued'
    });
    const chain = scriptedChain();

    const result = await getStakingOperationStatus(PHONE, { ...providersFor(chain), now: T0 });

    expect(result.ok && result.data.operation?.status).toBe('queued');
    expect(chain.calls.statusOf).toBe(0);
  });
});

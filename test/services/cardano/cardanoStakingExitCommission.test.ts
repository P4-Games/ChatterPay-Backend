import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import CardanoStakingAccount from '../../../src/models/cardanoStakingAccountModel';
import CardanoStakingOperation from '../../../src/models/cardanoStakingOperationModel';
import { UserModel } from '../../../src/models/userModel';
import {
  rewardAddress,
  stakeCredentialHex
} from '../../../src/services/cardano/cardanoAddressService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import { signBffAssertion } from '../../../src/services/cardano/cardanoStakingAssertionService';
import { STRANDED_UNSIGNED_OPERATION_MS } from '../../../src/services/cardano/cardanoStakingLifecycleService';
import {
  getStakingView,
  quoteStakingExit,
  requestStakingAction,
  settleLiveOperation,
  USER_REQUESTABLE_ACTIONS
} from '../../../src/services/cardano/cardanoStakingUserService';
import { enableCardanoPreprod, setCardanoFeeEnv } from '../../support/cardanoEnv';
import { seedStakingNetwork } from '../../support/cardanoStakingNetwork';

/**
 * The commercial fee an exit is quoted and the one it is built with, the recovery the user paths run
 * before deciding, and what they decide when an operation under review holds the account.
 *
 * The request path is driven for real up to the assembly, which is where the fee enters the
 * transaction. The collaborators past that point — the providers, the signer check, the decision and
 * the assembler — are replaced so the case can read what the assembler was given without a chain.
 */

const captured = vi.hoisted(() => ({
  assembly: [] as Record<string, unknown>[],
  decisions: [] as { operationInFlight: boolean }[]
}));

vi.mock('../../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  const { cardanoConstantsMock } = await import('../../support/cardanoEnv');
  return Object.defineProperties(cardanoConstantsMock(actual), {
    CARDANO_STAKING_FRONTEND_BFF_SECRET: {
      get: () => 'a-shared-secret-between-the-bff-and-the-backend',
      enumerable: true
    },
    SECURITY_PIN_ENABLED: { get: () => false, enumerable: true }
  });
});

vi.mock('../../../src/services/cardano/cardanoProviderService', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/cardano/cardanoProviderService')>();
  return {
    ...actual,
    buildCardanoProvider: () => ({
      tip: async () => ({ slot: 90_000, height: 1_000 }),
      utxosFor: async () => [],
      submit: async () => {
        throw new Error('never submits');
      }
    })
  };
});

vi.mock('../../../src/services/cardano/cardanoStakingProviderService', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/services/cardano/cardanoStakingProviderService')
    >();
  return {
    ...actual,
    buildStakingProvider: () => ({
      stakingProtocolParameters: async () => ({
        minFeeA: 44,
        minFeeB: 155_381,
        coinsPerUtxoByte: 4_310n,
        maxTxSize: 16_384,
        stakeAddressDeposit: 2_000_000n,
        drepDeposit: 500_000_000n
      }),
      poolState: async () => null
    })
  };
});

vi.mock('../../../src/services/cardano/cardanoStakingSignerService', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/services/cardano/cardanoStakingSignerService')
    >();
  return {
    ...actual,
    stakingSignerFor: () => ({
      available: true,
      material: { user: { addressBytes: new Uint8Array() } }
    })
  };
});

vi.mock('../../../src/services/cardano/cardanoStakingPlanService', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/services/cardano/cardanoStakingPlanService')
    >();
  return {
    ...actual,
    decideRequestedAction: (
      _account: unknown,
      action: string,
      context: { operationInFlight: boolean }
    ) => {
      captured.decisions.push({ operationInFlight: context.operationInFlight });
      return context.operationInFlight
        ? { action: 'none', refusal: 'operation_in_flight', detail: null }
        : { action, refusal: null, detail: null };
    }
  };
});

vi.mock('../../../src/services/cardano/cardanoStakingAssemblyService', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/services/cardano/cardanoStakingAssemblyService')
    >();
  return {
    ...actual,
    assembleStakingPlan: async (request: Record<string, unknown>) => {
      captured.assembly.push(request);
      return { outcome: 'refused', refusal: 'stopped_by_test', detail: 'nothing is built here' };
    }
  };
});

const PHONE = '5491133334444';
/** Another wallet of this suite, so the destination is a well-formed testnet address. */
const RECIPIENT = cardanoSignerService.getAccount(
  '5491155556666',
  'testnet',
  CARDANO_PREPROD_CHAIN_ID
).address;

/**
 * A user whose staking account is registered and read.
 *
 * @returns The account id.
 */
async function seedAccount(): Promise<Types.ObjectId> {
  const derived = cardanoSignerService.getAccount(PHONE, 'testnet', CARDANO_PREPROD_CHAIN_ID);
  const user = await UserModel.create({
    phone_number: PHONE,
    name: `user-${PHONE}`,
    wallets: [],
    settings: {}
  });
  const account = await CardanoStakingAccount.create({
    userId: user._id,
    chainId: CARDANO_PREPROD_CHAIN_ID,
    walletAddress: derived.address,
    rewardAddress: rewardAddress(derived.stakePublicKey, 'testnet'),
    stakeCredentialHex: stakeCredentialHex(derived.stakePublicKey),
    currentLifecycleId: 'cycle-1',
    state: 'active',
    onChain: {
      registered: true,
      poolId: 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx',
      governanceDelegation: { kind: 'always_abstain' },
      depositLovelace: '2000000',
      asOf: new Date()
    }
  });
  return account._id as Types.ObjectId;
}

/**
 * Asks for an action the way the route does, with a valid BFF assertion.
 *
 * @param action - The action.
 * @param recipient - Where an exit sends.
 * @returns What the service answered.
 */
function ask(
  action: 'exit_and_send_max' | 'withdraw_rewards' | 'deregister',
  recipient: string | null
) {
  return requestStakingAction(PHONE, action, {
    actor: 'web',
    recipientAddress: recipient,
    bffAssertion: signBffAssertion(PHONE, action, recipient, null)
  });
}

/**
 * An operation on the account that never got past the build, last written long enough ago to
 * count as stranded.
 *
 * @param accountId - Whose.
 * @returns The operation id.
 */
async function seedStrandedOperation(accountId: Types.ObjectId): Promise<Types.ObjectId> {
  const operation = await CardanoStakingOperation.create({
    accountId,
    chainId: CARDANO_PREPROD_CHAIN_ID,
    lifecycleId: 'cycle-1',
    kind: 'exit_and_send_max',
    actor: 'web',
    idempotencyKey: `stranded-${accountId.toHexString()}`,
    errorCode: 'budget:insufficient_budget'
  });
  await CardanoStakingOperation.collection.updateOne(
    { _id: operation._id as Types.ObjectId },
    { $set: { updatedAt: new Date(Date.now() - STRANDED_UNSIGNED_OPERATION_MS - 60_000) } }
  );
  return operation._id as Types.ObjectId;
}

beforeEach(async () => {
  enableCardanoPreprod();
  setCardanoFeeEnv({ feeScheme: 2, transferFeeAda: 0.5, transferFeeUsd: null });
  captured.assembly.length = 0;
  captured.decisions.length = 0;
  await CardanoStakingAccount.deleteMany({});
  await CardanoStakingOperation.deleteMany({});
  await CardanoStakingOperation.syncIndexes();
  await UserModel.deleteMany({});
  await seedStakingNetwork({ termsVersion: 'dev-v1' });
});

describe('the commercial fee on an exit', () => {
  it('is built into the exit, not only into the quote', async () => {
    await seedAccount();

    await ask('exit_and_send_max', RECIPIENT);

    expect(captured.assembly).toHaveLength(1);
    expect(captured.assembly[0].commercialFeeLovelace).toBe(500_000n);
  });

  it('is the same figure the quote showed', async () => {
    await seedAccount();

    await quoteStakingExit(PHONE, RECIPIENT);
    await ask('exit_and_send_max', RECIPIENT);

    expect(captured.assembly).toHaveLength(2);
    expect(captured.assembly[0].commercialFeeLovelace).toBe(500_000n);
    expect(captured.assembly[1].commercialFeeLovelace).toBe(
      captured.assembly[0].commercialFeeLovelace
    );
  });

  it('is zero in both when the deployment charges no transfer fee', async () => {
    setCardanoFeeEnv({ transferFeeAda: 0 });
    await seedAccount();

    await quoteStakingExit(PHONE, RECIPIENT);
    await ask('exit_and_send_max', RECIPIENT);

    expect(captured.assembly.map((request) => request.commercialFeeLovelace)).toEqual([0n, 0n]);
  });

  it('is not charged on anything but an exit that sends everything', async () => {
    await seedAccount();

    await ask('withdraw_rewards', null);
    await ask('deregister', null);

    expect(captured.assembly).toHaveLength(2);
    for (const request of captured.assembly) {
      expect(request).not.toHaveProperty('commercialFeeLovelace');
    }
  });
});

describe('an unsigned operation left behind', () => {
  it('no longer refuses an exit', async () => {
    const accountId = await seedAccount();
    const stranded = await seedStrandedOperation(accountId);

    await ask('exit_and_send_max', RECIPIENT);

    expect(captured.decisions).toEqual([{ operationInFlight: false }]);
    const stored = await CardanoStakingOperation.findById(stranded);
    expect(stored?.status).toBe('cancelled');
    expect(stored?.liveness).toBe('settled');
  });

  it('no longer refuses an exit quote', async () => {
    const accountId = await seedAccount();
    await seedStrandedOperation(accountId);

    await quoteStakingExit(PHONE, RECIPIENT);

    expect(captured.decisions).toEqual([{ operationInFlight: false }]);
  });

  it('is cancelled when the staking screen settles the account', async () => {
    const accountId = await seedAccount();
    const stranded = await seedStrandedOperation(accountId);
    const account = await CardanoStakingAccount.findById(accountId);

    const changed = await settleLiveOperation(
      account!,
      30_000,
      {
        tip: async () => {
          throw new Error('nothing to look up');
        },
        statusOf: async () => {
          throw new Error('nothing to look up');
        }
      },
      {
        stakeAccount: async () => {
          throw new Error('not read');
        },
        rewardHistory: async () => {
          throw new Error('not read');
        },
        registrationHistory: async () => {
          throw new Error('not read');
        }
      }
    );

    expect(changed).toBe(true);
    expect((await CardanoStakingOperation.findById(stranded))?.status).toBe('cancelled');
  });

  it('still refuses while the operation may be executing', async () => {
    const accountId = await seedAccount();
    await CardanoStakingOperation.create({
      accountId,
      chainId: CARDANO_PREPROD_CHAIN_ID,
      lifecycleId: 'cycle-1',
      kind: 'withdraw_rewards',
      actor: 'web',
      idempotencyKey: `fresh-${accountId.toHexString()}`
    });

    const result = await ask('exit_and_send_max', RECIPIENT);

    expect(captured.decisions).toEqual([{ operationInFlight: true }]);
    expect(result).toMatchObject({ ok: false, refusal: 'refused' });
    expect(captured.assembly).toHaveLength(0);
  });

  it('does not touch another account', async () => {
    await seedAccount();
    const elsewhere = await seedStrandedOperation(new Types.ObjectId());

    await ask('exit_and_send_max', RECIPIENT);

    expect((await CardanoStakingOperation.findById(elsewhere))?.status).toBe('queued');
  });
});

describe('an operation under review', () => {
  /**
   * An operation an operator has to look at, as a build refusal or a suspected rollback leaves it.
   *
   * @param accountId - Whose.
   * @param chainOutcome - `none` for a build refusal, `unknown` for a suspected rollback.
   * @returns The operation id.
   */
  async function seedReview(
    accountId: Types.ObjectId,
    chainOutcome: 'none' | 'unknown'
  ): Promise<Types.ObjectId> {
    const operation = await CardanoStakingOperation.create({
      accountId,
      chainId: CARDANO_PREPROD_CHAIN_ID,
      lifecycleId: 'cycle-1',
      kind: 'withdraw_rewards',
      actor: 'web',
      idempotencyKey: `review-${accountId.toHexString()}`,
      status: 'manual_review',
      chainOutcome,
      errorCode: 'CARDANO_INSUFFICIENT_SPONSOR_FUNDS'
    });
    return operation._id as Types.ObjectId;
  }

  for (const chainOutcome of ['none', 'unknown'] as const) {
    describe(`with chain outcome ${chainOutcome}`, () => {
      it('refuses an exit before writing anything, instead of failing on the index', async () => {
        const accountId = await seedAccount();
        await seedReview(accountId, chainOutcome);

        const result = await ask('exit_and_send_max', RECIPIENT);

        expect(result).toMatchObject({ ok: false, refusal: 'refused' });
        expect(result.ok === false && result.detail).toContain('operation_in_flight');
        expect(captured.decisions).toEqual([{ operationInFlight: true }]);
        expect(captured.assembly).toHaveLength(0);
        // The opt-out is written ahead of the operation. Reaching it here would leave the wallet
        // marked as out with no exit behind it.
        expect((await CardanoStakingAccount.findById(accountId))?.optOut).toBeNull();
        expect(await CardanoStakingOperation.countDocuments({ accountId })).toBe(1);
      });

      it('refuses every other action the same way', async () => {
        const accountId = await seedAccount();
        await seedReview(accountId, chainOutcome);

        for (const action of ['withdraw_rewards', 'deregister'] as const) {
          const result = await ask(action, null);
          expect(result, action).toMatchObject({ ok: false, refusal: 'refused' });
        }
        expect(captured.assembly).toHaveLength(0);
      });

      it('refuses the exit quote', async () => {
        const accountId = await seedAccount();
        await seedReview(accountId, chainOutcome);

        const result = await quoteStakingExit(PHONE, RECIPIENT);

        expect(result).toMatchObject({ ok: false, refusal: 'refused' });
        expect(captured.decisions).toEqual([{ operationInFlight: true }]);
      });

      it('shows no action as available on the staking screen', async () => {
        const accountId = await seedAccount();
        await seedReview(accountId, chainOutcome);

        const view = await getStakingView(PHONE);

        expect(view.ok).toBe(true);
        expect(captured.decisions).toHaveLength(USER_REQUESTABLE_ACTIONS.length);
        expect(captured.decisions.every((decision) => decision.operationInFlight)).toBe(true);
        if (view.ok) {
          expect(view.data.state).toBe('manual_review');
          for (const action of USER_REQUESTABLE_ACTIONS) {
            expect(view.data.actions[action], action).toBe('operation_in_flight');
          }
        }
      });
    });
  }

  it('does not hold an account whose operation was settled', async () => {
    const accountId = await seedAccount();
    await CardanoStakingOperation.create({
      accountId,
      chainId: CARDANO_PREPROD_CHAIN_ID,
      lifecycleId: 'cycle-1',
      kind: 'withdraw_rewards',
      actor: 'web',
      idempotencyKey: `settled-${accountId.toHexString()}`,
      status: 'confirmed',
      chainOutcome: 'confirmed'
    });

    await ask('exit_and_send_max', RECIPIENT);

    expect(captured.decisions).toEqual([{ operationInFlight: false }]);
  });
});

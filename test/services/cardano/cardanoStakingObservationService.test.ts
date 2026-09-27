import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import CardanoStakingAccount from '../../../src/models/cardanoStakingAccountModel';
import CardanoStakingGovernanceEvent from '../../../src/models/cardanoStakingGovernanceEventModel';
import CardanoStakingOperation from '../../../src/models/cardanoStakingOperationModel';
import CardanoStakingReward from '../../../src/models/cardanoStakingRewardModel';
import { CardanoProviderError } from '../../../src/services/cardano/cardanoProviderService';
import {
  observeStakingAccount,
  type StakingObservationProvider
} from '../../../src/services/cardano/cardanoStakingObservationService';
import type {
  CardanoRegistrationRecord,
  CardanoStakeAccountState
} from '../../../src/services/cardano/cardanoStakingProviderService';

const CHAIN_ID = 900000000001;
const REWARD = 'stake_test1up4xwpa29a3e6wcu6z4yj4ll3xkd38jy0ftmd53vprnguuq32mvx6';
const POOL = 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx';
const DREP = 'drep1ytcw6qzpqqclx2yd0zy64ztvlkkhnf6yrzza8whgnq4vz5gh89626';

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
    governanceDelegation: { kind: 'none' },
    withdrawableRewardsLovelace: 8_183_734n,
    lifetimeRewardsLovelace: 8_183_734n,
    withdrawnLovelace: 0n,
    depositLovelace: null,
    ...overrides
  };
}

/**
 * A provider answering from fixed data.
 *
 * @param state - What the stake account read returns.
 * @param credits - Reward credits, as epoch/amount pairs.
 * @param registrations - The registration history.
 * @returns The provider.
 */
function providerFor(
  state: CardanoStakeAccountState,
  credits: { epoch: number; amount: bigint }[] = [],
  registrations: CardanoRegistrationRecord[] = []
): StakingObservationProvider {
  return {
    stakeAccount: async () => state,
    rewardHistory: async () => ({
      credits: credits.map((credit) => ({
        epoch: credit.epoch,
        amountLovelace: credit.amount,
        sourceType: 'member',
        sourceKey: `member:${POOL}:${credit.epoch}`
      })),
      completeness: 'complete' as const
    }),
    registrationHistory: async () => registrations
  };
}

/**
 * Creates the account being observed.
 *
 * @param overrides - Fields that differ.
 * @returns The stored account.
 */
async function seedAccount(overrides: Record<string, unknown> = {}) {
  return CardanoStakingAccount.create({
    userId: new Types.ObjectId(),
    chainId: CHAIN_ID,
    walletAddress:
      'addr_test1qrgnz9z5drgvfs5nzgrem3rkqae4sjvy3efnlulyecuqn8n2vur65tmrn5a3e592f9tllzdvmz0yg7jhkmfzcz8x3ecqug792f',
    rewardAddress: REWARD,
    stakeCredentialHex: '6a6707aa2f639d3b1cd0aa4957ff89acd89e447a57b6d22c08e68e70',
    ...overrides
  });
}

describe('cardanoStakingObservationService', () => {
  beforeEach(async () => {
    await CardanoStakingAccount.deleteMany({});
    await CardanoStakingAccount.syncIndexes();
    await CardanoStakingOperation.deleteMany({});
    await CardanoStakingOperation.syncIndexes();
    await CardanoStakingReward.deleteMany({});
    await CardanoStakingReward.syncIndexes();
    await CardanoStakingGovernanceEvent.deleteMany({});
    await CardanoStakingGovernanceEvent.syncIndexes();
  });

  describe('a wallet that was already staking before ChatterPay looked', () => {
    it('records the registration as somebody else’s', async () => {
      // On Cardano the credential belongs to the key. A user who delegated in a browser wallet a
      // year ago arrives registered, and none of it was this service's doing.
      const account = await seedAccount();

      const observation = await observeStakingAccount(account, providerFor(chainState()));

      expect(observation.outcome).toBe('observed');
      expect(observation.externallyRegistered).toBe(true);
      const stored = await CardanoStakingAccount.findById(account._id);
      expect(stored?.onChain.registrationOrigin).toBe('external');
      expect(stored?.onChain.registered).toBe(true);
      expect(stored?.onChain.poolId).toBe(POOL);
    });

    it('invents no deposit event for a deposit it never paid', async () => {
      // `cardano_staking_deposit_events` is the record of deposits this service moved. A row here
      // would put a payment in its ledger that never passed through it.
      const account = await seedAccount();

      await observeStakingAccount(account, providerFor(chainState()));

      expect(await CardanoStakingOperation.countDocuments({})).toBe(0);
    });

    it('reads the real deposit off the registration history', async () => {
      // The figure an exit has to refund, and the only place it exists for a credential this
      // service did not register. Not today's protocol parameter: that can have moved since.
      const account = await seedAccount();
      const provider = providerFor(
        chainState(),
        [],
        [
          {
            action: 'registered',
            txHash: 'a3'.repeat(32),
            depositLovelace: 2_000_000n,
            slot: 131_485_961
          }
        ]
      );

      await observeStakingAccount(account, provider);

      expect((await CardanoStakingAccount.findById(account._id))?.onChain.depositLovelace).toBe(
        '2000000'
      );
    });

    it('takes the deposit of the registration in force, not the first one ever', async () => {
      // Registered, exited, registered again. The second registration is what is locked now, and
      // refunding the first one's figure would fail to balance.
      const account = await seedAccount();
      const provider = providerFor(
        chainState(),
        [],
        [
          { action: 'registered', txHash: 'aa'.repeat(32), depositLovelace: 2_000_000n, slot: 100 },
          { action: 'deregistered', txHash: 'bb'.repeat(32), depositLovelace: null, slot: 200 },
          { action: 'registered', txHash: 'cc'.repeat(32), depositLovelace: 4_000_000n, slot: 300 }
        ]
      );

      await observeStakingAccount(account, provider);

      expect((await CardanoStakingAccount.findById(account._id))?.onChain.depositLovelace).toBe(
        '4000000'
      );
    });

    it('leaves the deposit unknown rather than guessing one', async () => {
      // An exit built on a guessed refund does not balance, and the ledger refuses it after a
      // sponsor fee has already been spent. Unknown blocks the exit, which is the better failure.
      const account = await seedAccount();

      await observeStakingAccount(account, providerFor(chainState(), [], []));

      expect(
        (await CardanoStakingAccount.findById(account._id))?.onChain.depositLovelace
      ).toBeNull();
    });

    it('calls the registration ours when a confirmed registration of ours exists', async () => {
      const account = await seedAccount();
      await CardanoStakingOperation.create({
        accountId: account._id,
        chainId: CHAIN_ID,
        lifecycleId: 'cycle-1',
        kind: 'register_and_delegate',
        actor: 'cron',
        idempotencyKey: 'ours-1',
        status: 'confirmed',
        chainOutcome: 'confirmed',
        actualRegistrationDepositLovelace: '2000000'
      });

      const observation = await observeStakingAccount(account, providerFor(chainState()));

      expect(observation.externallyRegistered).toBe(false);
      const stored = await CardanoStakingAccount.findById(account._id);
      expect(stored?.onChain.registrationOrigin).toBe('chatterpay');
      expect(stored?.onChain.depositLovelace).toBe('2000000');
    });

    it('does not revise the origin on a later pass', async () => {
      // The question is about a past event and the answer does not change. Re-deciding it every
      // sync would let a temporarily unreadable operation history reattribute a user's deposit.
      const account = await seedAccount();
      await observeStakingAccount(account, providerFor(chainState()));
      await CardanoStakingOperation.create({
        accountId: account._id,
        chainId: CHAIN_ID,
        lifecycleId: 'cycle-1',
        kind: 'register_and_delegate',
        actor: 'cron',
        idempotencyKey: 'late-1',
        status: 'confirmed',
        chainOutcome: 'confirmed'
      });

      const again = await CardanoStakingAccount.findById(account._id);
      await observeStakingAccount(again!, providerFor(chainState()));

      expect((await CardanoStakingAccount.findById(account._id))?.onChain.registrationOrigin).toBe(
        'external'
      );
    });
  });

  describe('rewards', () => {
    it('writes each credit once, however many times it is read', async () => {
      const account = await seedAccount();
      const credits = [
        { epoch: 310, amount: 2_203_610n },
        { epoch: 311, amount: 1_834_986n },
        { epoch: 312, amount: 2_040_456n },
        { epoch: 313, amount: 2_104_682n }
      ];

      const first = await observeStakingAccount(account, providerFor(chainState(), credits));
      const reread = await CardanoStakingAccount.findById(account._id);
      const second = await observeStakingAccount(reread!, providerFor(chainState(), credits));

      expect(first.newRewardCredits).toBe(4);
      expect(second.newRewardCredits).toBe(0);
      expect(await CardanoStakingReward.countDocuments({})).toBe(4);
    });

    it('sums to the withdrawable balance the account snapshot carries', async () => {
      const account = await seedAccount();
      const credits = [
        { epoch: 310, amount: 2_203_610n },
        { epoch: 311, amount: 1_834_986n },
        { epoch: 312, amount: 2_040_456n },
        { epoch: 313, amount: 2_104_682n }
      ];

      await observeStakingAccount(account, providerFor(chainState(), credits));

      const stored = await CardanoStakingReward.find({});
      const total = stored.reduce((sum, row) => sum + BigInt(row.amountLovelace), 0n);
      expect(total).toBe(8_183_734n);
      expect(
        (await CardanoStakingAccount.findById(account._id))?.onChain.withdrawableRewardsLovelace
      ).toBe('8183734');
    });

    it('reports a partial history when the credits cannot be read', async () => {
      // The withdrawable balance comes from the account snapshot and is unaffected; what is lost is
      // the record of what was earned, and saying so is better than presenting it as whole.
      const account = await seedAccount();
      const provider: StakingObservationProvider = {
        stakeAccount: async () => chainState(),
        rewardHistory: async () => {
          throw new CardanoProviderError('provider_unavailable', 'down');
        },
        registrationHistory: async () => []
      };

      await observeStakingAccount(account, provider);

      expect(
        (await CardanoStakingAccount.findById(account._id))?.onChain.historicalCompleteness
      ).toBe('partial');
    });
  });

  describe('a provider that cannot answer', () => {
    it('writes no snapshot at all, and above all no zeroes', async () => {
      const account = await seedAccount({
        onChain: {
          registered: true,
          poolId: POOL,
          withdrawableRewardsLovelace: '8183734',
          depositLovelace: '2000000',
          asOf: new Date('2026-09-01T00:00:00Z')
        }
      });
      const provider: StakingObservationProvider = {
        stakeAccount: async () => {
          throw new CardanoProviderError('timeout', 'no answer');
        },
        rewardHistory: async () => ({ credits: [], completeness: 'complete' }),
        registrationHistory: async () => []
      };

      const observation = await observeStakingAccount(account, provider);

      expect(observation.outcome).toBe('unavailable');
      const stored = await CardanoStakingAccount.findById(account._id);
      expect(stored?.onChain.withdrawableRewardsLovelace).toBe('8183734');
      expect(stored?.onChain.depositLovelace).toBe('2000000');
      // The field every economic guard reads. A failed read must not look like a fresh one.
      expect(stored?.onChain.asOf?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
      expect(stored?.lastError).toBe('observe:timeout');
    });
  });

  describe('governance', () => {
    it('logs a delegation the user made somewhere else, as observed rather than requested', async () => {
      const account = await seedAccount();

      await observeStakingAccount(
        account,
        providerFor(chainState({ governanceDelegation: { kind: 'drep', idCip129: DREP } }))
      );

      const events = await CardanoStakingGovernanceEvent.find({});
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('drep');
      expect(events[0]?.actor).toBe('chain');
      // No operation produced it, and borrowing an id would make the trail claim otherwise.
      expect(events[0]?.operationId).toBeNull();
    });

    it('logs nothing when the delegation has not moved', async () => {
      const account = await seedAccount();
      const state = chainState({ governanceDelegation: { kind: 'always_abstain' } });
      await observeStakingAccount(account, providerFor(state));

      const reread = await CardanoStakingAccount.findById(account._id);
      await observeStakingAccount(reread!, providerFor(state));

      expect(await CardanoStakingGovernanceEvent.countDocuments({})).toBe(1);
    });

    it('does not read a change into two spellings of the same DRep', async () => {
      // Providers disagree on the spelling. A text comparison would log a change on every sync.
      const account = await seedAccount();
      await observeStakingAccount(
        account,
        providerFor(chainState({ governanceDelegation: { kind: 'drep', idCip129: DREP } }))
      );

      const reread = await CardanoStakingAccount.findById(account._id);
      await observeStakingAccount(
        reread!,
        providerFor(
          chainState({
            governanceDelegation: {
              kind: 'drep',
              idCip129: DREP,
              idLegacy: 'drep_vkh1qgdncn27dacgry4rknzadelcpydzk0zdtehhpqvj5w6v2ygjqrg'
            }
          })
        )
      );

      expect(await CardanoStakingGovernanceEvent.countDocuments({})).toBe(1);
    });

    it('records more than one externally-made change over time', async () => {
      // The audit index used to admit a single null operation id across the whole collection, which
      // would have let the first observed delegation ever recorded block every other one.
      const account = await seedAccount();
      await observeStakingAccount(
        account,
        providerFor(chainState({ governanceDelegation: { kind: 'always_abstain' } }))
      );
      const second = await CardanoStakingAccount.findById(account._id);
      await observeStakingAccount(
        second!,
        providerFor(chainState({ governanceDelegation: { kind: 'drep', idCip129: DREP } }))
      );
      const third = await CardanoStakingAccount.findById(account._id);
      await observeStakingAccount(
        third!,
        providerFor(chainState({ governanceDelegation: { kind: 'always_no_confidence' } }))
      );

      const events = await CardanoStakingGovernanceEvent.find({}).sort({ requestedAt: 1 });
      expect(events.map((event) => event.kind)).toEqual([
        'always_abstain',
        'drep',
        'always_no_confidence'
      ]);
      expect(events[2]?.previousKind).toBe('drep');
    });

    it('keeps an unregistered credential out of the delegated states', async () => {
      const account = await seedAccount();

      await observeStakingAccount(
        account,
        providerFor(
          chainState({
            registered: false,
            poolId: null,
            governanceDelegation: { kind: 'not_registered' },
            withdrawableRewardsLovelace: 0n
          })
        )
      );

      const stored = await CardanoStakingAccount.findById(account._id);
      expect(stored?.onChain.registered).toBe(false);
      expect(stored?.onChain.registrationOrigin).toBe('unknown');
      expect(stored?.onChain.depositLovelace).toBeNull();
    });
  });
});

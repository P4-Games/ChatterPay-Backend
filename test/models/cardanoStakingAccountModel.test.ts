import { Types } from 'mongoose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import CardanoStakingAccount, {
  type ICardanoStakingAccount
} from '../../src/models/cardanoStakingAccountModel';

const CHAIN_ID = 900000000001;
const CREDENTIAL = 'ce3b525279e269bac5368d404508d9fa9c527bda6eadbf639fed1767';

function account(overrides: Partial<ICardanoStakingAccount> = {}): Partial<ICardanoStakingAccount> {
  return {
    userId: new Types.ObjectId(),
    chainId: CHAIN_ID,
    walletAddress: 'addr_test1qzasn8g8wgz5elr7a2jwcpvy9jdpzddy4vc5xtqpkrl53xw',
    rewardAddress: 'stake_test1uqwv9u9kpmjufmdhhnzxgyrc05uf2wwdmadkfuqpyvztj8d',
    stakeCredentialHex: CREDENTIAL,
    ...overrides
  };
}

describe('cardano_staking_accounts', () => {
  beforeAll(async () => {
    await CardanoStakingAccount.syncIndexes();
  });

  beforeEach(async () => {
    await CardanoStakingAccount.deleteMany({});
  });

  describe('uniqueness', () => {
    it('allows one account per wallet per network', async () => {
      const userId = new Types.ObjectId();
      await CardanoStakingAccount.create(account({ userId }));

      await expect(
        CardanoStakingAccount.create(
          account({ userId, stakeCredentialHex: `${CREDENTIAL.slice(0, -2)}ff` })
        )
      ).rejects.toThrow();
    });

    it('refuses two accounts sharing a stake credential on the same network', async () => {
      // Both would claim the same deposit and both would try to register it.
      await CardanoStakingAccount.create(account());

      await expect(CardanoStakingAccount.create(account())).rejects.toThrow();
    });

    it('keeps networks isolated', async () => {
      await CardanoStakingAccount.create(account());

      const other = await CardanoStakingAccount.create(account({ chainId: 900764824073 }));

      expect(other.chainId).toBe(900764824073);
    });
  });

  describe('defaults', () => {
    it('starts opted out, unconsented and off chain', async () => {
      const created = await CardanoStakingAccount.create(account());

      expect(created.preference.enabled).toBe(false);
      expect(created.preference.version).toBe(0);
      expect(created.termsConsent).toBeNull();
      expect(created.state).toBe('awaiting_consent');
      expect(created.onChain.registered).toBe(false);
      expect(created.onChain.depositLovelace).toBeNull();
      expect(created.financingMode).toBeNull();
    });

    it('owns the deposit as the user, under Plan B', async () => {
      const created = await CardanoStakingAccount.create(account());

      expect(created.depositEconomicOwner).toBe('user');
    });

    it('starts reward buckets at zero and history as partial', async () => {
      const created = await CardanoStakingAccount.create(account());

      expect(created.onChain.withdrawableRewardsLovelace).toBe('0');
      expect(created.onChain.pendingRewardsLovelace).toBe('0');
      expect(created.onChain.lifetimeRewardsLovelace).toBe('0');
      // Claiming a complete history nobody rebuilt would present a partial total as final.
      expect(created.onChain.historicalCompleteness).toBe('partial');
      expect(created.onChain.asOf).toBeNull();
    });
  });

  describe('governance delegation', () => {
    it('keeps the credential type alongside the hash', async () => {
      const created = await CardanoStakingAccount.create(
        account({
          onChain: {
            registered: true,
            poolId: 'pool1abc',
            governanceDelegation: {
              kind: 'drep',
              credential: { type: 'script_hash', hashHex: CREDENTIAL },
              idCip129: 'drep1script',
              idLegacy: null,
              drepStatus: 'active'
            },
            depositLovelace: '2000000',
            withdrawableRewardsLovelace: '0',
            pendingRewardsLovelace: '0',
            lifetimeRewardsLovelace: '0',
            historicalCompleteness: 'complete',
            asOf: new Date()
          }
        } as Partial<ICardanoStakingAccount>)
      );

      // Two DReps can share a hash and differ in type, so the hash alone does not identify one.
      expect(created.onChain.governanceDelegation?.credential?.type).toBe('script_hash');
    });

    it.each([
      'always_abstain',
      'always_no_confidence',
      'none',
      'not_registered'
    ] as const)('stores %s without a credential', async (kind) => {
      const created = await CardanoStakingAccount.create(
        account({
          onChain: {
            registered: kind !== 'not_registered',
            poolId: null,
            governanceDelegation: { kind },
            depositLovelace: null,
            withdrawableRewardsLovelace: '0',
            pendingRewardsLovelace: '0',
            lifetimeRewardsLovelace: '0',
            historicalCompleteness: 'partial',
            asOf: new Date()
          }
        } as Partial<ICardanoStakingAccount>)
      );

      expect(created.onChain.governanceDelegation?.kind).toBe(kind);
      expect(created.onChain.governanceDelegation?.credential).toBeUndefined();
    });
  });

  describe('lovelace precision', () => {
    it('round-trips an amount past the exact-integer limit of a float', async () => {
      const exact = '9007199254740993';
      const created = await CardanoStakingAccount.create(account());

      created.onChain.withdrawableRewardsLovelace = exact;
      await created.save();

      const read = await CardanoStakingAccount.findById(created._id);
      expect(read?.onChain.withdrawableRewardsLovelace).toBe(exact);
      expect(BigInt(read?.onChain.withdrawableRewardsLovelace ?? '0')).toBe(BigInt(exact));
    });
  });
});

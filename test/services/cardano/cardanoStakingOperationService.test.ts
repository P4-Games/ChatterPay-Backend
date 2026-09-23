import mongoose, { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import CardanoStakingAccount, {
  type ICardanoStakingAccount
} from '../../../src/models/cardanoStakingAccountModel';
import { STAKING_COLLECTIONS } from '../../../src/models/cardanoStakingCollections';
import CardanoStakingOperation from '../../../src/models/cardanoStakingOperationModel';
import {
  checkStakingOperationReadiness,
  createStakingOperation,
  missingStakingIndexes,
  resetStakingSchemaVerification
} from '../../../src/services/cardano/cardanoStakingOperationService';

const CHAIN_ID = 900000000001;
const CREDENTIAL = 'cc2f0b60ee5c4edb7bcc46410787d389539cddf5b64f0012304b91da';

/**
 * Builds every declared staking index, the way the migration does.
 */
async function installSchema(): Promise<void> {
  for (const { model } of STAKING_COLLECTIONS) await model.createIndexes();
  resetStakingSchemaVerification();
}

/**
 * An account in whatever state the case needs.
 *
 * @param overrides - Fields that differ from an account the backfill would have created.
 * @returns The stored account.
 */
async function seedAccount(
  overrides: Record<string, unknown> = {}
): Promise<ICardanoStakingAccount> {
  return CardanoStakingAccount.create({
    userId: new Types.ObjectId(),
    chainId: CHAIN_ID,
    walletAddress: 'addr_test1qzasn8g8wgz5elr7a2jwcpvy9jdpzddy4vc5xtqpkrl53xw',
    rewardAddress: 'stake_test1urxz7zmqaewyakmme3ryzpu86wy488xa7kmy7qqjxp9erksag4z3l',
    stakeCredentialHex: CREDENTIAL,
    currentLifecycleId: 'cycle-1',
    ...overrides
  });
}

/** An account the daily sync has already read on chain, and whose user consented. */
async function seedReadyAccount(): Promise<ICardanoStakingAccount> {
  return seedAccount({
    termsConsent: { version: '1', acceptedAt: new Date(), source: 'dashboard' },
    onChain: {
      registered: false,
      poolId: null,
      governanceDelegation: null,
      depositLovelace: null,
      withdrawableRewardsLovelace: '0',
      pendingRewardsLovelace: '0',
      lifetimeRewardsLovelace: '0',
      historicalCompleteness: 'partial',
      asOf: new Date()
    }
  });
}

/**
 * A distinct intent, so that two operations in one test do not collide on the idempotency key.
 *
 * @param kind - What the operation would do.
 * @returns The intent.
 */
function intent(kind: Parameters<typeof createStakingOperation>[1]['kind']) {
  return { kind, actor: 'cron', idempotencyKey: `key-${new Types.ObjectId().toHexString()}` };
}

describe('cardanoStakingOperationService', () => {
  beforeEach(async () => {
    await CardanoStakingAccount.deleteMany({});
    await CardanoStakingOperation.deleteMany({});
    await installSchema();
  });

  afterEach(() => {
    resetStakingSchemaVerification();
  });

  describe('the schema has to be installed first', () => {
    it('reports nothing missing once the migration has run', async () => {
      expect(await missingStakingIndexes()).toEqual([]);
    });

    it('refuses an economic operation while a mandatory index is absent', async () => {
      // Uniqueness in this rollout comes entirely from indexes. Mongo creates a collection
      // implicitly on first insert without any of them, so a deployment where the migration never
      // ran would accept every write and let two accounts claim one deposit.
      await CardanoStakingOperation.collection.dropIndex('one_live_op_per_account');
      resetStakingSchemaVerification();
      const account = await seedReadyAccount();

      const readiness = await checkStakingOperationReadiness(account, 'register_and_delegate');

      expect(readiness).toEqual({
        ok: false,
        refusal: 'indexes_missing',
        detail: expect.stringContaining('cardano_staking_operations.one_live_op_per_account')
      });
    });

    it('names every missing index, not just the first', async () => {
      await CardanoStakingAccount.collection.dropIndex('chain_credential_unique');
      await CardanoStakingOperation.collection.dropIndex('idempotency_unique');
      resetStakingSchemaVerification();

      const missing = await missingStakingIndexes();

      expect(missing).toContain('cardano_staking_accounts.chain_credential_unique');
      expect(missing).toContain('cardano_staking_operations.idempotency_unique');
    });

    it('creates no operation when the schema is incomplete', async () => {
      await CardanoStakingOperation.collection.dropIndex('one_live_op_per_account');
      resetStakingSchemaVerification();
      const account = await seedReadyAccount();

      await expect(
        createStakingOperation(account, intent('register_and_delegate'))
      ).rejects.toThrow('CARDANO_STAKING_REFUSED_INDEXES_MISSING');
      expect(await CardanoStakingOperation.countDocuments({})).toBe(0);
    });

    it('does not remember a failure, so running the migration while up is enough to recover', async () => {
      await CardanoStakingOperation.collection.dropIndex('one_live_op_per_account');
      resetStakingSchemaVerification();
      const account = await seedReadyAccount();
      expect((await checkStakingOperationReadiness(account, 'withdraw_rewards')).ok).toBe(false);

      await CardanoStakingOperation.createIndexes();

      expect((await checkStakingOperationReadiness(account, 'withdraw_rewards')).ok).toBe(true);
    });
  });

  describe('onChain.asOf: null is not a state anything may act on', () => {
    it('refuses every economic kind while the credential has never been read', async () => {
      // `null` means never read. It is not "registered: false" and it is not "no rewards": building
      // a registration on it submits a certificate for a credential that may already be registered.
      const account = await seedAccount({
        termsConsent: { version: '1', acceptedAt: new Date(), source: 'dashboard' }
      });
      expect(account.onChain.asOf).toBeNull();

      for (const kind of [
        'register_and_delegate',
        'withdraw_rewards',
        'deregister',
        'exit_and_send_max',
        'redelegate_pool',
        'delegate_vote'
      ] as const) {
        const readiness = await checkStakingOperationReadiness(account, kind);
        expect(readiness).toEqual({
          ok: false,
          refusal: 'no_confirmed_chain_read',
          detail: expect.stringContaining('never been read on chain')
        });
      }
    });

    it('creates no operation for an account the backfill has only just made', async () => {
      // Exactly what the migration leaves behind: an account row and no on-chain read.
      const account = await seedAccount();

      await expect(
        createStakingOperation(account, intent('register_and_delegate'))
      ).rejects.toThrow('CARDANO_STAKING_REFUSED_NO_CONFIRMED_CHAIN_READ');
      expect(await CardanoStakingOperation.countDocuments({})).toBe(0);
    });

    it('allows the operation once a read has landed', async () => {
      const account = await seedReadyAccount();

      const operation = await createStakingOperation(account, intent('register_and_delegate'));

      expect(operation.kind).toBe('register_and_delegate');
      expect(operation.status).toBe('queued');
      // Live from the moment it exists: the credential is spoken for before anything is submitted.
      expect(operation.liveness).toBe('live');
    });

    it('is not satisfied by a registered flag without a read behind it', async () => {
      const account = await seedAccount({
        termsConsent: { version: '1', acceptedAt: new Date(), source: 'dashboard' },
        onChain: {
          registered: true,
          poolId: 'pool1abc',
          governanceDelegation: null,
          depositLovelace: '2000000',
          withdrawableRewardsLovelace: '0',
          pendingRewardsLovelace: '0',
          lifetimeRewardsLovelace: '0',
          historicalCompleteness: 'partial',
          asOf: null
        }
      });

      const readiness = await checkStakingOperationReadiness(account, 'deregister');

      expect(readiness.ok).toBe(false);
    });
  });

  describe('consent', () => {
    it('refuses to start participation without it', async () => {
      const account = await seedAccount({
        onChain: {
          registered: false,
          poolId: null,
          governanceDelegation: null,
          depositLovelace: null,
          withdrawableRewardsLovelace: '0',
          pendingRewardsLovelace: '0',
          lifetimeRewardsLovelace: '0',
          historicalCompleteness: 'partial',
          asOf: new Date()
        }
      });

      const readiness = await checkStakingOperationReadiness(account, 'register_and_delegate');

      expect(readiness).toEqual({
        ok: false,
        refusal: 'no_terms_consent',
        detail: expect.stringContaining('no consent is on record')
      });
    });

    it.each([
      'withdraw_rewards',
      'deregister',
      'exit_and_send_max'
    ] as const)('still allows %s, because leaving is always allowed', async (kind) => {
      const account = await seedAccount({
        onChain: {
          registered: true,
          poolId: 'pool1abc',
          governanceDelegation: null,
          depositLovelace: '2000000',
          withdrawableRewardsLovelace: '0',
          pendingRewardsLovelace: '0',
          lifetimeRewardsLovelace: '0',
          historicalCompleteness: 'partial',
          asOf: new Date()
        }
      });

      expect((await checkStakingOperationReadiness(account, kind)).ok).toBe(true);
    });
  });

  describe('the credential lock applies from creation', () => {
    it('refuses a second operation for an account that already has a queued one', async () => {
      const account = await seedReadyAccount();
      await createStakingOperation(account, intent('register_and_delegate'));

      await expect(createStakingOperation(account, intent('withdraw_rewards'))).rejects.toThrow();
      expect(await CardanoStakingOperation.countDocuments({ accountId: account._id })).toBe(1);
    });

    it('refuses an operation with no cycle to belong to', async () => {
      const account = await seedReadyAccount();
      account.currentLifecycleId = null;

      await expect(createStakingOperation(account, intent('withdraw_rewards'))).rejects.toThrow(
        'CARDANO_STAKING_NO_LIFECYCLE'
      );
    });
  });

  describe('the index list is one list', () => {
    it('checks exactly what the schemas declare, across every staking collection', async () => {
      // The guard and the migration read the same source. Two lists would drift, and the direction
      // that drift takes is the dangerous one: a guard checking fewer indexes than the migration
      // installs waves through the deployment where the migration never ran.
      const collections = STAKING_COLLECTIONS.map((entry) => entry.collection);

      expect(collections).toHaveLength(8);
      expect(mongoose.connection.readyState).toBe(1);
      expect(await missingStakingIndexes()).toEqual([]);
    });
  });
});

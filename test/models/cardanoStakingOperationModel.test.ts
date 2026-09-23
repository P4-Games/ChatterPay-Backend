import { Types } from 'mongoose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import CardanoStakingOperation, {
  BLOCKING_CHAIN_OUTCOMES,
  type CardanoStakingChainOutcome,
  type ICardanoStakingOperation
} from '../../src/models/cardanoStakingOperationModel';

const CHAIN_ID = 900000000001;

function operation(
  accountId: Types.ObjectId,
  overrides: Partial<ICardanoStakingOperation> = {}
): Partial<ICardanoStakingOperation> {
  return {
    accountId,
    chainId: CHAIN_ID,
    lifecycleId: 'cycle-1',
    kind: 'register_and_delegate',
    actor: 'cron',
    idempotencyKey: `key-${Math.random()}`,
    ...overrides
  };
}

describe('cardano_staking_operations', () => {
  beforeAll(async () => {
    await CardanoStakingOperation.syncIndexes();
  });

  beforeEach(async () => {
    await CardanoStakingOperation.deleteMany({});
  });

  describe('idempotency', () => {
    it('rejects a second operation carrying the same key on the same network', async () => {
      const accountId = new Types.ObjectId();
      await CardanoStakingOperation.create(operation(accountId, { idempotencyKey: 'same-key' }));

      await expect(
        CardanoStakingOperation.create(
          operation(new Types.ObjectId(), { idempotencyKey: 'same-key' })
        )
      ).rejects.toThrow();
    });

    it('lets the same key through on a different network', async () => {
      await CardanoStakingOperation.create(
        operation(new Types.ObjectId(), { idempotencyKey: 'same-key' })
      );

      const other = await CardanoStakingOperation.create(
        operation(new Types.ObjectId(), { idempotencyKey: 'same-key', chainId: 900764824073 })
      );

      expect(other.idempotencyKey).toBe('same-key');
    });
  });

  describe('one live operation per credential', () => {
    it.each(BLOCKING_CHAIN_OUTCOMES)(
      'refuses a second operation while the first is %s',
      async (chainOutcome) => {
        const accountId = new Types.ObjectId();
        await CardanoStakingOperation.create(operation(accountId, { chainOutcome }));

        await expect(
          CardanoStakingOperation.create(
            operation(accountId, { kind: 'withdraw_rewards', chainOutcome: 'pending' })
          )
        ).rejects.toThrow();
      }
    );

    it.each<CardanoStakingChainOutcome>(['none', 'confirmed', 'rejected'])(
      'allows a new operation once the previous one is %s',
      async (chainOutcome) => {
        const accountId = new Types.ObjectId();
        await CardanoStakingOperation.create(operation(accountId, { chainOutcome }));

        const next = await CardanoStakingOperation.create(
          operation(accountId, { kind: 'withdraw_rewards', chainOutcome: 'pending' })
        );

        expect(next.chainOutcome).toBe('pending');
      }
    );

    it('keeps blocking when an operator marks an unsettled operation for review', async () => {
      // The reason the partial index hangs off `chainOutcome` instead of `status`. Under a
      // status-based filter this operation would leave the index and free the credential, while its
      // transaction can still confirm.
      const accountId = new Types.ObjectId();
      await CardanoStakingOperation.create(
        operation(accountId, { status: 'manual_review', chainOutcome: 'unknown' })
      );

      await expect(
        CardanoStakingOperation.create(
          operation(accountId, { kind: 'deregister', chainOutcome: 'pending' })
        )
      ).rejects.toThrow();
    });

    it('stops blocking when a reviewed operation is known to have been rejected', async () => {
      const accountId = new Types.ObjectId();
      await CardanoStakingOperation.create(
        operation(accountId, { status: 'manual_review', chainOutcome: 'rejected' })
      );

      const next = await CardanoStakingOperation.create(
        operation(accountId, { kind: 'deregister', chainOutcome: 'pending' })
      );

      expect(next.kind).toBe('deregister');
    });

    it('lets exactly one of two concurrent writers take the credential', async () => {
      const accountId = new Types.ObjectId();

      const results = await Promise.allSettled([
        CardanoStakingOperation.create(
          operation(accountId, { idempotencyKey: 'writer-a', chainOutcome: 'pending' })
        ),
        CardanoStakingOperation.create(
          operation(accountId, { idempotencyKey: 'writer-b', chainOutcome: 'pending' })
        )
      ]);

      const won = results.filter((result) => result.status === 'fulfilled');
      expect(won).toHaveLength(1);
      expect(await CardanoStakingOperation.countDocuments({ accountId })).toBe(1);
    });

    it('does not let two different accounts block each other', async () => {
      await CardanoStakingOperation.create(
        operation(new Types.ObjectId(), { chainOutcome: 'pending' })
      );

      const other = await CardanoStakingOperation.create(
        operation(new Types.ObjectId(), { chainOutcome: 'pending' })
      );

      expect(other.chainOutcome).toBe('pending');
    });
  });

  describe('defaults', () => {
    it('starts an operation as queued and with nothing on chain', async () => {
      const created = await CardanoStakingOperation.create(operation(new Types.ObjectId()));

      expect(created.status).toBe('queued');
      expect(created.chainOutcome).toBe('none');
      expect(created.txId).toBeNull();
      expect(created.signedCborProtected).toBeNull();
      expect(created.attempts).toBe(0);
    });

    it('stores lovelace amounts as exact decimal strings', async () => {
      // 45 million ada in lovelace: past 2^53, so a float would round it.
      const exact = '45000000000000001';
      const created = await CardanoStakingOperation.create(
        operation(new Types.ObjectId(), { actualRegistrationDepositLovelace: exact })
      );

      const read = await CardanoStakingOperation.findById(created._id);
      expect(read?.actualRegistrationDepositLovelace).toBe(exact);
      expect(BigInt(read?.actualRegistrationDepositLovelace ?? '0')).toBe(BigInt(exact));
    });
  });

  describe('DRep-own operation kinds', () => {
    it('accepts the shape while the feature stays disabled elsewhere', async () => {
      // The models are prepared so the shape is settled. Refusing these is the service's job, gated
      // on `drepOwnEnabled`, not the schema's.
      const created = await CardanoStakingOperation.create(
        operation(new Types.ObjectId(), { kind: 'cast_drep_vote' })
      );

      expect(created.kind).toBe('cast_drep_vote');
    });
  });
});

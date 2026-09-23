import { Types } from 'mongoose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import CardanoStakingOperation, {
  BLOCKING_CHAIN_OUTCOMES,
  type CardanoStakingAbsenceProof,
  type CardanoStakingOperationStatus,
  type ICardanoStakingOperation,
  operationLiveness
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
    it.each(
      BLOCKING_CHAIN_OUTCOMES
    )('refuses a second operation while the first is %s', async (chainOutcome) => {
      const accountId = new Types.ObjectId();
      await CardanoStakingOperation.create(operation(accountId, { chainOutcome }));

      await expect(
        CardanoStakingOperation.create(
          operation(accountId, { kind: 'withdraw_rewards', chainOutcome: 'pending' })
        )
      ).rejects.toThrow();
    });

    it.each<CardanoStakingOperationStatus>([
      'queued',
      'executing',
      'signed'
    ])('refuses a second operation while the first is %s and nothing is on chain yet', async (status) => {
      // These three carry `chainOutcome: 'none'`, because nothing was submitted. An exclusion
      // keyed off the outcome alone lets a second operation be queued for an account whose first
      // one has already selected its UTxOs and is one step from being signed.
      const accountId = new Types.ObjectId();
      await CardanoStakingOperation.create(operation(accountId, { status }));

      await expect(
        CardanoStakingOperation.create(
          operation(accountId, { kind: 'withdraw_rewards', chainOutcome: 'pending' })
        )
      ).rejects.toThrow();
    });

    it('allows a new operation once the previous one confirmed', async () => {
      const accountId = new Types.ObjectId();
      await CardanoStakingOperation.create(operation(accountId, { chainOutcome: 'confirmed' }));

      const next = await CardanoStakingOperation.create(
        operation(accountId, { kind: 'withdraw_rewards', chainOutcome: 'pending' })
      );

      expect(next.chainOutcome).toBe('pending');
    });

    it('allows a new operation once the previous one was cancelled before reaching a node', async () => {
      const accountId = new Types.ObjectId();
      await CardanoStakingOperation.create(
        operation(accountId, { status: 'cancelled', chainOutcome: 'none' })
      );

      const next = await CardanoStakingOperation.create(
        operation(accountId, { kind: 'withdraw_rewards', chainOutcome: 'pending' })
      );

      expect(next.chainOutcome).toBe('pending');
    });

    it('keeps blocking on a rejection that nothing has corroborated', async () => {
      // A node answers "rejected" to a resubmission of a transaction it has already accepted, and
      // a submit that timed out can be rejected by the next node asked while the first one is still
      // propagating it. Freeing the credential on the word alone builds a second certificate for a
      // stake credential whose first one is settling.
      const accountId = new Types.ObjectId();
      await CardanoStakingOperation.create(
        operation(accountId, { status: 'rejected', chainOutcome: 'rejected' })
      );

      await expect(
        CardanoStakingOperation.create(
          operation(accountId, { kind: 'deregister', chainOutcome: 'pending' })
        )
      ).rejects.toThrow();
    });

    it.each<CardanoStakingAbsenceProof>([
      'never_submitted',
      'ttl_expired_and_absent',
      'chain_rejected'
    ])('releases the credential on proof of absence: %s', async (absenceProof) => {
      const accountId = new Types.ObjectId();
      await CardanoStakingOperation.create(
        operation(accountId, { status: 'rejected', chainOutcome: 'rejected', absenceProof })
      );

      const next = await CardanoStakingOperation.create(
        operation(accountId, { kind: 'deregister', chainOutcome: 'pending' })
      );

      expect(next.kind).toBe('deregister');
    });

    it('keeps blocking past the TTL until an on-chain lookup has been made', async () => {
      // The TTL passing means the transaction can never become valid; it does not mean it never
      // was. Only a lookup settles that, and until it happens the credential stays held.
      const accountId = new Types.ObjectId();
      const expired = await CardanoStakingOperation.create(
        operation(accountId, { status: 'expired_unconfirmed', chainOutcome: 'unknown' })
      );

      await expect(
        CardanoStakingOperation.create(
          operation(accountId, { kind: 'deregister', chainOutcome: 'pending' })
        )
      ).rejects.toThrow();
      expect(expired.liveness).toBe('live');
    });

    it('keeps blocking when an operator marks an unsettled operation for review', async () => {
      // An operator looking at a transaction is not the chain deciding about it. Under a
      // status-based filter this operation would leave the index and free the credential while its
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

    it('keeps blocking a reviewed operation whose rejection is still unproven', async () => {
      const accountId = new Types.ObjectId();
      await CardanoStakingOperation.create(
        operation(accountId, { status: 'manual_review', chainOutcome: 'rejected' })
      );

      await expect(
        CardanoStakingOperation.create(
          operation(accountId, { kind: 'deregister', chainOutcome: 'pending' })
        )
      ).rejects.toThrow();
    });

    it('stops blocking once a reviewed rejection is shown never to have reached the chain', async () => {
      const accountId = new Types.ObjectId();
      await CardanoStakingOperation.create(
        operation(accountId, {
          status: 'manual_review',
          chainOutcome: 'rejected',
          absenceProof: 'ttl_expired_and_absent'
        })
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

  describe('liveness follows the document through a query update', () => {
    it('recomputes when the reconciler sets an outcome on a document it never loaded', async () => {
      // The reconciler works this way. If `liveness` kept the value it was written with, the index
      // would stop describing reality after the first update and the credential would never be
      // freed.
      const accountId = new Types.ObjectId();
      const created = await CardanoStakingOperation.create(
        operation(accountId, { chainOutcome: 'pending' })
      );

      await CardanoStakingOperation.updateOne(
        { _id: created._id },
        { $set: { chainOutcome: 'confirmed', status: 'confirmed' } }
      );

      const read = await CardanoStakingOperation.findById(created._id);
      expect(read?.liveness).toBe('settled');
      const next = await CardanoStakingOperation.create(
        operation(accountId, { kind: 'withdraw_rewards', chainOutcome: 'pending' })
      );
      expect(next.kind).toBe('withdraw_rewards');
    });

    it('reads the fields the update does not mention instead of assuming them', async () => {
      const accountId = new Types.ObjectId();
      const created = await CardanoStakingOperation.create(
        operation(accountId, { status: 'rejected', chainOutcome: 'rejected' })
      );
      expect(created.liveness).toBe('live');

      // Only the proof is written. Status and outcome have to come from the stored document, and a
      // hook that defaulted them would compute the liveness of an operation that does not exist.
      await CardanoStakingOperation.updateOne(
        { _id: created._id },
        { $set: { absenceProof: 'chain_rejected' } }
      );

      const read = await CardanoStakingOperation.findById(created._id);
      expect(read?.liveness).toBe('settled');
    });

    it('goes back to blocking if a proof is withdrawn', async () => {
      const accountId = new Types.ObjectId();
      const created = await CardanoStakingOperation.create(
        operation(accountId, {
          status: 'rejected',
          chainOutcome: 'rejected',
          absenceProof: 'chain_rejected'
        })
      );

      await CardanoStakingOperation.updateOne(
        { _id: created._id },
        { $unset: { absenceProof: '' } }
      );

      const read = await CardanoStakingOperation.findById(created._id);
      expect(read?.liveness).toBe('live');
    });

    it('leaves liveness alone when an update touches none of its inputs', async () => {
      const accountId = new Types.ObjectId();
      const created = await CardanoStakingOperation.create(
        operation(accountId, { chainOutcome: 'pending' })
      );

      await CardanoStakingOperation.updateOne({ _id: created._id }, { $inc: { attempts: 1 } });

      const read = await CardanoStakingOperation.findById(created._id);
      expect(read?.liveness).toBe('live');
      expect(read?.attempts).toBe(1);
    });
  });

  describe('operationLiveness', () => {
    it.each<
      [
        CardanoStakingOperationStatus,
        'none' | 'pending' | 'unknown' | 'confirmed' | 'rejected',
        CardanoStakingAbsenceProof | null,
        'live' | 'settled'
      ]
    >([
      ['queued', 'none', null, 'live'],
      ['executing', 'none', null, 'live'],
      ['signed', 'none', null, 'live'],
      ['submitted', 'pending', null, 'live'],
      ['unknown_submit', 'unknown', null, 'live'],
      ['manual_review', 'unknown', null, 'live'],
      ['manual_review', 'none', null, 'live'],
      ['expired_unconfirmed', 'unknown', null, 'live'],
      ['rejected', 'rejected', null, 'live'],
      ['manual_review', 'rejected', null, 'live'],
      ['rejected', 'rejected', 'chain_rejected', 'settled'],
      ['cancelled', 'none', null, 'settled'],
      ['confirmed', 'confirmed', null, 'settled']
    ])('%s over %s with proof %s is %s', (status, chainOutcome, absenceProof, expected) => {
      expect(operationLiveness(status, chainOutcome, absenceProof)).toBe(expected);
    });
  });

  describe('defaults', () => {
    it('starts an operation as queued and with nothing on chain', async () => {
      const created = await CardanoStakingOperation.create(operation(new Types.ObjectId()));

      expect(created.status).toBe('queued');
      expect(created.chainOutcome).toBe('none');
      expect(created.absenceProof).toBeNull();
      // Queued and holding the credential: nothing has happened yet, and nothing else may start.
      expect(created.liveness).toBe('live');
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

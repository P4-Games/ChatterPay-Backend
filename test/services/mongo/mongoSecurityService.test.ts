import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UserModel } from '../../../src/models/userModel';
import { mongoSecurityService } from '../../../src/services/mongo/mongoSecurityService';

describe('mongoSecurityService', () => {
  beforeEach(async () => {
    await UserModel.deleteMany({});
  });

  afterEach(async () => {
    await UserModel.deleteMany({});
  });

  describe('getSecurityState', () => {
    it('returns safe defaults when user exists but security field is missing', async () => {
      // Insert raw doc to simulate user without security settings
      await UserModel.collection.insertOne({
        phone_number: '1234567890',
        settings: {
          notifications: {
            language: 'en'
          }
        }
      });

      const securityState = await mongoSecurityService.getSecurityState('1234567890');

      expect(securityState.pin.status).toBe('not_set');
      expect(securityState.pin.failed_attempts).toBe(0);
      expect(securityState.pin.blocked_until).toBeNull();
      expect(securityState.recovery_questions).toEqual([]);
    });

    it('returns safe defaults when user does not exist', async () => {
      const securityState = await mongoSecurityService.getSecurityState('9999999999');

      expect(securityState.pin.status).toBe('not_set');
      expect(securityState.pin.failed_attempts).toBe(0);
      expect(securityState.recovery_questions).toEqual([]);
    });

    it('returns stored security state when it exists', async () => {
      const testDate = new Date();
      await UserModel.collection.insertOne({
        phone_number: '1234567890',
        settings: {
          notifications: { language: 'en' },
          security: {
            pin: {
              hash: 'test_hash',
              status: 'active',
              failed_attempts: 0,
              blocked_until: null,
              last_set_at: testDate,
              reset_required: false
            },
            recovery_questions: []
          }
        }
      });

      const securityState = await mongoSecurityService.getSecurityState('1234567890');

      expect(securityState.pin.status).toBe('active');
      expect(securityState.pin.hash).toBe('test_hash');
      expect(securityState.pin.failed_attempts).toBe(0);
    });
  });

  describe('setPinHash', () => {
    it('sets PIN hash and updates status to active', async () => {
      await UserModel.create({
        phone_number: '1234567890',
        wallets: []
      });

      const result = await mongoSecurityService.setPinHash('1234567890', 'hashed_pin');

      expect(result).toBe(true);

      const user = await UserModel.findOne({ phone_number: '1234567890' });
      expect(user?.settings?.security?.pin?.hash).toBe('hashed_pin');
      expect(user?.settings?.security?.pin?.status).toBe('active');
      expect(user?.settings?.security?.pin?.failed_attempts).toBe(0);
    });
  });

  describe('incrementPinFailedAttempt', () => {
    it('increments failed attempts counter', async () => {
      await UserModel.create({
        phone_number: '1234567890',
        wallets: [],
        settings: {
          notifications: { language: 'en' },
          security: {
            pin: {
              hash: 'test_hash',
              status: 'active',
              failed_attempts: 0,
              blocked_until: null,
              last_set_at: new Date(),
              reset_required: false
            },
            recovery_questions: []
          }
        }
      });

      const result = await mongoSecurityService.incrementPinFailedAttempt('1234567890');

      expect(result.failed_attempts).toBe(1);

      const user = await UserModel.findOne({ phone_number: '1234567890' });
      expect(user?.settings?.security?.pin?.failed_attempts).toBe(1);
    });

    it('increments multiple times', async () => {
      await UserModel.create({
        phone_number: '1234567890',
        wallets: [],
        settings: {
          notifications: { language: 'en' },
          security: {
            pin: {
              hash: 'test_hash',
              status: 'active',
              failed_attempts: 0,
              blocked_until: null,
              last_set_at: new Date(),
              reset_required: false
            },
            recovery_questions: []
          }
        }
      });

      await mongoSecurityService.incrementPinFailedAttempt('1234567890');
      await mongoSecurityService.incrementPinFailedAttempt('1234567890');
      const result = await mongoSecurityService.incrementPinFailedAttempt('1234567890');

      expect(result.failed_attempts).toBe(3);
    });
  });

  describe('resetPinFailedAttempts', () => {
    it('resets failed attempts to zero', async () => {
      await UserModel.create({
        phone_number: '1234567890',
        wallets: [],
        settings: {
          notifications: { language: 'en' },
          security: {
            pin: {
              hash: 'test_hash',
              status: 'active',
              failed_attempts: 3,
              blocked_until: null,
              last_set_at: new Date(),
              reset_required: false
            },
            recovery_questions: []
          }
        }
      });

      await mongoSecurityService.resetPinFailedAttempts('1234567890');

      const user = await UserModel.findOne({ phone_number: '1234567890' });
      expect(user?.settings?.security?.pin?.failed_attempts).toBe(0);
    });
  });

  describe('setPinBlockedUntil', () => {
    it('sets blocked_until and changes status to blocked', async () => {
      await UserModel.create({
        phone_number: '1234567890',
        wallets: [],
        settings: {
          notifications: { language: 'en' },
          security: {
            pin: {
              hash: 'test_hash',
              status: 'active',
              failed_attempts: 3,
              blocked_until: null,
              last_set_at: new Date(),
              reset_required: false
            },
            recovery_questions: []
          }
        }
      });

      const blockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      await mongoSecurityService.setPinBlockedUntil('1234567890', blockedUntil);

      const user = await UserModel.findOne({ phone_number: '1234567890' });
      expect(user?.settings?.security?.pin?.status).toBe('blocked');
      expect(user?.settings?.security?.pin?.blocked_until).toBeDefined();
    });
  });

  describe('setRecoveryQuestions', () => {
    it('stores recovery questions', async () => {
      await UserModel.create({
        phone_number: '1234567890',
        wallets: []
      });

      const questions = [
        {
          question_id: 'q1',
          answer_hash: 'hash1',
          salt: 'salt1',
          set_at: new Date()
        },
        {
          question_id: 'q2',
          answer_hash: 'hash2',
          salt: 'salt2',
          set_at: new Date()
        },
        {
          question_id: 'q3',
          answer_hash: 'hash3',
          salt: 'salt3',
          set_at: new Date()
        }
      ];

      await mongoSecurityService.setRecoveryQuestions('1234567890', questions);

      const user = await UserModel.findOne({ phone_number: '1234567890' });
      expect(user?.settings?.security?.recovery_questions).toHaveLength(3);
      expect(user?.settings?.security?.recovery_questions?.[0]?.question_id).toBe('q1');
    });

    it('overwrites existing recovery questions', async () => {
      await UserModel.create({
        phone_number: '1234567890',
        wallets: [],
        settings: {
          notifications: { language: 'en' },
          security: {
            pin: {
              hash: '',
              status: 'not_set',
              failed_attempts: 0,
              blocked_until: null,
              last_set_at: null,
              reset_required: false
            },
            recovery_questions: [
              {
                question_id: 'old_q',
                answer_hash: 'old_hash',
                salt: 'old_salt',
                set_at: new Date()
              }
            ]
          }
        }
      });

      const newQuestions = [
        {
          question_id: 'new_q1',
          answer_hash: 'new_hash1',
          salt: 'new_salt1',
          set_at: new Date()
        }
      ];

      await mongoSecurityService.setRecoveryQuestions('1234567890', newQuestions);

      const user = await UserModel.findOne({ phone_number: '1234567890' });
      expect(user?.settings?.security?.recovery_questions).toHaveLength(1);
      expect(user?.settings?.security?.recovery_questions?.[0]?.question_id).toBe('new_q1');
    });
  });

  describe('getRecoveryQuestionIds', () => {
    it('returns question IDs for user with recovery questions', async () => {
      await UserModel.create({
        phone_number: '1234567890',
        wallets: [],
        settings: {
          notifications: { language: 'en' },
          security: {
            pin: {
              hash: '',
              status: 'not_set',
              failed_attempts: 0,
              blocked_until: null,
              last_set_at: null,
              reset_required: false
            },
            recovery_questions: [
              {
                question_id: 'q1',
                answer_hash: 'hash1',
                salt: 'salt1',
                set_at: new Date()
              },
              {
                question_id: 'q2',
                answer_hash: 'hash2',
                salt: 'salt2',
                set_at: new Date()
              }
            ]
          }
        }
      });

      const ids = await mongoSecurityService.getRecoveryQuestionIds('1234567890');

      expect(ids).toEqual(['q1', 'q2']);
    });

    it('returns empty array when no recovery questions set', async () => {
      await UserModel.create({
        phone_number: '1234567890',
        wallets: []
      });

      const ids = await mongoSecurityService.getRecoveryQuestionIds('1234567890');

      expect(ids).toEqual([]);
    });
  });
});

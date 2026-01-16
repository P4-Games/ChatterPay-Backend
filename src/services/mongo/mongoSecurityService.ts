import { getPhoneNumberFormatted } from '../../helpers/formatHelper';
import { Logger } from '../../helpers/loggerHelper';
import type { IRecoveryQuestion, ISecurityPin } from '../../models/userModel';
import { UserModel } from '../../models/userModel';

export interface SecurityState {
  pin: ISecurityPin;
  recovery_questions: IRecoveryQuestion[];
}

export interface RecoveryQuestionRecord {
  question_id: string;
  answer_hash: string;
  salt: string;
  set_at: Date;
}

export const mongoSecurityService = {
  /**
   * Get security state for a user. Returns safe defaults if not set.
   */
  getSecurityState: async (phoneNumber: string): Promise<SecurityState> => {
    const user = await UserModel.findOne(
      {
        phone_number: getPhoneNumberFormatted(phoneNumber)
      },
      'settings.security'
    ).lean();

    const defaultState: SecurityState = {
      pin: {
        hash: '',
        status: 'not_set',
        failed_attempts: 0,
        blocked_until: null,
        last_set_at: null,
        reset_required: false
      },
      recovery_questions: []
    };

    if (!user || !user.settings?.security) {
      return defaultState;
    }

    const security = user.settings.security;

    return {
      pin: {
        hash: security.pin?.hash ?? '',
        status: security.pin?.status ?? 'not_set',
        failed_attempts: security.pin?.failed_attempts ?? 0,
        blocked_until: security.pin?.blocked_until ?? null,
        last_set_at: security.pin?.last_set_at ?? null,
        reset_required: security.pin?.reset_required ?? false
      },
      recovery_questions: security.recovery_questions ?? []
    };
  },

  /**
   * Set the PIN hash for a user
   */
  setPinHash: async (phoneNumber: string, pinHash: string): Promise<boolean> => {
    try {
      const result = await UserModel.updateOne(
        { phone_number: getPhoneNumberFormatted(phoneNumber) },
        {
          $set: {
            'settings.security.pin.hash': pinHash,
            'settings.security.pin.status': 'active',
            'settings.security.pin.failed_attempts': 0,
            'settings.security.pin.blocked_until': null,
            'settings.security.pin.last_set_at': new Date(),
            'settings.security.pin.reset_required': false
          }
        }
      );

      return (result.modifiedCount ?? 0) > 0;
    } catch (error) {
      Logger.error('mongoSecurityService', 'setPinHash', `Failed to set PIN hash`, { error });
      return false;
    }
  },

  /**
   * Mark if PIN reset is required
   */
  markPinResetRequired: async (phoneNumber: string, required: boolean): Promise<boolean> => {
    try {
      const result = await UserModel.updateOne(
        { phone_number: getPhoneNumberFormatted(phoneNumber) },
        {
          $set: {
            'settings.security.pin.reset_required': required
          }
        }
      );

      return (result.modifiedCount ?? 0) > 0;
    } catch (error) {
      Logger.error(
        'mongoSecurityService',
        'markPinResetRequired',
        `Failed to mark PIN reset required`,
        { error }
      );
      return false;
    }
  },

  /**
   * Increment failed PIN attempts and return current state
   */
  incrementPinFailedAttempt: async (
    phoneNumber: string
  ): Promise<{ failed_attempts: number; blocked_until: Date | null }> => {
    try {
      const user = await UserModel.findOneAndUpdate(
        { phone_number: getPhoneNumberFormatted(phoneNumber) },
        {
          $inc: { 'settings.security.pin.failed_attempts': 1 }
        },
        { new: true, projection: 'settings.security.pin' }
      ).lean();

      return {
        failed_attempts: user?.settings?.security?.pin?.failed_attempts ?? 1,
        blocked_until: user?.settings?.security?.pin?.blocked_until ?? null
      };
    } catch (error) {
      Logger.error(
        'mongoSecurityService',
        'incrementPinFailedAttempt',
        `Failed to increment failed attempts`,
        { error }
      );
      return { failed_attempts: 0, blocked_until: null };
    }
  },

  /**
   * Reset PIN failed attempts to 0
   */
  resetPinFailedAttempts: async (phoneNumber: string): Promise<void> => {
    try {
      await UserModel.updateOne(
        { phone_number: getPhoneNumberFormatted(phoneNumber) },
        {
          $set: {
            'settings.security.pin.failed_attempts': 0,
            'settings.security.pin.blocked_until': null
          }
        }
      );
    } catch (error) {
      Logger.error(
        'mongoSecurityService',
        'resetPinFailedAttempts',
        `Failed to reset failed attempts`,
        { error }
      );
    }
  },

  /**
   * Set blocked_until timestamp
   */
  setPinBlockedUntil: async (phoneNumber: string, blockedUntil: Date): Promise<void> => {
    try {
      await UserModel.updateOne(
        { phone_number: getPhoneNumberFormatted(phoneNumber) },
        {
          $set: {
            'settings.security.pin.blocked_until': blockedUntil,
            'settings.security.pin.status': 'blocked'
          }
        }
      );
    } catch (error) {
      Logger.error('mongoSecurityService', 'setPinBlockedUntil', `Failed to set PIN blocked`, {
        error
      });
    }
  },

  /**
   * Set recovery questions (overwrites existing)
   */
  setRecoveryQuestions: async (
    phoneNumber: string,
    questions: RecoveryQuestionRecord[]
  ): Promise<void> => {
    try {
      await UserModel.updateOne(
        { phone_number: getPhoneNumberFormatted(phoneNumber) },
        {
          $set: {
            'settings.security.recovery_questions': questions
          }
        }
      );
    } catch (error) {
      Logger.error(
        'mongoSecurityService',
        'setRecoveryQuestions',
        `Failed to set recovery questions`,
        { error }
      );
    }
  },

  /**
   * Get recovery question IDs for a user
   */
  getRecoveryQuestionIds: async (phoneNumber: string): Promise<string[]> => {
    const user = await UserModel.findOne(
      {
        phone_number: getPhoneNumberFormatted(phoneNumber)
      },
      'settings.security.recovery_questions'
    ).lean();

    const questions = user?.settings?.security?.recovery_questions ?? [];
    return questions.map((q) => q.question_id);
  }
};

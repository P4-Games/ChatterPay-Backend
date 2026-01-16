import crypto from 'crypto';
import {
  SECURITY_HMAC_KEY,
  SECURITY_PIN_BLOCK_MINUTES,
  SECURITY_PIN_LENGTH,
  SECURITY_PIN_MAX_FAILED_ATTEMPTS,
  SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT
} from '../config/constants';
import { Logger } from '../helpers/loggerHelper';
import type { LocalizedContentType } from '../models/templateModel';
import { mongoSecurityEventsService } from './mongo/mongoSecurityEventsService';
import { mongoSecurityService, type RecoveryQuestionRecord } from './mongo/mongoSecurityService';
import { mongoTemplateService, templateEnum } from './mongo/mongoTemplateService';
import { mongoUserService } from './mongo/mongoUserService';

const HMAC_ALGORITHM = 'sha256';
const DEFAULT_SALT_BYTES = 16;

const getSecurityHmacKey = (): string => {
  if (!SECURITY_HMAC_KEY) {
    throw new Error('SECURITY_HMAC_KEY is not configured');
  }
  return SECURITY_HMAC_KEY;
};

const hmacSha256Hex = (value: string, key: string): string =>
  crypto.createHmac(HMAC_ALGORITHM, key).update(value).digest('hex');

const secureCompareHex = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
};

export interface SecurityStatusDto {
  pin_status: 'active' | 'blocked' | 'not_set';
  failed_attempts: number;
  blocked_until: Date | null;
  last_set_at: Date | null;
  reset_required: boolean;
  recovery_questions_set: boolean;
  recovery_question_ids: string[];
}

export interface SecurityQuestionDto {
  question_id: string;
  text: string;
}

export interface SetPinResult {
  success: boolean;
  message: string;
  pin_status?: 'active';
  last_set_at?: Date;
}

export interface VerifyPinResult {
  ok: boolean;
  status: 'active' | 'blocked' | 'not_set';
  blocked_until?: Date;
  remaining_attempts?: number;
}

export interface SetRecoveryQuestionsResult {
  success: boolean;
  message: string;
  recovery_questions_set?: boolean;
  recovery_question_ids?: string[];
}

export interface ResetPinResult {
  success: boolean;
  message: string;
  pin_status?: 'active';
  last_set_at?: Date;
}

export interface OperationGate {
  allowed: boolean;
  required_flow?: string;
  reason?: string;
  blocked_until?: Date | null;
}

export const securityService = {
  /**
   * Get security status for a user
   */
  getSecurityStatus: async (phoneNumber: string): Promise<SecurityStatusDto> => {
    const securityState = await mongoSecurityService.getSecurityState(phoneNumber);
    const now = new Date();

    let pin_status = securityState.pin.status;

    // Determine actual status based on current time
    if (pin_status === 'not_set' || !securityState.pin.hash) {
      pin_status = 'not_set';
    } else if (
      securityState.pin.blocked_until &&
      securityState.pin.blocked_until > now &&
      pin_status === 'blocked'
    ) {
      pin_status = 'blocked';
    } else if (securityState.pin.hash) {
      pin_status = 'active';
    }

    return {
      pin_status,
      failed_attempts: securityState.pin.failed_attempts,
      blocked_until: securityState.pin.blocked_until,
      last_set_at: securityState.pin.last_set_at,
      reset_required: securityState.pin.reset_required,
      recovery_questions_set: securityState.recovery_questions.length > 0,
      recovery_question_ids: securityState.recovery_questions.map((q) => q.question_id)
    };
  },

  /**
   * List available security questions with localized text
   */
  listSecurityQuestions: async (
    languageHint?: string,
    phoneNumber?: string
  ): Promise<SecurityQuestionDto[]> => {
    try {
      // Determine language
      let language = languageHint || SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT;

      if (phoneNumber) {
        try {
          const userLanguage = await mongoUserService.getUserSettingsLanguage(phoneNumber);
          if (userLanguage) {
            language = userLanguage;
          }
        } catch (error) {
          Logger.warn('securityService', 'listSecurityQuestions', 'Could not get user language', {
            error
          });
        }
      }

      // Get templates directly
      const templates = await mongoTemplateService.getTemplate<
        Record<string, LocalizedContentType>
      >(templateEnum.SECURITY_QUESTIONS);

      if (!templates) {
        Logger.warn('securityService', 'listSecurityQuestions', 'No templates found');
        return [];
      }

      // Convert Map to object if needed
      const questionsObj = templates instanceof Map ? Object.fromEntries(templates) : templates;

      // Map template keys to DTOs with localized text
      return Object.keys(questionsObj).map((questionKey) => {
        const template = questionsObj[questionKey];
        const text = template[language as keyof LocalizedContentType] || template.en || questionKey;

        return {
          question_id: questionKey,
          text
        };
      });
    } catch (error) {
      Logger.error('securityService', 'listSecurityQuestions', 'Failed to list questions', {
        error
      });
      return [];
    }
  },

  /**
   * Set/update user's PIN
   * @param allowOverwrite - Internal flag to allow overwriting existing PIN (used by reset flow)
   */
  setPin: async (
    phoneNumber: string,
    pin: string,
    channel?: string,
    allowOverwrite = false
  ): Promise<SetPinResult> => {
    try {
      // Validate PIN format
      if (!/^\d{6}$/.test(pin)) {
        return {
          success: false,
          message: `PIN must be exactly ${SECURITY_PIN_LENGTH} digits`
        };
      }

      // Check if PIN is already set (unless explicitly allowing overwrite for reset)
      if (!allowOverwrite) {
        const currentStatus = await securityService.getSecurityStatus(phoneNumber);
        if (currentStatus.pin_status === 'active' || currentStatus.pin_status === 'blocked') {
          return {
            success: false,
            message: 'PIN already set. Use reset flow to change it.'
          };
        }
      }

      const key = getSecurityHmacKey();
      const hash = hmacSha256Hex(pin, key);

      // Store in DB
      const updated = await mongoSecurityService.setPinHash(phoneNumber, hash);

      if (!updated) {
        return {
          success: false,
          message: 'Failed to set PIN'
        };
      }

      // Log event
      await mongoSecurityEventsService.logSecurityEvent({
        user_id: phoneNumber,
        event_type: 'PIN_SET',
        channel: (channel as 'bot' | 'frontend' | 'unknown') ?? 'unknown'
      });

      const status = await securityService.getSecurityStatus(phoneNumber);

      return {
        success: true,
        message: 'PIN set successfully',
        pin_status: 'active',
        last_set_at: status.last_set_at ?? new Date()
      };
    } catch (error) {
      Logger.error('securityService', 'setPin', 'Failed to set PIN', { error });
      return {
        success: false,
        message: 'Internal error setting PIN'
      };
    }
  },

  /**
   * Verify user's PIN
   */
  verifyPin: async (phoneNumber: string, pin: string): Promise<VerifyPinResult> => {
    try {
      const securityState = await mongoSecurityService.getSecurityState(phoneNumber);
      const now = new Date();

      // Check if PIN is not set
      if (securityState.pin.status === 'not_set' || !securityState.pin.hash) {
        return {
          ok: false,
          status: 'not_set'
        };
      }

      // Check if blocked
      if (
        securityState.pin.blocked_until &&
        securityState.pin.blocked_until > now &&
        securityState.pin.status === 'blocked'
      ) {
        return {
          ok: false,
          status: 'blocked',
          blocked_until: securityState.pin.blocked_until
        };
      }

      // Verify PIN
      const key = getSecurityHmacKey();
      const expectedHash = hmacSha256Hex(pin, key);
      const isValid = secureCompareHex(expectedHash, securityState.pin.hash);

      if (isValid) {
        // Reset failed attempts
        await mongoSecurityService.resetPinFailedAttempts(phoneNumber);

        return {
          ok: true,
          status: 'active'
        };
      }

      // PIN is incorrect - increment failed attempts
      const { failed_attempts } = await mongoSecurityService.incrementPinFailedAttempt(phoneNumber);

      // Log failed attempt
      await mongoSecurityEventsService.logSecurityEvent({
        user_id: phoneNumber,
        event_type: 'PIN_VERIFY_FAILED',
        metadata: { failed_attempts }
      });

      // Check if should block
      if (failed_attempts >= SECURITY_PIN_MAX_FAILED_ATTEMPTS) {
        const blockedUntil = new Date(now.getTime() + SECURITY_PIN_BLOCK_MINUTES * 60 * 1000);
        await mongoSecurityService.setPinBlockedUntil(phoneNumber, blockedUntil);

        // Log blocked event
        await mongoSecurityEventsService.logSecurityEvent({
          user_id: phoneNumber,
          event_type: 'PIN_BLOCKED',
          metadata: { blocked_until: blockedUntil.toISOString() }
        });

        return {
          ok: false,
          status: 'blocked',
          blocked_until: blockedUntil
        };
      }

      return {
        ok: false,
        status: 'active',
        remaining_attempts: SECURITY_PIN_MAX_FAILED_ATTEMPTS - failed_attempts
      };
    } catch (error) {
      Logger.error('securityService', 'verifyPin', 'Failed to verify PIN', { error });
      return {
        ok: false,
        status: 'active'
      };
    }
  },

  /**
   * Set recovery questions for a user
   */
  setRecoveryQuestions: async (
    phoneNumber: string,
    questions: Array<{ question_id: string; answer: string }>,
    channel?: string
  ): Promise<SetRecoveryQuestionsResult> => {
    try {
      // Validate exactly 3 questions
      if (questions.length !== 3) {
        return {
          success: false,
          message: 'Exactly 3 recovery questions are required'
        };
      }

      // Validate all questions have question_id and answer
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (!q.question_id || typeof q.question_id !== 'string') {
          return {
            success: false,
            message: `Question at index ${i} is missing or has invalid question_id`
          };
        }
        if (!q.answer || typeof q.answer !== 'string' || q.answer.trim() === '') {
          return {
            success: false,
            message: `Question at index ${i} is missing or has invalid answer`
          };
        }
      }

      // Validate unique question IDs
      const uniqueIds = new Set(questions.map((q) => q.question_id));
      if (uniqueIds.size !== 3) {
        return {
          success: false,
          message: 'Question IDs must be unique'
        };
      }

      // Validate all questions exist in templates
      const templates = await mongoTemplateService.getTemplate<
        Record<string, LocalizedContentType>
      >(templateEnum.SECURITY_QUESTIONS);

      if (!templates) {
        return {
          success: false,
          message: 'Security questions templates not configured'
        };
      }

      // Convert Map to object if needed
      const questionsObj = templates instanceof Map ? Object.fromEntries(templates) : templates;

      for (const q of questions) {
        if (!questionsObj[q.question_id]) {
          return {
            success: false,
            message: `Invalid question ID: ${q.question_id}`
          };
        }
      }

      // Hash answers
      const hashedQuestions: RecoveryQuestionRecord[] = [];

      const key = getSecurityHmacKey();
      for (const q of questions) {
        const salt = crypto.randomBytes(DEFAULT_SALT_BYTES).toString('hex');
        const normalizedAnswer = q.answer.toLowerCase().trim();
        const answer_hash = hmacSha256Hex(`${normalizedAnswer}:${salt}`, key);

        hashedQuestions.push({
          question_id: q.question_id,
          answer_hash,
          salt,
          set_at: new Date()
        });
      }

      // Get current state to determine if this is new or update
      const currentState = await mongoSecurityService.getSecurityState(phoneNumber);
      const isUpdate = currentState.recovery_questions.length > 0;

      // Store in DB
      await mongoSecurityService.setRecoveryQuestions(phoneNumber, hashedQuestions);

      // Log event
      await mongoSecurityEventsService.logSecurityEvent({
        user_id: phoneNumber,
        event_type: isUpdate ? 'QUESTIONS_UPDATED' : 'QUESTIONS_SET',
        channel: (channel as 'bot' | 'frontend' | 'unknown') ?? 'unknown'
      });

      return {
        success: true,
        message: 'Recovery questions set successfully',
        recovery_questions_set: true,
        recovery_question_ids: questions.map((q) => q.question_id)
      };
    } catch (error) {
      Logger.error('securityService', 'setRecoveryQuestions', 'Failed to set recovery questions', {
        error
      });
      return {
        success: false,
        message: 'Internal error setting recovery questions'
      };
    }
  },

  /**
   * Reset PIN using recovery questions
   */
  resetPinWithRecovery: async (
    phoneNumber: string,
    answers: Array<{ question_id: string; answer: string }>,
    newPin: string,
    channel?: string
  ): Promise<ResetPinResult> => {
    try {
      // Get current security state
      const securityState = await mongoSecurityService.getSecurityState(phoneNumber);

      // Validate recovery questions are set
      if (securityState.recovery_questions.length === 0) {
        return {
          success: false,
          message: 'Recovery questions not set'
        };
      }

      // Validate all answers provided
      if (answers.length !== securityState.recovery_questions.length) {
        return {
          success: false,
          message: 'All recovery answers must be provided'
        };
      }

      // Verify all answers
      let allCorrect = true;

      const key = getSecurityHmacKey();
      for (const providedAnswer of answers) {
        const storedQuestion = securityState.recovery_questions.find(
          (q) => q.question_id === providedAnswer.question_id
        );

        if (!storedQuestion) {
          allCorrect = false;
          break;
        }

        const normalizedAnswer = providedAnswer.answer.toLowerCase().trim();
        const expectedHash = hmacSha256Hex(`${normalizedAnswer}:${storedQuestion.salt}`, key);
        const isValid = secureCompareHex(expectedHash, storedQuestion.answer_hash);

        if (!isValid) {
          allCorrect = false;
          break;
        }
      }

      if (!allCorrect) {
        return {
          success: false,
          message: 'Recovery answers are incorrect'
        };
      }

      // All answers correct - set new PIN (with overwrite allowed)
      const setPinResult = await securityService.setPin(phoneNumber, newPin, channel, true);

      if (!setPinResult.success) {
        return {
          success: false,
          message: setPinResult.message
        };
      }

      // Log PIN reset event
      await mongoSecurityEventsService.logSecurityEvent({
        user_id: phoneNumber,
        event_type: 'PIN_RESET',
        channel: (channel as 'bot' | 'frontend' | 'unknown') ?? 'unknown'
      });

      return {
        success: true,
        message: 'PIN reset successfully',
        pin_status: 'active',
        last_set_at: setPinResult.last_set_at
      };
    } catch (error) {
      Logger.error('securityService', 'resetPinWithRecovery', 'Failed to reset PIN', { error });
      return {
        success: false,
        message: 'Internal error resetting PIN'
      };
    }
  },

  /**
   * Check if an operation is allowed (gate for sensitive operations)
   */
  getOperationGate: async (phoneNumber: string): Promise<OperationGate> => {
    try {
      const status = await securityService.getSecurityStatus(phoneNumber);
      const now = new Date();

      // If PIN not set
      if (status.pin_status === 'not_set') {
        return {
          allowed: false,
          required_flow: 'security_pin_setup',
          reason: 'pin_not_set'
        };
      }

      // If PIN is blocked
      if (status.pin_status === 'blocked' && status.blocked_until && status.blocked_until > now) {
        return {
          allowed: false,
          required_flow: 'security_pin_verify',
          reason: 'pin_blocked',
          blocked_until: status.blocked_until
        };
      }

      // Allowed
      return {
        allowed: true
      };
    } catch (error) {
      Logger.error('securityService', 'getOperationGate', 'Failed to check operation gate', {
        error
      });
      // In case of error, allow operation (fail open for now)
      return {
        allowed: true
      };
    }
  }
};

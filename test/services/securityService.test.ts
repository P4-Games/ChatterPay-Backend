import { beforeEach, describe, expect, it } from 'vitest';

import { SECURITY_PIN_MAX_FAILED_ATTEMPTS } from '../../src/config/constants';
import { TemplateType } from '../../src/models/templateModel';
import { UserModel } from '../../src/models/userModel';
import { securityService } from '../../src/services/securityService';

describe('securityService', () => {
  beforeEach(async () => {
    // Create a test user
    await UserModel.create({
      phone_number: '1234567890',
      wallets: [],
      settings: {
        notifications: { language: 'en' }
      }
    });

    // Seed templates with security questions
    const mockNotification = {
      title: { en: 'Test', es: 'Prueba', pt: 'Teste' },
      message: { en: 'Test message', es: 'Mensaje de prueba', pt: 'Mensagem de teste' }
    };

    await TemplateType.create({
      notifications: {
        incoming_transfer: mockNotification,
        incoming_transfer_w_note: mockNotification,
        incoming_transfer_external: mockNotification,
        swap: mockNotification,
        mint: mockNotification,
        outgoing_transfer: mockNotification,
        wallet_creation: mockNotification,
        wallet_already_exists: mockNotification,
        user_balance_not_enough: mockNotification,
        no_valid_blockchain_conditions: mockNotification,
        concurrent_operation: mockNotification,
        internal_error: mockNotification,
        daily_limit_reached: mockNotification,
        amount_outside_limits: mockNotification,
        aave_supply_created: mockNotification,
        aave_supply_modified: mockNotification,
        aave_supply_info: mockNotification,
        aave_supply_info_no_data: mockNotification,
        chatterpoints_operation: mockNotification,
        wallet_creation_intro: mockNotification,
        wallet_already_exists_intro: mockNotification,
        deposit_from_other_networks: mockNotification,
        deposit_info_intro: mockNotification,
        wallet_next_steps: mockNotification
      },
      security_questions: {
        pet_name: {
          en: "What is your pet's name?",
          es: '¿Cuál es el nombre de tu mascota?',
          pt: 'Qual é o nome do seu animal de estimação?'
        },
        birth_city: {
          en: 'In what city were you born?',
          es: '¿En qué ciudad naciste?',
          pt: 'Em que cidade você nasceu?'
        },
        elementary_school: {
          en: 'What is the name of your elementary school?',
          es: '¿Cuál es el nombre de tu escuela primaria?',
          pt: 'Qual é o nome da sua escola primária?'
        },
        favorite_food: {
          en: 'What is your favorite food?',
          es: '¿Cuál es tu comida favorita?',
          pt: 'Qual é a sua comida favorita?'
        }
      }
    });
  });

  describe('setPin', () => {
    it('sets a valid 6-digit PIN', async () => {
      const result = await securityService.setPin('1234567890', '123456');

      expect(result.success).toBe(true);
      expect(result.pin_status).toBe('active');

      const status = await securityService.getSecurityStatus('1234567890');
      expect(status.pin_status).toBe('active');
    });

    it('rejects setting PIN when already set', async () => {
      await securityService.setPin('1234567890', '123456');

      const result = await securityService.setPin('1234567890', '654321');

      expect(result.success).toBe(false);
      expect(result.message).toContain('already set');
    });

    it('rejects PIN that is not 6 digits', async () => {
      const result = await securityService.setPin('1234567890', '12345');

      expect(result.success).toBe(false);
      expect(result.message).toContain('6 digits');
    });

    it('rejects PIN with non-numeric characters', async () => {
      const result = await securityService.setPin('1234567890', '12345a');

      expect(result.success).toBe(false);
      expect(result.message).toContain('6 digits');
    });
  });

  describe('verifyPin', () => {
    it('returns not_set status when PIN is not set', async () => {
      const result = await securityService.verifyPin('1234567890', '123456');

      expect(result.ok).toBe(false);
      expect(result.status).toBe('not_set');
    });

    it('verifies correct PIN', async () => {
      await securityService.setPin('1234567890', '123456');

      const result = await securityService.verifyPin('1234567890', '123456');

      expect(result.ok).toBe(true);
      expect(result.status).toBe('active');
    });

    it('rejects incorrect PIN', async () => {
      await securityService.setPin('1234567890', '123456');

      const result = await securityService.verifyPin('1234567890', '999999');

      expect(result.ok).toBe(false);
      expect(result.status).toBe('active');
      expect(result.remaining_attempts).toBeDefined();
    });

    it('blocks PIN after max failed attempts', async () => {
      await securityService.setPin('1234567890', '123456');

      // Try wrong PIN multiple times
      for (let i = 0; i < SECURITY_PIN_MAX_FAILED_ATTEMPTS; i++) {
        await securityService.verifyPin('1234567890', '999999');
      }

      const result = await securityService.verifyPin('1234567890', '123456');

      expect(result.ok).toBe(false);
      expect(result.status).toBe('blocked');
      expect(result.blocked_until).toBeDefined();
    });

    it('resets failed attempts after correct PIN', async () => {
      await securityService.setPin('1234567890', '123456');

      // Try wrong PIN twice
      await securityService.verifyPin('1234567890', '999999');
      await securityService.verifyPin('1234567890', '999999');

      // Correct PIN should reset counter
      const result = await securityService.verifyPin('1234567890', '123456');

      expect(result.ok).toBe(true);

      const status = await securityService.getSecurityStatus('1234567890');
      expect(status.failed_attempts).toBe(0);
    });
  });

  describe('setRecoveryQuestions', () => {
    it('requires exactly 3 questions', async () => {
      const result = await securityService.setRecoveryQuestions('1234567890', [
        { question_id: 'pet_name', answer: 'answer1' },
        { question_id: 'birth_city', answer: 'answer2' }
      ]);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Exactly 3');
    });

    it('requires unique question IDs', async () => {
      const result = await securityService.setRecoveryQuestions('1234567890', [
        { question_id: 'pet_name', answer: 'answer1' },
        { question_id: 'pet_name', answer: 'answer2' },
        { question_id: 'birth_city', answer: 'answer3' }
      ]);

      expect(result.success).toBe(false);
      expect(result.message).toContain('unique');
    });

    it('sets valid recovery questions', async () => {
      const result = await securityService.setRecoveryQuestions('1234567890', [
        { question_id: 'pet_name', answer: 'Fluffy' },
        { question_id: 'birth_city', answer: 'Paris' },
        { question_id: 'elementary_school', answer: 'Lincoln High' }
      ]);

      expect(result.success).toBe(true);
      expect(result.recovery_questions_set).toBe(true);
      expect(result.recovery_question_ids).toHaveLength(3);
    });

    it('rejects invalid question IDs', async () => {
      const result = await securityService.setRecoveryQuestions('1234567890', [
        { question_id: 'invalid_question', answer: 'answer1' },
        { question_id: 'pet_name', answer: 'answer2' },
        { question_id: 'birth_city', answer: 'answer3' }
      ]);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid');
    });
  });

  describe('resetPinWithRecovery', () => {
    beforeEach(async () => {
      // Set recovery questions using template keys
      await securityService.setRecoveryQuestions('1234567890', [
        { question_id: 'pet_name', answer: 'Fluffy' },
        { question_id: 'birth_city', answer: 'Paris' },
        { question_id: 'elementary_school', answer: 'Lincoln High' }
      ]);

      // Set initial PIN
      await securityService.setPin('1234567890', '123456');
    });

    it('resets PIN with correct answers', async () => {
      const result = await securityService.resetPinWithRecovery(
        '1234567890',
        [
          { question_id: 'pet_name', answer: 'fluffy' }, // case insensitive
          { question_id: 'birth_city', answer: 'Paris' },
          { question_id: 'elementary_school', answer: 'Lincoln High' }
        ],
        '654321'
      );

      expect(result.success).toBe(true);
      expect(result.pin_status).toBe('active');

      // Verify new PIN works
      const verifyResult = await securityService.verifyPin('1234567890', '654321');
      expect(verifyResult.ok).toBe(true);
    });

    it('fails with incorrect answers', async () => {
      const result = await securityService.resetPinWithRecovery(
        '1234567890',
        [
          { question_id: 'pet_name', answer: 'Wrong' },
          { question_id: 'birth_city', answer: 'Paris' },
          { question_id: 'elementary_school', answer: 'Lincoln High' }
        ],
        '654321'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('incorrect');

      // Old PIN should still work
      const verifyResult = await securityService.verifyPin('1234567890', '123456');
      expect(verifyResult.ok).toBe(true);
    });

    it('fails when recovery questions not set', async () => {
      await UserModel.create({
        phone_number: '9999999999',
        wallets: []
      });

      const result = await securityService.resetPinWithRecovery(
        '9999999999',
        [
          { question_id: 'pet_name', answer: 'Fluffy' },
          { question_id: 'birth_city', answer: 'Paris' },
          { question_id: 'elementary_school', answer: 'Lincoln High' }
        ],
        '654321'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('not set');
    });
  });

  describe('getOperationGate', () => {
    it('allows operation when PIN is active', async () => {
      await securityService.setPin('1234567890', '123456');

      const gate = await securityService.getOperationGate('1234567890');

      expect(gate.allowed).toBe(true);
    });

    it('blocks operation when PIN not set', async () => {
      const gate = await securityService.getOperationGate('1234567890');

      expect(gate.allowed).toBe(false);
      expect(gate.required_flow).toBe('security_pin_setup');
      expect(gate.reason).toBe('pin_not_set');
    });

    it('blocks operation when PIN is blocked', async () => {
      await securityService.setPin('1234567890', '123456');

      // Block the PIN by failing attempts
      for (let i = 0; i < SECURITY_PIN_MAX_FAILED_ATTEMPTS; i++) {
        await securityService.verifyPin('1234567890', '999999');
      }

      const gate = await securityService.getOperationGate('1234567890');

      expect(gate.allowed).toBe(false);
      expect(gate.required_flow).toBe('security_pin_verify');
      expect(gate.reason).toBe('pin_blocked');
      expect(gate.blocked_until).toBeDefined();
    });

    // Note: When SECURITY_PIN_ENABLED is false in the environment,
    // getOperationGate will always return { allowed: true } regardless of PIN state.
    // This allows transfer and swap operations to bypass PIN validation when the feature is disabled.
    // See securityService.ts getOperationGate implementation for details.
  });

  describe('listSecurityQuestions', () => {
    it('returns all questions from templates', async () => {
      const questions = await securityService.listSecurityQuestions();

      expect(questions.length).toBe(4);
      expect(questions[0].question_id).toBeDefined();
      expect(questions[0].text).toBeDefined();
      const petQuestion = questions.find((q) => q.question_id === 'pet_name');
      expect(petQuestion?.text).toBe("What is your pet's name?");
    });

    it('returns questions with localized text', async () => {
      const questionsEs = await securityService.listSecurityQuestions('es');

      expect(questionsEs.length).toBe(4);
      const petQuestion = questionsEs.find((q) => q.question_id === 'pet_name');
      expect(petQuestion).toBeDefined();
      expect(petQuestion?.text).toBe('¿Cuál es el nombre de tu mascota?');
    });

    it('returns questions with Portuguese text', async () => {
      const questionsPt = await securityService.listSecurityQuestions('pt');

      expect(questionsPt.length).toBe(4);
      const cityQuestion = questionsPt.find((q) => q.question_id === 'birth_city');
      expect(cityQuestion).toBeDefined();
      expect(cityQuestion?.text).toBe('Em que cidade você nasceu?');
    });

    it('falls back to English when language not available', async () => {
      const questions = await securityService.listSecurityQuestions('fr');

      expect(questions.length).toBe(4);
      const petQuestion = questions.find((q) => q.question_id === 'pet_name');
      expect(petQuestion?.text).toBe("What is your pet's name?");
    });

    it('returns empty array when no templates exist', async () => {
      await TemplateType.deleteMany({});

      const questions = await securityService.listSecurityQuestions('es');

      expect(questions.length).toBe(0);
    });
  });
});

import type { FastifyInstance } from 'fastify';
import {
  getSecurityEvents,
  getSecurityQuestions,
  getSecurityStatus,
  resetSecurityPin,
  setSecurityPin,
  setSecurityRecoveryQuestions,
  verifySecurityPin
} from '../controllers/securityController';

export default async function securityRoutes(fastify: FastifyInstance) {
  /**
   * @route POST /get_security_status/
   * Get current security status for a user
   */
  fastify.post('/get_security_status/', getSecurityStatus);

  /**
   * @route POST /get_security_questions/
   * Get list of available security questions
   */
  fastify.post('/get_security_questions/', getSecurityQuestions);

  /**
   * @route POST /get_security_events/
   * Get list of security events for a user
   */
  fastify.post('/get_security_events/', getSecurityEvents);

  /**
   * @route POST /set_security_pin/
   * Set or update user's security PIN
   */
  fastify.post('/set_security_pin/', setSecurityPin);

  /**
   * @route POST /verify_security_pin/
   * Verify user's security PIN
   */
  fastify.post('/verify_security_pin/', verifySecurityPin);

  /**
   * @route POST /set_security_recovery_questions/
   * Set recovery questions and answers
   */
  fastify.post('/set_security_recovery_questions/', setSecurityRecoveryQuestions);

  /**
   * @route POST /reset_security_pin/
   * Reset PIN using recovery questions
   */
  fastify.post('/reset_security_pin/', resetSecurityPin);
}

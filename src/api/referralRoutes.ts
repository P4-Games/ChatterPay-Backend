import type { FastifyInstance } from 'fastify';

import {
  getReferralByCode,
  getReferralCode,
  getReferralCodeWithUsageCount,
  submitReferralByCode
} from '../controllers/referralController';

/**
 * Configures routes related to referrals.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
const referralRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to get (or create) the referral code for a user.
   * @route POST /get_referral_code/
   */
  fastify.post('/get_referral_code/', getReferralCode);

  /**
   * Route to get the referral_by_code value for a user.
   * @route POST /get_referral_by_code/
   */
  fastify.post('/get_referral_by_code/', getReferralByCode);

  /**
   * Route to get (or create) the referral code for a user plus usage stats.
   * @route POST /get_referral_code_with_usage_count/
   */
  fastify.post('/get_referral_code_with_usage_count/', getReferralCodeWithUsageCount);

  /**
   * Route to submit the referral code of the user who referred the current user.
   * @route POST /submit_referral_by_code/
   */
  fastify.post('/submit_referral_by_code/', submitReferralByCode);
};

export default referralRoutes;

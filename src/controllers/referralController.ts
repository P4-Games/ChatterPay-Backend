import type { FastifyReply, FastifyRequest } from 'fastify';
import { COMMON_REPLY_WALLET_NOT_CREATED } from '../config/constants';
import {
  returnErrorResponse,
  returnErrorResponseAsSuccess,
  returnSuccessResponse
} from '../helpers/requestHelper';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import { referralService } from '../services/referralService';

export const getReferralCode = async (
  request: FastifyRequest<{ Body: { channel_user_id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const logKey = `[op:getReferralCode]`;
  try {
    if (!request.body) {
      return await returnErrorResponse(
        'getReferralCode',
        logKey,
        reply,
        400,
        'You have to send a body with this request'
      );
    }

    const { channel_user_id } = request.body;

    if (!channel_user_id || !isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponseAsSuccess(
        'getReferralCode',
        logKey,
        reply,
        'Missing channel_user_id in body',
        false,
        channel_user_id,
        `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
      );
    }

    const referralCode = await referralService.getOrGenerateReferralCode(channel_user_id);

    if (!referralCode) {
      return await returnErrorResponseAsSuccess(
        'getReferralCode',
        logKey,
        reply,
        COMMON_REPLY_WALLET_NOT_CREATED,
        false,
        channel_user_id
      );
    }

    return await returnSuccessResponse(reply, 'Referral code fetched successfully', {
      referral_code: referralCode
    });
  } catch (error) {
    return returnErrorResponse('getReferralCode', '', reply, 500, 'Internal Server Error');
  }
};

export const getReferralByCode = async (
  request: FastifyRequest<{ Body: { channel_user_id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const logKey = `[op:getReferralByCode]`;
  try {
    if (!request.body) {
      return await returnErrorResponse(
        'getReferralByCode',
        logKey,
        reply,
        400,
        'You have to send a body with this request'
      );
    }

    const { channel_user_id } = request.body;

    if (!channel_user_id || !isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponseAsSuccess(
        'getReferralByCode',
        logKey,
        reply,
        'Missing channel_user_id in body',
        false,
        channel_user_id,
        `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
      );
    }

    const referralByCode = await referralService.getReferralByCode(channel_user_id);

    if (referralByCode === null) {
      return await returnErrorResponseAsSuccess(
        'getReferralByCode',
        logKey,
        reply,
        COMMON_REPLY_WALLET_NOT_CREATED,
        false,
        channel_user_id
      );
    }

    const trimmedReferralByCode = (referralByCode ?? '').trim();

    if (!trimmedReferralByCode) {
      return await returnErrorResponseAsSuccess(
        'getReferralByCode',
        logKey,
        reply,
        'Referral by code not found',
        false,
        channel_user_id
      );
    }

    return await returnSuccessResponse(reply, 'Referral by code fetched successfully', {
      referral_by_code: trimmedReferralByCode
    });
  } catch (error) {
    return returnErrorResponse('getReferralByCode', '', reply, 500, 'Internal Server Error');
  }
};

export const getReferralCodeWithUsageCount = async (
  request: FastifyRequest<{ Body: { channel_user_id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const logKey = `[op:getReferralCodeWithUsageCount]`;
  try {
    if (!request.body) {
      return await returnErrorResponse(
        'getReferralCodeWithUsageCount',
        logKey,
        reply,
        400,
        'You have to send a body with this request'
      );
    }

    const { channel_user_id } = request.body;

    if (!channel_user_id || !isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponseAsSuccess(
        'getReferralCodeWithUsageCount',
        logKey,
        reply,
        'Missing channel_user_id in body',
        false,
        channel_user_id,
        `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
      );
    }

    const result = await referralService.getReferralCodeWithUsageCount(channel_user_id);
    if (!result) {
      return await returnErrorResponseAsSuccess(
        'getReferralCodeWithUsageCount',
        logKey,
        reply,
        COMMON_REPLY_WALLET_NOT_CREATED,
        false,
        channel_user_id
      );
    }

    return await returnSuccessResponse(
      reply,
      'Referral code and usage count fetched successfully',
      {
        referral_code: result.referral_code,
        referred_users_count: result.referred_users_count
      }
    );
  } catch (error) {
    return returnErrorResponse(
      'getReferralCodeWithUsageCount',
      '',
      reply,
      500,
      'Internal Server Error'
    );
  }
};

export const submitReferralByCode = async (
  request: FastifyRequest<{ Body: { channel_user_id: string; referral_by_code: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const logKey = `[op:submitReferralByCode]`;
  try {
    if (!request.body) {
      return await returnErrorResponse(
        'submitReferralByCode',
        logKey,
        reply,
        400,
        'You have to send a body with this request'
      );
    }

    const { channel_user_id, referral_by_code } = request.body;

    if (!channel_user_id || !isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponseAsSuccess(
        'submitReferralByCode',
        logKey,
        reply,
        'Missing channel_user_id in body',
        false,
        channel_user_id,
        `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
      );
    }

    const code = (referral_by_code ?? '').trim();
    if (!code) {
      return await returnErrorResponseAsSuccess(
        'submitReferralByCode',
        logKey,
        reply,
        'Missing referral_by_code in body',
        false,
        channel_user_id
      );
    }

    const result = await referralService.submitReferrerCode(channel_user_id, code);

    if (result.status === 'user_not_found') {
      return await returnErrorResponseAsSuccess(
        'submitReferralByCode',
        logKey,
        reply,
        COMMON_REPLY_WALLET_NOT_CREATED,
        false,
        channel_user_id
      );
    }

    if (result.status === 'referrer_code_not_found') {
      return await returnErrorResponseAsSuccess(
        'submitReferralByCode',
        logKey,
        reply,
        'Referrer referral code not found',
        false,
        channel_user_id
      );
    }

    if (result.status === 'self_referral') {
      return await returnErrorResponseAsSuccess(
        'submitReferralByCode',
        logKey,
        reply,
        'Self-referral is not allowed',
        false,
        channel_user_id,
        'self_referral'
      );
    }

    if (result.status === 'already_set') {
      return await returnErrorResponseAsSuccess(
        'submitReferralByCode',
        logKey,
        reply,
        'Referral_by_code already set',
        false,
        channel_user_id,
        'already_set'
      );
    }

    return await returnSuccessResponse(reply, 'Referral_by_code stored successfully', {
      updated: true
    });
  } catch (error) {
    return returnErrorResponse('submitReferralByCode', '', reply, 500, 'Internal Server Error');
  }
};

import type { FastifyReply, FastifyRequest } from 'fastify';
import { COMMON_REPLY_WALLET_NOT_CREATED } from '../config/constants';
import { Logger } from '../helpers/loggerHelper';
import {
  returnErrorResponse,
  returnErrorResponseAsSuccess,
  returnSuccessResponse
} from '../helpers/requestHelper';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import type { SecurityEventChannel } from '../models/securityEventModel';
import type { IUser } from '../models/userModel';
import { securityService } from '../services/securityService';
import { getUser } from '../services/userService';

export const getSecurityStatus = async (
  request: FastifyRequest<{ Body: { channel_user_id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const logKey = '[op:getSecurityStatus]';
  try {
    if (!request.body) {
      return await returnErrorResponse(
        'getSecurityStatus',
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

    const user: IUser | null = await getUser(channel_user_id);
    if (!user) {
      Logger.info('getSecurityStatus', COMMON_REPLY_WALLET_NOT_CREATED);
      return await returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
    }

    const status = await securityService.getSecurityStatus(channel_user_id);

    return await returnSuccessResponse(reply, 'Security status fetched successfully', {
      ...status
    });
  } catch (error) {
    return returnErrorResponse('getSecurityStatus', logKey, reply, 500, 'Internal Server Error');
  }
};

export const getSecurityQuestions = async (
  request: FastifyRequest<{ Body: { channel_user_id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const logKey = '[op:getSecurityQuestions]';
  try {
    if (!request.body) {
      return await returnErrorResponse(
        'getSecurityStatus',
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

    const user: IUser | null = await getUser(channel_user_id);
    if (!user) {
      Logger.info('getSecurityStatus', COMMON_REPLY_WALLET_NOT_CREATED);
      return await returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
    }

    const questions = await securityService.listSecurityQuestions(
      user.settings?.notifications.language,
      channel_user_id
    );

    return await returnSuccessResponse(reply, 'Security questions fetched successfully', {
      questions
    });
  } catch (error) {
    return returnErrorResponse('getSecurityQuestions', logKey, reply, 500, 'Internal Server Error');
  }
};

export const setSecurityPin = async (
  request: FastifyRequest<{
    Body: { channel_user_id: string; pin: string; channel?: SecurityEventChannel };
  }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const logKey = '[op:setSecurityPin]';
  try {
    if (!request.body) {
      return await returnErrorResponse(
        'setSecurityPin',
        logKey,
        reply,
        400,
        'You have to send a body with this request'
      );
    }

    const { channel_user_id, pin, channel } = request.body;

    if (!channel_user_id) {
      return await returnErrorResponse(
        'setSecurityPin',
        logKey,
        reply,
        400,
        'channel_user_id is required'
      );
    }

    if (!isValidPhoneNumber(channel_user_id)) {
      const msgError = `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`;
      return await returnErrorResponse('setSecurityPin', logKey, reply, 400, msgError);
    }

    const user: IUser | null = await getUser(channel_user_id);
    if (!user) {
      Logger.info('setSecurityPin', COMMON_REPLY_WALLET_NOT_CREATED);
      return await returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
    }

    if (!pin) {
      return await returnErrorResponseAsSuccess(
        'setSecurityPin',
        logKey,
        reply,
        'Missing pin in body',
        false,
        channel_user_id
      );
    }

    const result = await securityService.setPin(channel_user_id, pin, channel, false);

    if (!result.success) {
      return await returnErrorResponseAsSuccess(
        'setSecurityPin',
        logKey,
        reply,
        result.message,
        false,
        channel_user_id
      );
    }

    return await returnSuccessResponse(reply, result.message, {
      updated: true,
      pin_status: result.pin_status,
      last_set_at: result.last_set_at
    });
  } catch (error) {
    return returnErrorResponse('setSecurityPin', logKey, reply, 500, 'Internal Server Error');
  }
};

export const verifySecurityPin = async (
  request: FastifyRequest<{
    Body: { channel_user_id: string; pin: string; channel?: SecurityEventChannel };
  }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const logKey = '[op:verifySecurityPin]';
  try {
    if (!request.body) {
      return await returnErrorResponse(
        'verifySecurityPin',
        logKey,
        reply,
        400,
        'You have to send a body with this request'
      );
    }

    const { channel_user_id, pin, channel } = request.body;

    if (!channel_user_id) {
      return await returnErrorResponse(
        'verifySecurityPin',
        logKey,
        reply,
        400,
        'channel_user_id is required'
      );
    }

    if (!isValidPhoneNumber(channel_user_id)) {
      const msgError = `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`;
      return await returnErrorResponse('verifySecurityPin', logKey, reply, 400, msgError);
    }

    const user: IUser | null = await getUser(channel_user_id);
    if (!user) {
      Logger.info('verifySecurityPin', COMMON_REPLY_WALLET_NOT_CREATED);
      return await returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
    }

    if (!pin) {
      return await returnErrorResponseAsSuccess(
        'verifySecurityPin',
        logKey,
        reply,
        'Missing pin in body',
        false,
        channel_user_id
      );
    }

    const result = await securityService.verifyPin(channel_user_id, pin, channel);

    return await returnSuccessResponse(reply, 'PIN verification completed', {
      ok: result.ok,
      pin_status: result.status,
      blocked_until: result.blocked_until,
      remaining_attempts: result.remaining_attempts
    });
  } catch (error) {
    return returnErrorResponse('verifySecurityPin', logKey, reply, 500, 'Internal Server Error');
  }
};

export const setSecurityRecoveryQuestions = async (
  request: FastifyRequest<{
    Body: {
      channel_user_id: string;
      questions: Array<{ question_id: string; answer: string }>;
      channel?: SecurityEventChannel;
    };
  }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const logKey = '[op:setSecurityRecoveryQuestions]';
  try {
    if (!request.body) {
      return await returnErrorResponse(
        'setSecurityRecoveryQuestions',
        logKey,
        reply,
        400,
        'You have to send a body with this request'
      );
    }

    const { channel_user_id, questions, channel } = request.body;

    if (!channel_user_id) {
      return await returnErrorResponse(
        'setSecurityRecoveryQuestions',
        logKey,
        reply,
        400,
        'channel_user_id is required'
      );
    }

    if (!isValidPhoneNumber(channel_user_id)) {
      const msgError = `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`;
      return await returnErrorResponse(
        'setSecurityRecoveryQuestions',
        logKey,
        reply,
        400,
        msgError
      );
    }

    const user: IUser | null = await getUser(channel_user_id);
    if (!user) {
      Logger.info('setSecurityRecoveryQuestions', COMMON_REPLY_WALLET_NOT_CREATED);
      return await returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
    }

    if (!questions || !Array.isArray(questions)) {
      return await returnErrorResponseAsSuccess(
        'setSecurityRecoveryQuestions',
        logKey,
        reply,
        'Missing or invalid questions in body',
        false,
        channel_user_id
      );
    }

    const result = await securityService.setRecoveryQuestions(channel_user_id, questions, channel);

    if (!result.success) {
      return await returnErrorResponseAsSuccess(
        'setSecurityRecoveryQuestions',
        logKey,
        reply,
        result.message,
        false,
        channel_user_id
      );
    }

    return await returnSuccessResponse(reply, result.message, {
      updated: true,
      recovery_questions_set: result.recovery_questions_set,
      recovery_question_ids: result.recovery_question_ids
    });
  } catch (error) {
    return returnErrorResponse(
      'setSecurityRecoveryQuestions',
      logKey,
      reply,
      500,
      'Internal Server Error'
    );
  }
};

export const resetSecurityPin = async (
  request: FastifyRequest<{
    Body: {
      channel_user_id: string;
      new_pin: string;
      answers: Array<{ question_id: string; answer: string }>;
      channel?: SecurityEventChannel;
    };
  }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const logKey = '[op:resetSecurityPin]';
  try {
    if (!request.body) {
      return await returnErrorResponse(
        'resetSecurityPin',
        logKey,
        reply,
        400,
        'You have to send a body with this request'
      );
    }

    const { channel_user_id, new_pin, answers, channel } = request.body;

    if (!channel_user_id) {
      return await returnErrorResponse(
        'resetSecurityPin',
        logKey,
        reply,
        400,
        'channel_user_id is required'
      );
    }

    if (!isValidPhoneNumber(channel_user_id)) {
      const msgError = `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`;
      return await returnErrorResponse('resetSecurityPin', logKey, reply, 400, msgError);
    }

    const user: IUser | null = await getUser(channel_user_id);
    if (!user) {
      Logger.info('resetSecurityPin', COMMON_REPLY_WALLET_NOT_CREATED);
      return await returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
    }

    if (!new_pin) {
      return await returnErrorResponseAsSuccess(
        'resetSecurityPin',
        logKey,
        reply,
        'Missing new_pin in body',
        false,
        channel_user_id
      );
    }

    if (!answers || !Array.isArray(answers)) {
      return await returnErrorResponseAsSuccess(
        'resetSecurityPin',
        logKey,
        reply,
        'Missing or invalid answers in body',
        false,
        channel_user_id
      );
    }

    const result = await securityService.resetPinWithRecovery(
      channel_user_id,
      answers,
      new_pin,
      channel
    );

    if (!result.success) {
      return await returnErrorResponseAsSuccess(
        'resetSecurityPin',
        logKey,
        reply,
        result.message,
        false,
        channel_user_id
      );
    }

    return await returnSuccessResponse(reply, result.message, {
      updated: true,
      pin_status: result.pin_status,
      last_set_at: result.last_set_at
    });
  } catch (error) {
    return returnErrorResponse('resetSecurityPin', logKey, reply, 500, 'Internal Server Error');
  }
};

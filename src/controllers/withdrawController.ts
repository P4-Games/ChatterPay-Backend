import { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { withdrawWalletAllFunds } from '../services/transferService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { isValidPhoneNumber, isValidEthereumWallet } from '../helpers/validationHelper';

/**
 * Handles the withdrawal of all funds.
 * @param {FastifyRequest<{ Body: { channel_user_id: string, dst_address: string } }>} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} The Fastify reply object.
 */
export const withdrawAllFunds = async (
  request: FastifyRequest<{
    Body: {
      channel_user_id: string;
      dst_address: string;
    };
  }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  let logKey = `[op:withdrawAllFunds:${''}:${''}]`;

  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'Request body is required');
    }

    const { channel_user_id, dst_address } = request.body;

    if (!channel_user_id) {
      return await returnErrorResponse(reply, 400, 'Missing "channel_user_id" in the request body');
    }

    if (!dst_address) {
      return await returnErrorResponse(reply, 400, 'Missing "dst_address" in the request body');
    }

    if (!isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponse(
        reply,
        400,
        `'${channel_user_id}' is invalid. "channel_user_id" must be a valid phone number (without spaces or symbols)`
      );
    }

    if (!isValidEthereumWallet(dst_address)) {
      return await returnErrorResponse(reply, 400, 'Invalid Ethereum wallet address');
    }

    logKey = `[op:withdrawAllFunds:${channel_user_id}:${dst_address}]`;
    const fastify = request.server;
    const withdrawResult = await withdrawWalletAllFunds(
      fastify.tokens,
      fastify.networkConfig,
      channel_user_id,
      dst_address,
      logKey
    );

    if (withdrawResult.result) {
      Logger.info('withdrawAllFunds', logKey, 'All funds withdrawn successfully');
      return await returnSuccessResponse(reply, 'All funds withdrawn successfully');
    }

    return await returnErrorResponse(reply, 400, withdrawResult.message);
  } catch (error) {
    Logger.error('withdrawAllFunds', logKey, error);
    return returnErrorResponse(reply, 400, 'An error occurred while withdrawing all funds');
  }
};

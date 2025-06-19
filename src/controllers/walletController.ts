import { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { withdrawWalletAllFunds } from '../services/transferService';
import { IS_DEVELOPMENT, ISSUER_TOKENS_ENABLED } from '../config/constants';
import { tryIssueTokens, createOrReturnWallet } from '../services/walletService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { isValidPhoneNumber, isValidEthereumWallet } from '../helpers/validationHelper';

/**
 * Handles the creation of a new wallet for the user.
 * @param {FastifyRequest<{ Body: { channel_user_id: string } }>} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object used to send the response.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing the result.
 */
export const createWallet = async (
  request: FastifyRequest<{ Body: { channel_user_id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  let logKey = `[op:createWallet:${''}]`;

  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const { channel_user_id } = request.body;

    if (!channel_user_id) {
      return await returnErrorResponse(reply, 400, 'Missing channel_user_id in body');
    }

    if (!isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponse(
        reply,
        400,
        `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
      );
    }

    logKey = `[op:createWallet:${channel_user_id}]`;

    const { networkConfig, tokens } = request.server;

    const { message, walletAddress, wasWalletCreated } = await createOrReturnWallet(
      channel_user_id,
      networkConfig,
      logKey
    );

    if (
      wasWalletCreated &&
      networkConfig.environment.toUpperCase() !== 'PRODUCTION' &&
      IS_DEVELOPMENT &&
      ISSUER_TOKENS_ENABLED
    ) {
      Logger.log('createWallet', logKey, `Issuing tokens for ${walletAddress}`);
      await tryIssueTokens(walletAddress, tokens, networkConfig);
    }

    Logger.log('createWallet', logKey, `${message}, ${walletAddress}`);
    return await returnSuccessResponse(reply, message, { walletAddress });
  } catch (error) {
    Logger.error('createWallet', logKey, error);
    return returnErrorResponse(reply, 400, 'An error occurred while creating the wallet');
  }
};

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

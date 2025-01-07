import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest } from 'fastify';

import { withdrawWalletAllFunds } from '../services/transferService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';

/**
 * Handles the withdrwal all funds
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
  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const { channel_user_id, dst_address } = request.body;
    if (!channel_user_id) {
      return await returnErrorResponse(reply, 400, 'Missing channel_user_id in body');
    }

    if (!dst_address) {
      return await returnErrorResponse(reply, 400, 'Missing dst_address in body');
    }

    if (!channel_user_id || channel_user_id.length > 15) {
      return await returnErrorResponse(reply, 400, 'Phone number is invalid');
    }

    if (!ethers.utils.isAddress(dst_address)) {
      return await returnErrorResponse(reply, 400, 'Invalid Ethereum address');
    }

    const fastify = request.server;
    const witthdrawResult = await withdrawWalletAllFunds(
      fastify.tokens,
      fastify.networkConfig,
      channel_user_id,
      dst_address
    );

    if (witthdrawResult.result) {
      return await returnSuccessResponse(reply, 'Withdraw all funds completed successfully');
    }

    return await returnErrorResponse(reply, 400, witthdrawResult.message);
  } catch (error) {
    return returnErrorResponse(reply, 400, 'An error occurred while withdrawing all funds');
  }
};

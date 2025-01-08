import { FastifyReply, FastifyRequest } from 'fastify';

import { User, IUser } from '../models/user';
import { Logger } from '../helpers/loggerHelper';
import { createUserWithWallet } from '../services/userService';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';

/**
 * Handles the creation of a new wallet.
 * @param {FastifyRequest<{ Body: { channel_user_id: string } }>} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} The Fastify reply object.
 */
export const createWallet = async (
  request: FastifyRequest<{
    Body: {
      channel_user_id: string;
    };
  }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
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

    // Check if user already exists
    const existingUser = await User.findOne({ channel_user_id });
    if (existingUser) {
      return await returnSuccessResponse(
        reply,
        `The user already exists, your wallet is ${existingUser.wallet}`
      );
    }

    Logger.log(`Creating wallet for phone number ${channel_user_id}`);
    const user: IUser = await createUserWithWallet(channel_user_id);

    return await returnSuccessResponse(reply, 'The wallet was created successfully!', {
      walletAddress: user.wallet
    });
  } catch (error) {
    Logger.error('Error creando una wallet:', error);
    return returnErrorResponse(reply, 400, 'An error occurred while creating the wallet');
  }
};

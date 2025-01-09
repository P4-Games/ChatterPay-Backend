import { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { IUser, IUserWallet } from '../models/user';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import {
  getUser,
  addWalletToUser,
  createUserWithWallet,
  getUserWalletByChainId
} from '../services/userService';

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
    const existingUser = await getUser(channel_user_id);
    let userWallet: IUserWallet | null;

    if (existingUser) {
      const fastify = request.server;
      const { chain_id } = fastify.networkConfig;
      userWallet = getUserWalletByChainId(existingUser.wallets, chain_id);

      if (userWallet) {
        return await returnSuccessResponse(
          reply,
          `The user already exists, your wallet is ${userWallet}.`
        );
      }
      Logger.log(`Creating wallet for phone number ${channel_user_id} and chain_id ${chain_id}`);
      const chatterpayImplementationContract: string =
        fastify.networkConfig.contracts.chatterPayAddress;
      const result: { user: IUser; newWallet: IUserWallet } | null = await addWalletToUser(
        channel_user_id,
        chain_id,
        chatterpayImplementationContract
      );

      if (result) {
        userWallet = result.newWallet;
        return await returnSuccessResponse(reply, 'The wallet was created successfully!', {
          walletAddress: userWallet.wallet_proxy
        });
      }
      return await returnErrorResponse(
        reply,
        400,
        `Error creating wallet for user '${channel_user_id}' and chain ${chain_id}`
      );
    }

    Logger.log(`Creating wallet for phone number ${channel_user_id}`);
    const user: IUser = await createUserWithWallet(channel_user_id);

    return await returnSuccessResponse(reply, 'The wallet was created successfully!', {
      walletAddress: user.wallets[0].wallet_proxy
    });
  } catch (error) {
    Logger.error('Error creating wallet:', error);
    return returnErrorResponse(reply, 400, 'An error occurred while creating the wallet');
  }
};

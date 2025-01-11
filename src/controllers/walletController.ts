import { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { getUser } from '../services/mongoService';
import { IUser, IUserWallet } from '../models/user';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import {
  addWalletToUser,
  createUserWithWallet,
  getUserWalletByChainId
} from '../services/userService';

/**
 * Handles the creation of a new wallet for the user.
 * @param {FastifyRequest<{ Body: { channel_user_id: string } }>} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object used to send the response.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing the result.
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
    // Check if the request body is present
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const { channel_user_id } = request.body;

    // Check if channel_user_id is provided
    if (!channel_user_id) {
      return await returnErrorResponse(reply, 400, 'Missing channel_user_id in body');
    }

    // Validate phone number format
    if (!isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponse(
        reply,
        400,
        `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
      );
    }

    // Check if user already exists
    const fastify = request.server;
    const existingUser = await getUser(channel_user_id);
    let userWallet: IUserWallet | null;

    if (existingUser) {
      // Check for existing wallet for the user in the given blockchain
      const { chain_id } = fastify.networkConfig;
      userWallet = getUserWalletByChainId(existingUser.wallets, chain_id);

      if (userWallet) {
        // Return the existing wallet address if found
        return await returnSuccessResponse(
          reply,
          `The user already exists, your wallet is ${userWallet.wallet_proxy}.`
        );
      }

      // Create a new wallet if not found
      Logger.log(
        'createWallet',
        `Creating wallet for phone number ${channel_user_id} and chain_id ${chain_id}`
      );
      const chatterpayImplementationContract: string =
        fastify.networkConfig.contracts.chatterPayAddress;
      const result: { user: IUser; newWallet: IUserWallet } | null = await addWalletToUser(
        channel_user_id,
        chain_id,
        chatterpayImplementationContract
      );

      if (result) {
        // Return the new wallet address
        userWallet = result.newWallet;
        return await returnSuccessResponse(reply, 'The wallet was created successfully!', {
          walletAddress: userWallet.wallet_proxy
        });
      }

      // Return an error if wallet creation fails
      return await returnErrorResponse(
        reply,
        400,
        `Error creating wallet for user '${channel_user_id}' and chain ${chain_id}`
      );
    }

    // Create a new user and wallet if the user does not exist
    Logger.log('createWallet', `Creating wallet for phone number ${channel_user_id}`);
    const chatterpayImplementation = fastify.networkConfig.contracts.chatterPayAddress;
    const user: IUser = await createUserWithWallet(channel_user_id, chatterpayImplementation);

    // Return the wallet address of the newly created user
    return await returnSuccessResponse(reply, 'The wallet was created successfully!', {
      walletAddress: user.wallets[0].wallet_proxy
    });
  } catch (error) {
    // Log and handle errors
    Logger.error('createWallet', error);
    return returnErrorResponse(reply, 400, 'An error occurred while creating the wallet');
  }
};

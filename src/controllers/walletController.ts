import { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { IUser, IUserWallet } from '../models/userModel';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import { tryIssueTokens } from '../services/predictWalletService';
import { mongoUserService } from '../services/mongo/mongoUserService';
import { IS_DEVELOPMENT, ISSUER_TOKENS_ENABLED } from '../config/constants';
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

    const fastify = request.server;
    logKey = `[op:createWallet:${channel_user_id || ''}]`;

    // Intentionally leave a blank line at the beginning of the message!
    const NETWORK_WARNING = `

⚠️ Important: If you plan to send crypto to this wallet from an external platform (like a wallet or exchange), make sure to use the *${fastify.networkConfig.name} network* and double-check the address.
ChatterPay can’t reverse transactions made outside of our app, such as when the wrong network is selected or the wallet address is mistyped.`;

    const existingUser = await mongoUserService.getUser(channel_user_id);
    let userWallet: IUserWallet | null;

    const issuerTokensEnabled: boolean =
      fastify.networkConfig.environment.toUpperCase() !== 'PRODUCTION' &&
      IS_DEVELOPMENT &&
      ISSUER_TOKENS_ENABLED;

    if (existingUser) {
      // Check for existing wallet for the user in the given blockchain
      const { chainId: chain_id } = fastify.networkConfig;
      userWallet = getUserWalletByChainId(existingUser.wallets, chain_id);

      if (userWallet) {
        // Return the existing wallet address if found
        const message = `The user already exists, your wallet is ${userWallet.wallet_proxy}. 
          ${NETWORK_WARNING}`;
        Logger.log('createWallet', logKey, message);
        return await returnSuccessResponse(reply, message);
      }

      // Create a new wallet if not found
      Logger.log(
        'createWallet',
        logKey,
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
        userWallet = result.newWallet;

        if (issuerTokensEnabled) {
          Logger.log('createWallet', logKey, `Issue Tokens for ${userWallet.wallet_proxy}`);
          await tryIssueTokens(
            userWallet.wallet_proxy,
            request.server.tokens,
            request.server.networkConfig
          );
        }

        const returnMsg = `The wallet was created successfully!. 
            ${NETWORK_WARNING}`;
        Logger.log('createWallet', logKey, `${returnMsg},${userWallet.wallet_proxy}`);
        return await returnSuccessResponse(reply, returnMsg, {
          walletAddress: userWallet.wallet_proxy
        });
      }

      const errorMsg = `Error creating wallet for user '${channel_user_id}' and chain ${chain_id}`;
      Logger.error('createWallet', logKey, errorMsg);
      return await returnErrorResponse(reply, 400, errorMsg);
    }

    Logger.log('createWallet', logKey, `Creating wallet for phone number ${channel_user_id}`);
    const chatterpayImplementation = fastify.networkConfig.contracts.chatterPayAddress;
    const user: IUser = await createUserWithWallet(channel_user_id, chatterpayImplementation);

    if (issuerTokensEnabled) {
      Logger.log('createWallet', logKey, `Issue Tokens for ${user.wallets[0].wallet_proxy}`);
      await tryIssueTokens(
        user.wallets[0].wallet_proxy,
        request.server.tokens,
        request.server.networkConfig
      );
    }

    const returnMsg = `The wallet was created successfully!. 
          ${NETWORK_WARNING}`;
    Logger.log('createWallet', logKey, `${returnMsg},${user.wallets[0].wallet_proxy}`);
    return await returnSuccessResponse(reply, returnMsg, {
      walletAddress: user.wallets[0].wallet_proxy
    });
  } catch (error) {
    Logger.error('createWallet', logKey, error);
    return returnErrorResponse(reply, 400, 'An error occurred while creating the wallet');
  }
};

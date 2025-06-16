import { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import Token, { IToken } from '../models/tokenModel';
import { issueTokens } from '../services/walletService';
import { IUser, IUserWallet } from '../models/userModel';
import { getUser, getUserWalletByChainId } from '../services/userService';
import { coingeckoService } from '../services/coingecko/coingeckoService';
import { IS_DEVELOPMENT, COMMON_REPLY_WALLET_NOT_CREATED } from '../config/constants';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { isValidPhoneNumber, isValidEthereumWallet } from '../helpers/validationHelper';

/**
 * Creates a new token.
 * @param {FastifyRequest<{ Body: IToken }>} request - The Fastify request object containing the token data in the body.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object.
 */
export const createToken = async (
  request: FastifyRequest<{ Body: IToken }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You must send a body with this request.');
    }

    const newToken = new Token(request.body);
    if (!newToken) {
      return await returnErrorResponse(
        reply,
        400,
        'Missing parameters in body. You must send: newToken.'
      );
    }

    await newToken.save();
    return await returnSuccessResponse(reply, 'Token created successfully', newToken.toJSON());
  } catch (error) {
    Logger.error('createToken', error);
    return returnErrorResponse(reply, 400, 'Error creating token', (error as Error).message);
  }
};

/**
 * Retrieves all tokens.
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing all tokens.
 */
export const getAllTokens = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    // Use the cached tokens from the Fastify instance.
    const { tokens } = request.server;
    return await returnSuccessResponse(reply, 'Tokens fetched successfully', { tokens });
  } catch (error) {
    Logger.error('getAllTokens', error);
    return returnErrorResponse(reply, 400, 'Failed to fetch tokens');
  }
};

/**
 * Retrieves all token conversion rates from the CoinGecko service.
 *
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object used to send the response.
 * @returns {Promise<FastifyReply>} A promise that resolves with the Fastify reply containing the token conversion rates.
 */
export const getAllTokenConvertionRates = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    const rates = await coingeckoService.getConversationRates();
    return await returnSuccessResponse(reply, 'Tokens conversion rates fetched successfully', {
      rates
    });
  } catch (error) {
    Logger.error('getAllTokenConvertionRates', error);
    return returnErrorResponse(reply, 400, 'Failed to fetch tokens conversion rates');
  }
};

/**
 * Retrieves a token by its ID.
 * @param {FastifyRequest<{ Params: { id: string } }>} request - The Fastify request object containing the token ID in the params.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing the found token or an error message.
 */
export const getTokenById = async (
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const { id } = request.params as { id: string };

  try {
    // Use the cached tokens from the Fastify instance.
    const { tokens } = request.server;

    // Find the token in the cached array.
    const token = tokens.find((tokenItem: IToken) => tokenItem.id.toString() === id);

    if (!token) {
      return await returnErrorResponse(reply, 404, 'Token not found');
    }

    return await returnSuccessResponse(reply, 'Token fetched successfully', token.toJSON());
  } catch (error) {
    Logger.error('getTokenById', error);
    return returnErrorResponse(reply, 400, 'Failed to fetch token');
  }
};

/**
 * Updates a token by its ID.
 * @param {FastifyRequest<{ Params: { id: string }, Body: Partial<IToken> }>} request - The Fastify request object containing the token ID in the params and update data in the body.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing the updated token or an error message.
 */
export const updateToken = async (
  request: FastifyRequest<{ Params: { id: string }; Body: Partial<IToken> }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const { id } = request.params as { id: string };

  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You must send a body with this request.');
    }

    const updatedToken = await Token.findByIdAndUpdate(id, request.body, { new: true });

    if (!updatedToken) {
      return await returnErrorResponse(reply, 404, 'Token not found');
    }

    return await returnSuccessResponse(reply, 'Token updated successfully', updatedToken.toJSON());
  } catch (error) {
    Logger.error('updateToken', error);
    return returnErrorResponse(reply, 400, 'Failed to update token');
  }
};

/**
 * Deletes a token by its ID.
 * @param {FastifyRequest<{ Params: { id: string } }>} request - The Fastify request object containing the token ID in the params.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing a success message or an error message.
 */
export const deleteToken = async (
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const { id } = request.params as { id: string };

  try {
    const deletedToken = await Token.findByIdAndDelete(id);

    if (!deletedToken) {
      return await returnErrorResponse(reply, 404, 'Token not found');
    }

    return await returnSuccessResponse(reply, 'Token deleted successfully');
  } catch (error) {
    Logger.error('deleteToken', error);
    return returnErrorResponse(reply, 400, 'Failed to delete token');
  }
};

/**
 * Fastify route handler for issuing tokens.
 *
 * @param request - The Fastify request object containing the recipient's address.
 * @param reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object.
 */
export const issueTokensHandler = async (
  request: FastifyRequest<{ Body: { identifier: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  type RequestBody = {
    identifier: string;
  };

  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You must send a body with this request.');
    }

    const fastify = request.server;
    if (fastify.networkConfig.environment.toUpperCase() === 'PRODUCTION' || !IS_DEVELOPMENT) {
      return await returnErrorResponse(
        reply,
        401,
        'This endpoint is disabled on the production blockchains.'
      );
    }

    const { identifier } = request.body as RequestBody;
    if (!identifier) {
      return await returnErrorResponse(
        reply,
        400,
        'Missing parameters in body. You must send: an identifier (ddress or phone number).'
      );
    }

    if (!isValidEthereumWallet(identifier) && !isValidPhoneNumber(identifier)) {
      const validationError: string = `'${identifier}' is invalid. It must be a Wallet or phone number (without spaces or symbols)`;
      Logger.info('issueTokensHandler', validationError);
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, validationError);
    }

    let finalAddress: string = identifier;

    if (!identifier.toLowerCase().startsWith('0x')) {
      const fromUser: IUser | null = await getUser(identifier);
      if (!fromUser) {
        Logger.info('issueTokensHandler', COMMON_REPLY_WALLET_NOT_CREATED);
        // must return 200, so the bot displays the message instead of an error!
        return await returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
      }
      const userWallet: IUserWallet | null = getUserWalletByChainId(
        fromUser?.wallets,
        fastify.networkConfig.chainId
      );
      if (!userWallet) {
        const validationError: string = `Wallet not found for user ${identifier} and chain ${fastify.networkConfig.chainId}`;
        Logger.info('issueTokensHandler', validationError);
        // must return 200, so the bot displays the message instead of an error!
        return await returnSuccessResponse(reply, validationError);
      }
      finalAddress = userWallet.wallet_proxy;
    }

    const results = await issueTokens(
      finalAddress,
      request.server.tokens,
      request.server.networkConfig
    );
    return await returnSuccessResponse(reply, 'Tokens minted successfully', { results });
  } catch (error: unknown) {
    Logger.error('issueTokensHandler', error);
    if (error instanceof Error) {
      return returnErrorResponse(reply, 400, 'Bad Request', error.message);
    }
    return returnErrorResponse(reply, 400, 'Bad Request');
  }
};

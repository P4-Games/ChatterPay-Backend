import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import Token, { IToken } from '../models/tokenModel';
import { SIGNING_KEY, IS_DEVELOPMENT } from '../config/constants';
import { coingeckoService } from '../services/coingecko/coingeckoService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';

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

// Tokens issuing related functions (to be removed in mainnet).

/**
 * Represents the result of a token minting operation.
 */
interface MintResult {
  /** The address of the token contract. */
  tokenAddress: string;
  /** The transaction hash of the minting operation. */
  txHash: string;
}

/**
 * Mints a specified amount of tokens for a given address.
 *
 * @param signer - The ethers.Wallet instance used to sign the transaction.
 * @param tokenAddress - The address of the token contract.
 * @param recipientAddress - The address to receive the minted tokens.
 * @param amount - The amount of tokens to mint (as a string).
 * @param nonce - The nonce to use for the transaction.
 * @returns A promise that resolves to a MintResult object.
 */
async function mintToken(
  signer: ethers.Wallet,
  tokenAddress: string,
  recipientAddress: string,
  amount: string,
  nonce: number
): Promise<MintResult> {
  const erc20Contract: ethers.Contract = new ethers.Contract(
    tokenAddress,
    ['function mint(address to, uint256 amount)', 'function decimals() view returns (uint8)'],
    signer
  );

  const decimals = await erc20Contract.decimals();
  const amountBN: ethers.BigNumber = ethers.utils.parseUnits(amount, decimals);
  const gasLimit: number = 5000000; // Set a reasonable gas limit.

  // Estimate gas price.
  const gasPrice: ethers.BigNumber = await signer.provider!.getGasPrice();

  // Increase gas price by 20% to ensure the transaction goes through.
  const adjustedGasPrice: ethers.BigNumber = gasPrice.mul(120).div(100);

  const tx: ethers.ContractTransaction = await erc20Contract.mint(recipientAddress, amountBN, {
    gasLimit,
    nonce,
    gasPrice: adjustedGasPrice
  });

  return {
    tokenAddress,
    txHash: tx.hash
  };
}

/**
 * Issues a specified amount of tokens to a given address.
 *
 * @param recipientAddress - The address to receive the minted tokens.
 * @returns A promise that resolves to an array of MintResult objects.
 */
export async function issueTokensCore(
  recipientAddress: string,
  fastify: FastifyInstance
): Promise<MintResult[]> {
  const amount: string = '100';
  const { networkConfig, tokens } = fastify;

  // Create provider using network config from decorator.
  const provider: ethers.providers.JsonRpcProvider = new ethers.providers.JsonRpcProvider(
    networkConfig.rpc
  );
  const signer: ethers.Wallet = new ethers.Wallet(SIGNING_KEY!, provider);

  // Get tokens for the current chain from the decorator.
  const chainTokens = tokens.filter((token) => token.chain_id === networkConfig.chainId);
  const tokenAddresses: string[] = chainTokens.map((token) => token.address);

  if (tokenAddresses.length === 0) {
    throw new Error(`No tokens found for chain ${networkConfig.chainId}`);
  }

  // Get the current nonce for the signer.
  const currentNonce: number = await provider.getTransactionCount(signer.address);
  Logger.log('issueTokensCore', `Current Nonce: ${currentNonce}`);
  Logger.log(
    'issueTokensCore',
    `Minting tokens on chain ${networkConfig.chainId} for wallet ${recipientAddress} and tokens:`,
    tokenAddresses
  );

  const mintPromises: Promise<MintResult>[] = tokenAddresses.map((tokenAddress, index) =>
    mintToken(signer, tokenAddress, recipientAddress, amount, currentNonce + index)
  );

  const mintResults = await Promise.all(mintPromises);

  return mintResults;
}

/**
 * Fastify route handler for issuing tokens.
 *
 * @param request - The Fastify request object containing the recipient's address.
 * @param reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object.
 */
export const issueTokensHandler = async (
  request: FastifyRequest<{ Body: { address: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
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

    const { address }: { address: string } = request.body;
    if (!address) {
      return await returnErrorResponse(
        reply,
        400,
        'Missing parameters in body. You must send: address.'
      );
    }

    const results = await issueTokensCore(address, request.server);

    return await returnSuccessResponse(reply, 'Tokens minted successfully', { results });
  } catch (error) {
    Logger.error('issueTokensHandler', error);
    if (error instanceof Error) {
      return returnErrorResponse(reply, 400, 'Bad Request', error.message);
    }
    return returnErrorResponse(reply, 400, 'Bad Request');
  }
};

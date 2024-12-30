import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { User } from '../models/user';
import { getPhoneNFTs } from './nftController';
import { fetchExternalDeposits } from '../services/externalDepositsService';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';
import {
  getFiatQuotes,
  getTokenBalances,
  calculateBalances,
  calculateBalancesTotals
} from '../services/walletService';

/**
 * Route handler for checking external deposits
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Promise resolving to deposits status
 */
export const checkExternalDeposits = async (request: FastifyRequest, reply: FastifyReply) => {
  const depositsStatus = await fetchExternalDeposits();
  return reply.status(200).send({ status: depositsStatus });
};

/**
 * Fetches and calculates balance information for a given address
 * @param address - Address to get balance for
 * @param reply - Fastify reply object
 * @param fastify - Fastify instance containing global state
 * @returns Fastify reply with balance information
 */
async function getAddressBalance(
  address: string,
  reply: FastifyReply,
  fastify: FastifyInstance
): Promise<FastifyReply> {
  const { networkConfig } = fastify;

  console.log(`Fetching balance for address: ${address} on network ${networkConfig.name}`);
  const user = await User.findOne({ wallet: address });

  if (!user) {
    return returnErrorResponse(reply, 404, 'User not found');
  }

  try {
    const [fiatQuotes, tokenBalances, NFTs] = await Promise.all([
      getFiatQuotes(),
      getTokenBalances(address, fastify.tokens, networkConfig),
      getPhoneNFTs(user.phone_number)
    ]);

    const balances = calculateBalances(tokenBalances, fiatQuotes, networkConfig.name);
    const totals = calculateBalancesTotals(balances);

    const response = {
      balances,
      totals,
      certificates: NFTs.nfts,
      wallet: address
    };

    return await returnSuccessResponse(reply, 'Wallet balance fetched successfully', response);
  } catch (error) {
    console.error('Error fetching wallet balance:', error);
    return returnErrorResponse(reply, 500, 'Internal Server Error');
  }
}

/**
 * Route handler for getting wallet balance
 */
export const walletBalance = async (
  request: FastifyRequest<{ Params: { wallet: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const { wallet } = request.params;

  if (!wallet) {
    console.warn('Wallet address is required');
    return returnErrorResponse(reply, 400, 'Wallet address is required');
  }

  return getAddressBalance(wallet, reply, request.server);
};

/**
 * Route handler for getting balance by phone number
 */
export const balanceByPhoneNumber = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const { channel_user_id: phone } = request.query as { channel_user_id?: string };

  if (!phone) {
    console.warn('Phone number is required');
    return returnErrorResponse(reply, 400, 'Phone number is required');
  }

  try {
    const user = await User.findOne({ phone_number: phone });

    if (!user) {
      console.warn(`User not found for phone number: ${phone}`);
      return await returnErrorResponse(reply, 404, 'User not found');
    }

    return await getAddressBalance(user.wallet, reply, request.server);
  } catch (error) {
    console.error('Error fetching user balance:', error);
    return returnErrorResponse(reply, 500, 'Internal Server Error');
  }
};

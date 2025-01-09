import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { getPhoneNFTs } from './nftController';
import { Logger } from '../helpers/loggerHelper';
import { User, IUserWallet } from '../models/user';
import { getUser, getUserWalletByChainId } from '../services/userService';
import { fetchExternalDeposits } from '../services/externalDepositsService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { isValidPhoneNumber, isValidEthereumWallet } from '../helpers/validationHelper';
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
  const fastify = request.server;
  const simpleSwapContractAddress = fastify.networkConfig.contracts.simpleSwapAddress;
  const depositsStatus = await fetchExternalDeposits('ARBITRUM_SEPOLIA', simpleSwapContractAddress);
  return returnSuccessResponse(reply, depositsStatus);
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

  Logger.log(`Fetching balance for address: ${address} on network ${networkConfig.name}`);
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
    Logger.error('Error fetching wallet balance:', error);
    return returnErrorResponse(reply, 500, 'Internal Server Error');
  }
}

/**
 *
 * Route handler for getting wallet balance
 *
 * @param request
 * @param reply
 * @returns
 */
export const walletBalance = async (
  request: FastifyRequest<{ Params: { wallet: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const { wallet } = request.params;

  if (!wallet) {
    return returnErrorResponse(reply, 400, 'Wallet address is required');
  }

  if (!isValidEthereumWallet(wallet)) {
    return returnErrorResponse(reply, 400, 'Wallet must be a valid ethereum wallet address');
  }

  return getAddressBalance(wallet, reply, request.server);
};

/**
 *
 * Route handler for getting balance by phone number
 *
 * @param request
 * @param reply
 * @returns
 */
export const balanceByPhoneNumber = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const { channel_user_id: phone } = request.query as { channel_user_id?: string };

  if (!phone) {
    Logger.warn('Phone number is required');
    return returnErrorResponse(reply, 400, 'Phone number is required');
  }

  if (!isValidPhoneNumber(phone)) {
    Logger.warn(`Phone number ${phone} is invalid`);
    const msgError = `'${phone}' is invalid. 'phone' parameter must be a phone number (without spaces or symbols)`;
    return returnErrorResponse(reply, 400, msgError);
  }

  try {
    const user = await getUser(phone);
    if (!user) {
      Logger.warn(`User not found for phone number: ${phone}`);
      return await returnErrorResponse(reply, 404, 'User not found');
    }

    const fastify = request.server;
    const { chain_id } = fastify.networkConfig;
    const userWallet: IUserWallet | null = getUserWalletByChainId(user.wallets, chain_id);

    if (!userWallet) {
      Logger.warn(`Wallet not found for phone number: ${phone} and chainId ${chain_id}`);
      return await returnErrorResponse(reply, 404, 'Wallet not found');
    }

    return await getAddressBalance(userWallet.wallet_proxy, reply, request.server);
  } catch (error) {
    Logger.error('Error fetching user balance:', error);
    return returnErrorResponse(reply, 500, 'Internal Server Error');
  }
};

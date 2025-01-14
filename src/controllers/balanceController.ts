import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { getPhoneNFTs } from './nftController';
import { Logger } from '../helpers/loggerHelper';
import { getUser } from '../services/mongo/mongoService';
import { IUser, IUserWallet } from '../models/userModel';
import { getUserWalletByChainId } from '../services/userService';
import { fetchExternalDeposits } from '../services/externalDepositsService';
import { isValidPhoneNumber, isValidEthereumWallet } from '../helpers/validationHelper';
import {
  returnErrorResponse,
  returnSuccessResponse,
  returnErrorResponse500
} from '../helpers/requestHelper';
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
async function getAddressBalanceWithNfts(
  phoneNumber: string | null,
  address: string,
  reply: FastifyReply,
  fastify: FastifyInstance
): Promise<FastifyReply> {
  const { networkConfig } = fastify;

  Logger.log(
    'getAddressBalanceWithNfts',
    `Fetching balance for address: ${address} on network ${networkConfig.name}`
  );

  try {
    const [fiatQuotes, tokenBalances, NFTs] = await Promise.all([
      getFiatQuotes(),
      getTokenBalances(address, fastify.tokens, networkConfig),
      phoneNumber ? getPhoneNFTs(phoneNumber) : { nfts: [] }
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
    Logger.error('getAddressBalanceWithNfts', 'Error fetching wallet balance:', error);
    return returnErrorResponse500(reply);
  }
}

/**
 * Route handler for getting wallet balance
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

  return getAddressBalanceWithNfts('', wallet, reply, request.server);
};

/**
 * Route handler for getting balance by phone number
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
    Logger.warn('balanceByPhoneNumber', 'Phone number is required');
    return returnErrorResponse(reply, 400, 'Phone number is required');
  }

  if (!isValidPhoneNumber(phone)) {
    Logger.warn('balanceByPhoneNumber', `Phone number ${phone} is invalid`);
    const msgError = `'${phone}' is invalid. 'phone' parameter must be a phone number (without spaces or symbols)`;
    return returnErrorResponse(reply, 400, msgError);
  }

  try {
    const user: IUser | null = await getUser(phone);
    if (!user) {
      Logger.warn('balanceByPhoneNumber', `User not found for phone number: ${phone}`);
      return await returnErrorResponse(reply, 404, `User not found for phone number: ${phone}`);
    }

    const fastify = request.server;
    const { chain_id } = fastify.networkConfig;
    const userWallet: IUserWallet | null = getUserWalletByChainId(user.wallets, chain_id);

    if (!userWallet) {
      Logger.warn(
        'balanceByPhoneNumber',
        `Wallet not found for phone number: ${phone} and chainId ${chain_id}`
      );
      return await returnErrorResponse(reply, 404, 'Wallet not found');
    }

    return await getAddressBalanceWithNfts(
      user.phone_number,
      userWallet.wallet_proxy,
      reply,
      request.server
    );
  } catch (error) {
    Logger.error('balanceByPhoneNumber', 'Error fetching user balance:', error);
    return returnErrorResponse500(reply);
  }
};

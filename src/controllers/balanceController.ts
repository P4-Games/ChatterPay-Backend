import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { getPhoneNFTs } from './nftController';
import { Logger } from '../helpers/loggerHelper';
import { IUser, IUserWallet } from '../models/userModel';
import { Currency, BalanceInfo } from '../types/commonType';
import { getFiatQuotes } from '../services/criptoya/criptoYaService';
import { COMMON_REPLY_WALLET_NOT_CREATED } from '../config/constants';
import { getUser, getUserWalletByChainId } from '../services/userService';
import { fetchExternalDeposits } from '../services/externalDepositsService';
import { isValidPhoneNumber, isValidEthereumWallet } from '../helpers/validationHelper';
import {
  returnErrorResponse,
  returnSuccessResponse,
  returnErrorResponse500
} from '../helpers/requestHelper';
import {
  getTokenBalances,
  calculateBalances,
  mergeSameTokenBalances,
  calculateBalancesTotals
} from '../services/balanceService';

type CheckExternalDepositsQuery = {
  sendNotification?: string;
};

/**
 * Handles the request to check external deposits.
 *
 * Reads the `sendNotification` flag from the query parameters and fetches
 * external deposits filtered by router and pool addresses.
 *
 * @param request - Fastify request with optional `sendNotification` query param
 * @param reply - Fastify reply object
 * @returns A response with the deposit status
 */
export const checkExternalDeposits = async (
  request: FastifyRequest<{ Querystring: CheckExternalDepositsQuery }>,
  reply: FastifyReply
) => {
  const fastify = request.server;
  const { routerAddress, poolAddress } = fastify.networkConfig.contracts;

  // Read sendNotification from query params and convert to boolean
  const sendNotification = request.query?.sendNotification === 'true';

  const depositsStatus = await fetchExternalDeposits(
    routerAddress!,
    poolAddress!,
    fastify.networkConfig.chainId,
    sendNotification
  );
  return returnSuccessResponse(reply, depositsStatus);
};

/**
 * Fetches and calculates balance information for a given address
 * @param proxyAddress - Address to get balance for
 * @param eoaAddress - Externally Owned Account address
 * @param reply - Fastify reply object
 * @param fastify - Fastify instance containing global state
 * @returns Fastify reply with balance information
 */
async function getAddressBalanceWithNfts(
  phoneNumber: string | null,
  proxyAddress: string,
  eoaAddress: string,
  reply: FastifyReply,
  fastify: FastifyInstance
): Promise<FastifyReply> {
  const { networkConfig } = fastify;

  const eoaProvided =
    !!eoaAddress &&
    eoaAddress.trim().length > 0 &&
    eoaAddress.toLowerCase() !== proxyAddress.toLowerCase();

  Logger.log(
    'getAddressBalanceWithNfts',
    `Fetching balances for proxy ${proxyAddress}${eoaProvided ? ` + eoa ${eoaAddress}` : ''} on network ${networkConfig.name}`
  );

  try {
    const [fiatQuotes, proxyTokenBalances, eoaTokenBalances, NFTs] = await Promise.all([
      getFiatQuotes(),
      getTokenBalances(proxyAddress, fastify.tokens, networkConfig),
      eoaProvided
        ? getTokenBalances(eoaAddress, fastify.tokens, networkConfig)
        : Promise.resolve([]),
      phoneNumber ? getPhoneNFTs(phoneNumber) : Promise.resolve({ nfts: [] })
    ]);

    //  Combine raw token balances
    const combinedTokenBalances = eoaProvided
      ? [...proxyTokenBalances, ...eoaTokenBalances]
      : proxyTokenBalances;

    //  Merge duplicates BEFORE calculating balances
    const mergedTokenBalances = mergeSameTokenBalances(combinedTokenBalances);

    //  Now calculate balances with fiat conversions
    const balances: BalanceInfo[] = calculateBalances(
      mergedTokenBalances,
      fiatQuotes,
      networkConfig.name
    );

    // Totals
    const totals: Record<Currency, number> = calculateBalancesTotals(balances);

    const response = {
      balances,
      totals,
      certificates: NFTs.nfts,
      wallets: eoaProvided ? [proxyAddress, eoaAddress] : [proxyAddress]
    };

    return await returnSuccessResponse(reply, 'Wallet balance fetched successfully', response);
  } catch (error) {
    return returnErrorResponse500('getAddressBalanceWithNfts', '', reply);
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
    return returnErrorResponse('walletBalance', '', reply, 400, 'Wallet address is required');
  }

  if (!isValidEthereumWallet(wallet)) {
    return returnErrorResponse(
      'walletBalance',
      '',
      reply,
      400,
      'Wallet must be a valid ethereum wallet address'
    );
  }

  return getAddressBalanceWithNfts('', wallet, '', reply, request.server);
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
    return returnErrorResponse('balanceByPhoneNumber', '', reply, 400, 'Phone number is required');
  }

  if (!isValidPhoneNumber(phone)) {
    const msgError = `'${phone}' is invalid. 'phone' parameter must be a phone number (without spaces or symbols)`;
    return returnErrorResponse('balanceByPhoneNumber', '', reply, 400, msgError);
  }

  try {
    const user: IUser | null = await getUser(phone);
    if (!user) {
      Logger.info('balanceByPhoneNumber', COMMON_REPLY_WALLET_NOT_CREATED);
      return await returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
    }

    const fastify = request.server;
    const { chainId: chain_id } = fastify.networkConfig;
    const userWallet: IUserWallet | null = getUserWalletByChainId(user.wallets, chain_id);

    if (!userWallet) {
      return await returnErrorResponse('balanceByPhoneNumber', '', reply, 404, 'Wallet not found');
    }

    return await getAddressBalanceWithNfts(
      user.phone_number,
      userWallet.wallet_proxy,
      userWallet.wallet_eoa,
      reply,
      request.server
    );
  } catch (error) {
    return returnErrorResponse500('balanceByPhoneNumber', '', reply);
  }
};

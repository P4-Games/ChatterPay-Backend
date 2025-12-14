import { FastifyReply, FastifyRequest } from 'fastify';

import { IToken } from '../models/tokenModel';
import { Logger } from '../helpers/loggerHelper';
import { IBlockchain } from '../models/blockchainModel';
import { IUser, IUserWallet } from '../models/userModel';
import { Currency, BalanceInfo } from '../types/commonType';
import { COMMON_REPLY_WALLET_NOT_CREATED } from '../config/constants';
import { getAddressBalanceWithNfts } from '../services/balanceService';
import { getUser, getUserWalletByChainId } from '../services/userService';
import { fetchExternalDeposits } from '../services/externalDepositsService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { isValidPhoneNumber, isValidEthereumWallet } from '../helpers/validationHelper';

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

  try {
    const { networkConfig, tokens } = request.server as {
      networkConfig: IBlockchain;
      tokens: IToken[];
    };

    // phoneNumber and eoaAddress not provided here
    const data = await getAddressBalanceWithNfts(null, wallet, '', networkConfig, tokens);

    return await returnSuccessResponse(reply, 'Wallet balance fetched successfully', data);
  } catch (err) {
    // Extremely defensive: service already returns empty data on failure,
    // but if something truly unexpected happens, fail clearly.
    return returnErrorResponse(
      'walletBalance',
      (err as Error).message ?? '',
      reply,
      500,
      'Internal Server Error'
    );
  }
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

    const { networkConfig, tokens } = request.server as {
      networkConfig: IBlockchain;
      tokens: IToken[];
    };

    const { chainId } = networkConfig;
    const userWallet: IUserWallet | null = getUserWalletByChainId(user.wallets, chainId);

    if (!userWallet || !userWallet.wallet_proxy) {
      return await returnErrorResponse('balanceByPhoneNumber', '', reply, 404, 'Wallet not found');
    }

    const data = await getAddressBalanceWithNfts(
      user.phone_number,
      userWallet.wallet_proxy,
      userWallet.wallet_eoa ?? '',
      networkConfig,
      tokens
    );

    return await returnSuccessResponse(reply, 'Wallet balance fetched successfully', data);
  } catch (err) {
    return returnErrorResponse(
      'balanceByPhoneNumber',
      (err as Error).message ?? '',
      reply,
      500,
      'Internal Server Error'
    );
  }
};

/**
 * Route handler for getting wallet balance by phone number (simplified response).
 *
 * @param {FastifyRequest} request - Fastify request with `channel_user_id` query param.
 * @param {FastifyReply} reply - Fastify reply instance.
 * @returns {Promise<FastifyReply>} Simplified balance response.
 */ export const balanceByPhoneNumberSync = async (
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
      return await returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
    }

    const { networkConfig, tokens } = request.server as {
      networkConfig: IBlockchain;
      tokens: IToken[];
    };

    const userWallet: IUserWallet | null = getUserWalletByChainId(
      user.wallets,
      networkConfig.chainId
    );

    if (!userWallet || !userWallet.wallet_proxy || !userWallet.wallet_eoa) {
      return await returnErrorResponse('balanceByPhoneNumber', '', reply, 404, 'Wallet not found');
    }

    const data = await getAddressBalanceWithNfts(
      user.phone_number,
      userWallet.wallet_proxy,
      userWallet.wallet_eoa,
      networkConfig,
      tokens
    );

    const USD = 'USD' as const satisfies Currency;

    const toFixed2 = (n: number): string => Number(n).toFixed(2);
    const toFixed6 = (n: number): string => Number(n).toFixed(6);
    const usdFrom = (rec?: Record<Currency, number>): number => Number((rec && rec[USD]) ?? 0);

    const balances: BalanceInfo[] = Array.isArray(data.balances) ? data.balances : [];

    const sorted: BalanceInfo[] = balances
      .slice()
      .sort((a, b) => usdFrom(b.balance_conv) - usdFrom(a.balance_conv))
      .slice(0, 5);

    const headerLine: string = `Network: ${networkConfig.name ?? networkConfig.chainId}`;

    const tokenLines: string[] = sorted.map((t) => {
      const symbol: string = t.token ?? '—';
      const amount: string = Number.isFinite(t.balance) ? toFixed6(t.balance) : '0.000000';
      const usd: string = toFixed2(usdFrom(t.balance_conv));

      return `${symbol}: ${amount} · $${usd}`;
    });

    const totalUsd: string = toFixed2(Number((data.totals && data.totals[USD]) ?? 0));

    const textResponse: string = [headerLine, ...tokenLines, `Total: $${totalUsd}`].join('\n');

    return await returnSuccessResponse(reply, textResponse);
  } catch (err) {
    return returnErrorResponse(
      'balanceByPhoneNumber',
      (err as Error).message ?? '',
      reply,
      500,
      'Internal Server Error'
    );
  }
};

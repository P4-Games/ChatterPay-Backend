import type { FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../helpers/loggerHelper';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { isValidEthereumWallet, isValidPhoneNumber } from '../helpers/validationHelper';
import type { IBlockchain } from '../models/blockchainModel';
import { NotificationEnum } from '../models/templateModel';
import type { IToken } from '../models/tokenModel';
import type { IUser, IUserWallet } from '../models/userModel';
import { getAddressBalanceWithNfts } from '../services/balanceService';
import { fetchExternalDeposits } from '../services/externalDepositsService';
import { getNotificationTemplate } from '../services/notificationService';
import { getPolymarketBalanceSummary } from '../services/polymarket';
import { deriveSafeAddress } from '../services/polymarket/polymarketRelayerService';
import {
  getUser,
  getUserByWalletAndChainid,
  getUserWalletByChainId
} from '../services/userService';
import type { AddressBalanceWithNfts, BalanceInfo, Currency } from '../types/commonType';

type CheckExternalDepositsQuery = {
  sendNotification?: string;
};

/**
 * Enrich balance data with Polymarket balances (idle USDC.e + active positions value).
 * Best-effort: if the user has no Polymarket account or the query fails, data is unchanged.
 */
async function enrichWithPolymarketBalances(
  data: AddressBalanceWithNfts,
  user: IUser | null
): Promise<AddressBalanceWithNfts> {
  if (!user?.polymarket_account?.polygon_address) return data;

  const polygonAddress = user.polymarket_account.polygon_address;
  const logKey = `balance-${user.phone_number}`;

  try {
    const eoaAddress = user.wallets[0]?.wallet_eoa;
    const safeAddress =
      user.polymarket_account.wallet_type === 'deposit' && eoaAddress
        ? deriveSafeAddress(eoaAddress)
        : undefined;

    const { idle_usdc, positions_value } = await getPolymarketBalanceSummary(
      polygonAddress,
      logKey,
      safeAddress
    );
    const total_usd = idle_usdc + positions_value;
    if (total_usd <= 0) return data;

    data.polymarket = { idle_usdc, positions_value, total_usd };

    // Add Polymarket total to USD totals
    if (data.totals) {
      const USD = 'USD' as const satisfies Currency;
      data.totals[USD] = (data.totals[USD] ?? 0) + total_usd;
    }
  } catch (error) {
    Logger.log(
      'warn',
      'balanceController',
      `Polymarket balance enrichment failed: ${String(error)}`
    );
  }

  return data;
}

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

    Logger.log('walletBalance', `Tokens: ${tokens?.length}, Chain: ${networkConfig?.chainId}`);

    // phoneNumber and eoaAddress not provided here
    const data = await getAddressBalanceWithNfts(null, wallet, '', networkConfig, tokens);

    // Enrich with Polymarket balances if the user has a Polymarket account
    const user = await getUserByWalletAndChainid(wallet, networkConfig.chainId);
    await enrichWithPolymarketBalances(data, user);

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
      const { message } = await getNotificationTemplate(phone, NotificationEnum.wallet_not_created);
      Logger.info('balanceByPhoneNumber', message);
      return await returnSuccessResponse(reply, message);
    }

    const { networkConfig, tokens } = request.server as {
      networkConfig: IBlockchain;
      tokens: IToken[];
    };

    const { chainId } = networkConfig;
    const userWallet: IUserWallet | null = getUserWalletByChainId(user.wallets, chainId);

    if (!userWallet || !userWallet.wallet_proxy) {
      const { message } = await getNotificationTemplate(phone, NotificationEnum.wallet_not_created);
      return await returnSuccessResponse(reply, message);
    }

    const data = await getAddressBalanceWithNfts(
      user.phone_number,
      userWallet.wallet_proxy,
      userWallet.wallet_eoa ?? '',
      networkConfig,
      tokens
    );

    await enrichWithPolymarketBalances(data, user);

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
 */
export const balanceByPhoneNumberSync = async (
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
      const { message } = await getNotificationTemplate(phone, NotificationEnum.wallet_not_created);
      return await returnSuccessResponse(reply, message);
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

    await enrichWithPolymarketBalances(data, user);

    const USD = 'USD' as const satisfies Currency;

    const balances: BalanceInfo[] = Array.isArray(data.balances) ? data.balances : [];

    const sorted: BalanceInfo[] = balances
      .slice()
      .sort((a, b) => (b.balance_conv?.[USD] ?? 0) - (a.balance_conv?.[USD] ?? 0))
      .slice(0, 5);

    const tokenLines: string[] = sorted.map((t) => {
      const symbol: string = t.token ?? '—';
      const amount = t.balance;
      const usdRaw = t.balance_conv?.[USD] ?? 0;

      const usdFormatted = Number(usdRaw).toFixed(2);

      if (usdRaw > 0) {
        return `${symbol}: ${amount} (~ $${usdFormatted})`;
      }

      return `${symbol}: ${amount}`;
    });

    // Include Polymarket balance in the text summary
    if (data.polymarket && data.polymarket.total_usd > 0) {
      const pm = data.polymarket;
      if (pm.positions_value > 0) {
        tokenLines.push(`Polymarket Positions: ~ $${pm.positions_value.toFixed(2)}`);
      }
      if (pm.idle_usdc > 0) {
        tokenLines.push(
          `Polymarket USDC.e: ${pm.idle_usdc.toFixed(2)} (~ $${pm.idle_usdc.toFixed(2)})`
        );
      }
    }

    const totalUsdRaw = data.totals?.[USD] ?? 0;
    const totalUsdFormatted = Number(totalUsdRaw).toFixed(2);

    const textResponse: string = [...tokenLines, `Total: $${totalUsdFormatted}`].join('\n');

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

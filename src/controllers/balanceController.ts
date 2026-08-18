import type { FastifyReply, FastifyRequest } from 'fastify';
import { getCardanoConfig } from '../config/cardanoConfig';
import { Logger } from '../helpers/loggerHelper';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { isValidEthereumWallet, isValidPhoneNumber } from '../helpers/validationHelper';
import type { IBlockchain } from '../models/blockchainModel';
import { NotificationEnum } from '../models/templateModel';
import type { IToken } from '../models/tokenModel';
import type { IUser, IUserWallet } from '../models/userModel';
import {
  calculateBalances,
  calculateBalancesTotals,
  getAddressBalanceWithNfts,
  getTokenPrices
} from '../services/balanceService';
import {
  getCardanoTokenBalances,
  getCardanoTokenSymbols,
  isCardanoWalletAddress
} from '../services/cardano/cardanoBalanceService';
import { deriveCardanoAccount } from '../services/cardano/cardanoWalletService';
import { getFiatQuotes } from '../services/criptoya/criptoYaService';
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
 * Adds the user's Cardano wallet and its balances to a portfolio response.
 *
 * The address is **derived rather than looked up**, and nothing is written. On Cardano an address
 * is a pure function of a key, so it exists and can receive funds before the user has ever touched
 * the chain — which is exactly what a user in V1 needs, because funding that address themselves is
 * how they get started. Requiring a transfer first in order to see where to send funds would be a
 * loop with no entry point.
 *
 * Best effort: when Cardano is off, or the provider is unreachable, the portfolio comes back
 * unchanged rather than failing. A balance endpoint that throws takes the whole wallet view down.
 *
 * @param data - Portfolio being enriched, mutated in place.
 * @param phoneNumber - The user's phone number.
 */
async function enrichWithCardanoBalances(
  data: AddressBalanceWithNfts,
  phoneNumber: string
): Promise<void> {
  const config = getCardanoConfig();
  if (!config.enabled) return;

  try {
    const account = deriveCardanoAccount(phoneNumber);
    const catalogue = await getCardanoTokenSymbols();
    // Prices are asked for by ticker, so the catalogue decides which ones to look up. A token with
    // no feed simply comes back without a rate.
    const [prices, fiatQuotes] = await Promise.all([getTokenPrices(catalogue), getFiatQuotes()]);
    const { networkName, balances } = await getCardanoTokenBalances(
      account.address,
      (symbol) => prices.get(symbol.toUpperCase()) ?? 0
    );

    // Zero rows are dropped, the same way `getAddressBalanceWithNfts` drops them for EVM. Keeping
    // them here would put an "ADA 0" row in a list that hides "USDC 0" right next to it, and the
    // address the user has to fund is already in `wallets`.
    data.balances.push(
      ...calculateBalances(balances, fiatQuotes, networkName).filter((entry) => entry.balance > 0)
    );
    data.wallets.push(account.address);
    data.totals = calculateBalancesTotals(data.balances);
  } catch (error) {
    Logger.warn('enrichWithCardanoBalances', `Skipping Cardano balances: ${String(error)}`);
  }
}

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

    // Add Polymarket total to every currency total, not just USD — otherwise the
    // fiat totals (ARS/BRL/UYU) exclude Polymarket while USD includes it, and any
    // client deriving a conversion rate from the totals gets a skewed result.
    if (data.totals) {
      const USD = 'USD' as const satisfies Currency;
      data.totals[USD] = (data.totals[USD] ?? 0) + total_usd;

      const fiatQuotes = await getFiatQuotes();
      fiatQuotes.forEach(({ currency, rate }) => {
        data.totals[currency] = (data.totals[currency] ?? 0) + total_usd * rate;
      });
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

  // A Cardano address is answered from the chain's UTxO set rather than from token contracts. The
  // response keeps the `balances` / `totals` shape every existing caller already reads, so nothing
  // downstream has to learn a second contract to show an ADA balance.
  if (isCardanoWalletAddress(wallet)) {
    try {
      // Every display attribute comes from the token catalogue, exactly as the EVM rows do — the
      // database is what says which assets exist on this network, how they are named and how they
      // are scaled. The same price and fiat path is reused so an ADA row converts to USD/ARS/BRL/UYU
      // like a USDC row does.
      const catalogue = await getCardanoTokenSymbols();
      const [prices, fiatQuotes] = await Promise.all([getTokenPrices(catalogue), getFiatQuotes()]);
      const {
        networkName,
        balances: tokenBalances,
        raw
      } = await getCardanoTokenBalances(wallet, (symbol) => prices.get(symbol.toUpperCase()) ?? 0);
      // Same rule as the EVM branch: a token the address does not hold is not a row.
      const balances = calculateBalances(tokenBalances, fiatQuotes, networkName).filter(
        (entry) => entry.balance > 0
      );

      return await returnSuccessResponse(reply, 'Wallet balance fetched successfully', {
        balances,
        totals: calculateBalancesTotals(balances),
        certificates: [],
        wallets: [wallet],
        // The UTxO detail the generic shape has nowhere to put: how much ADA sits beside native
        // assets and therefore cannot be reached by an ADA transfer.
        cardano: raw
      });
    } catch (err) {
      return returnErrorResponse(
        'walletBalance',
        (err as Error).message ?? '',
        reply,
        500,
        'Internal Server Error'
      );
    }
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
    // The dashboard reads balances by address, not by phone, so the Cardano rows have to be
    // reachable from here too — otherwise the wallet view never shows ADA at all. The phone comes
    // from the same lookup Polymarket already does.
    if (user) await enrichWithCardanoBalances(data, user.phone_number);

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
    await enrichWithCardanoBalances(data, user.phone_number);

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
    // Same treatment as the async variant: both answer the same question, and having one of them
    // omit an asset class is how two screens end up disagreeing about what a user holds.
    await enrichWithCardanoBalances(data, user.phone_number);

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

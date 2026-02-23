/**
 * Polymarket Controller
 *
 * Fastify request handlers for all Polymarket API endpoints.
 * Read endpoints (markets/events) are synchronous GET responses.
 * Trading endpoints are POST and require account + terms validation.
 *
 * Key derivation follows the same pattern as setupContracts / computeWallet:
 *   secService.get_up(user.phone_number, chainId) → private key
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { POLYMARKET_ENABLED } from '../config/constants';
import { Logger } from '../helpers/loggerHelper';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import type { IUser } from '../models/userModel';
import { mongoBlockchainService } from '../services/mongo/mongoBlockchainService';
import { createOrder } from '../services/mongo/mongoPolymarketService';
import {
  acceptTerms,
  cancelAllOrders,
  cancelOrder,
  createPolymarketAccount,
  getAccountStatus,
  getBridgeQuote,
  getClosedPositions,
  getCurrentTerms,
  getEventBySlug,
  getEvents,
  getMarketBySlug,
  getMarketPrice,
  getMarkets,
  getOpenOrders,
  getPortfolioValue,
  getPositions,
  getTradeHistory,
  hasAcceptedCurrentTerms,
  placeOrder,
  searchMarkets
} from '../services/polymarket';
import { secService } from '../services/secService';
import { getUser } from '../services/userService';
import type {
  PolymarketAcceptTermsBody,
  PolymarketAccountBody,
  PolymarketBridgeBody,
  PolymarketCancelAllOrdersBody,
  PolymarketCancelOrderBody,
  PolymarketEventsQuery,
  PolymarketMarketsQuery,
  PolymarketPlaceOrderBody,
  PolymarketSearchQuery,
  PolymarketSlugParams,
  PolymarketUserDataBody
} from '../types/polymarketType';

const LOG_PREFIX = 'polymarketController';

// ============================================================================
// Helpers
// ============================================================================

/** Standard error response */
function errorReply(reply: FastifyReply, statusCode: number, message: string): FastifyReply {
  return reply.status(statusCode).send({
    status: 'error',
    data: { message },
    timestamp: new Date().toISOString()
  });
}

/** Standard success response */
function successReply(reply: FastifyReply, data: unknown): FastifyReply {
  return reply.send({
    status: 'success',
    data,
    timestamp: new Date().toISOString()
  });
}

/** Check if Polymarket is enabled */
function checkEnabled(reply: FastifyReply): boolean {
  if (!POLYMARKET_ENABLED) {
    errorReply(reply, 503, 'Polymarket integration is disabled');
    return false;
  }
  return true;
}

/** Validate and resolve user from channel_user_id */
async function resolveUser(channelUserId: string, _logKey: string): Promise<IUser | null> {
  if (!channelUserId || !isValidPhoneNumber(channelUserId)) {
    return null;
  }
  return getUser(channelUserId);
}

/** Derive the user's private key using the same pattern as setupContracts / computeWallet */
async function getUserPrivateKey(user: IUser): Promise<string> {
  const networkConfig = await mongoBlockchainService.getNetworkConfig();
  return secService.get_up(user.phone_number, networkConfig.chainId.toString());
}

/** Validate user has Polymarket account and accepted terms */
function validatePolymarketReady(user: IUser, reply: FastifyReply): boolean {
  if (!user.polymarket_account) {
    errorReply(
      reply,
      400,
      'Polymarket account not created. Call /polymarket/account/create first.'
    );
    return false;
  }
  if (!hasAcceptedCurrentTerms(user)) {
    errorReply(reply, 403, 'Terms not accepted. Call /polymarket/account/accept_terms first.');
    return false;
  }
  return true;
}

// ============================================================================
// Read Endpoints (GET — no auth required)
// ============================================================================

/** GET /polymarket/markets */
export const polymarketGetMarkets = async (
  request: FastifyRequest<{ Querystring: PolymarketMarketsQuery }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-markets]`;

  try {
    const markets = await getMarkets(
      {
        limit: request.query.limit,
        offset: request.query.offset,
        active: request.query.active,
        closed: request.query.closed,
        category: request.query.category,
        order: request.query.order
      },
      logKey
    );

    return successReply(reply, { markets });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch markets');
  }
};

/** GET /polymarket/markets/:slug */
export const polymarketGetMarketDetail = async (
  request: FastifyRequest<{ Params: PolymarketSlugParams }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-market:${request.params.slug}]`;

  try {
    const market = await getMarketBySlug(request.params.slug, logKey);
    if (!market) {
      return errorReply(reply, 404, 'Market not found');
    }

    // Enrich with price data if CLOB token IDs are available
    const prices: Record<string, number> = {};
    try {
      const tokenIds = JSON.parse(market.clobTokenIds || '[]') as string[];
      for (const tokenId of tokenIds) {
        const price = await getMarketPrice(tokenId, logKey);
        prices[tokenId] = price;
      }
    } catch {
      // Price enrichment is best-effort
    }

    return successReply(reply, { market, prices });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch market detail');
  }
};

/** GET /polymarket/events */
export const polymarketGetEvents = async (
  request: FastifyRequest<{ Querystring: PolymarketEventsQuery }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-events]`;

  try {
    const events = await getEvents(
      {
        limit: request.query.limit,
        offset: request.query.offset,
        active: request.query.active,
        closed: request.query.closed,
        slug: request.query.slug
      },
      logKey
    );

    return successReply(reply, { events });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch events');
  }
};

/** GET /polymarket/events/:slug */
export const polymarketGetEventDetail = async (
  request: FastifyRequest<{ Params: PolymarketSlugParams }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-event:${request.params.slug}]`;

  try {
    const event = await getEventBySlug(request.params.slug, logKey);
    if (!event) {
      return errorReply(reply, 404, 'Event not found');
    }

    return successReply(reply, { event });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch event detail');
  }
};

/** GET /polymarket/search */
export const polymarketSearchMarkets = async (
  request: FastifyRequest<{ Querystring: PolymarketSearchQuery }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-search]`;

  try {
    if (!request.query.query) {
      return errorReply(reply, 400, 'Missing query parameter');
    }

    const results = await searchMarkets(request.query.query, request.query.limit ?? 10, logKey);

    return successReply(reply, { results });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to search markets');
  }
};

// ============================================================================
// Account Endpoints (POST)
// ============================================================================

/** POST /polymarket/account/status */
export const polymarketGetAccountStatus = async (
  request: FastifyRequest<{ Body: PolymarketAccountBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-account-status]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }

    const status = getAccountStatus(user);
    const terms = await getCurrentTerms(logKey);

    return successReply(reply, { account: status, terms });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to get account status');
  }
};

/** POST /polymarket/account/create */
export const polymarketCreateAccount = async (
  request: FastifyRequest<{ Body: PolymarketAccountBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-account-create]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }

    if (user.polymarket_account) {
      return successReply(reply, {
        message: 'Polymarket account already exists',
        account: getAccountStatus(user)
      });
    }

    const privateKey = await getUserPrivateKey(user);
    const updatedUser = await createPolymarketAccount(user, privateKey, logKey);

    return successReply(reply, {
      message: 'Polymarket account created',
      account: getAccountStatus(updatedUser)
    });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to create Polymarket account');
  }
};

/** POST /polymarket/account/accept_terms */
export const polymarketAcceptTerms = async (
  request: FastifyRequest<{ Body: PolymarketAcceptTermsBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-accept-terms]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }

    if (!user.polymarket_account) {
      return errorReply(reply, 400, 'Polymarket account not created');
    }

    const updatedUser = await acceptTerms(user, request.body.terms_version, logKey);
    return successReply(reply, {
      message: `Terms v${request.body.terms_version} accepted`,
      account: getAccountStatus(updatedUser)
    });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, `Failed to accept terms: ${String(error)}`);
  }
};

// ============================================================================
// Trading Endpoints (POST — account + terms required)
// ============================================================================

/** POST /polymarket/order/place */
export const polymarketPlaceOrder = async (
  request: FastifyRequest<{ Body: PolymarketPlaceOrderBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-place-order]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }
    if (!validatePolymarketReady(user, reply)) return reply;

    const { token_id, price, size, side, order_type } = request.body;
    if (!token_id || price == null || size == null || !side) {
      return errorReply(reply, 400, 'Missing required order parameters');
    }

    const privateKey = await getUserPrivateKey(user);
    const result = await placeOrder(
      user,
      privateKey,
      token_id,
      {
        tokenId: token_id,
        price,
        size,
        side,
        orderType: order_type
      },
      logKey
    );

    // Persist order to MongoDB
    await createOrder({
      user_phone: user.phone_number,
      order_id: result.orderID,
      market_condition_id: token_id,
      market_slug: '',
      token_id,
      side,
      price,
      size,
      status: 'pending'
    });

    return successReply(reply, { order: result });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, `Failed to place order: ${String(error)}`);
  }
};

/** POST /polymarket/order/cancel */
export const polymarketCancelOrder = async (
  request: FastifyRequest<{ Body: PolymarketCancelOrderBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-cancel-order]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }
    if (!validatePolymarketReady(user, reply)) return reply;

    if (!request.body.order_id) {
      return errorReply(reply, 400, 'Missing order_id');
    }

    const privateKey = await getUserPrivateKey(user);
    await cancelOrder(user, privateKey, request.body.order_id, logKey);

    return successReply(reply, { message: `Order ${request.body.order_id} cancelled` });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to cancel order');
  }
};

/** POST /polymarket/order/cancel_all */
export const polymarketCancelAllOrders = async (
  request: FastifyRequest<{ Body: PolymarketCancelAllOrdersBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-cancel-all]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }
    if (!validatePolymarketReady(user, reply)) return reply;

    const privateKey = await getUserPrivateKey(user);
    await cancelAllOrders(user, privateKey, logKey);

    return successReply(reply, { message: 'All orders cancelled' });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to cancel all orders');
  }
};

/** POST /polymarket/orders */
export const polymarketGetOpenOrders = async (
  request: FastifyRequest<{ Body: PolymarketUserDataBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-open-orders]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }
    if (!validatePolymarketReady(user, reply)) return reply;

    const privateKey = await getUserPrivateKey(user);
    const orders = await getOpenOrders(user, privateKey, logKey);

    return successReply(reply, { orders });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch open orders');
  }
};

/** POST /polymarket/positions */
export const polymarketGetPositions = async (
  request: FastifyRequest<{ Body: PolymarketUserDataBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-positions]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }
    if (!user.polymarket_account) {
      return errorReply(reply, 400, 'Polymarket account not created');
    }

    const positions = await getPositions(user.polymarket_account.polygon_address, logKey);
    return successReply(reply, { positions });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch positions');
  }
};

/** POST /polymarket/positions/closed */
export const polymarketGetClosedPositions = async (
  request: FastifyRequest<{ Body: PolymarketUserDataBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-closed-positions]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }
    if (!user.polymarket_account) {
      return errorReply(reply, 400, 'Polymarket account not created');
    }

    const positions = await getClosedPositions(user.polymarket_account.polygon_address, logKey);
    return successReply(reply, { positions });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch closed positions');
  }
};

/** POST /polymarket/history */
export const polymarketGetTradeHistory = async (
  request: FastifyRequest<{ Body: PolymarketUserDataBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-history]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }
    if (!user.polymarket_account) {
      return errorReply(reply, 400, 'Polymarket account not created');
    }

    const trades = await getTradeHistory(user.polymarket_account.polygon_address, logKey);
    return successReply(reply, { trades });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch trade history');
  }
};

/** POST /polymarket/portfolio */
export const polymarketGetPortfolioValue = async (
  request: FastifyRequest<{ Body: PolymarketUserDataBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-portfolio]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }
    if (!user.polymarket_account) {
      return errorReply(reply, 400, 'Polymarket account not created');
    }

    const portfolio = await getPortfolioValue(user.polymarket_account.polygon_address, logKey);
    return successReply(reply, { portfolio });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch portfolio value');
  }
};

// ============================================================================
// Bridge Endpoints (POST)
// ============================================================================

/** POST /polymarket/bridge/quote */
export const polymarketBridgeQuote = async (
  request: FastifyRequest<{ Body: PolymarketBridgeBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-bridge-quote]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }
    if (!user.polymarket_account) {
      return errorReply(reply, 400, 'Polymarket account not created');
    }

    if (!request.body.amount) {
      return errorReply(reply, 400, 'Missing amount');
    }

    const quote = await getBridgeQuote(
      user.polymarket_account.polygon_address,
      request.body.amount,
      logKey
    );

    return successReply(reply, { quote });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to get bridge quote');
  }
};

/** POST /polymarket/bridge/execute */
export const polymarketBridge = async (
  request: FastifyRequest<{ Body: PolymarketBridgeBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-bridge]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }
    if (!user.polymarket_account) {
      return errorReply(reply, 400, 'Polymarket account not created');
    }

    if (!request.body.amount) {
      return errorReply(reply, 400, 'Missing amount');
    }

    // Bridge execution uses the same LiFi flow as other cross-chain operations.
    // The quote is obtained first, then the user's wallet signs the transaction.
    const quote = await getBridgeQuote(
      user.polymarket_account.polygon_address,
      request.body.amount,
      logKey
    );

    return successReply(reply, {
      message: 'Bridge quote prepared. Execute via LiFi flow.',
      quote
    });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to execute bridge');
  }
};

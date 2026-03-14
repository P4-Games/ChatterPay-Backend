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

import { randomUUID } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { POLYMARKET_ENABLED } from '../config/constants';
import { Logger } from '../helpers/loggerHelper';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import type { IUser } from '../models/userModel';
import { mongoBlockchainService } from '../services/mongo/mongoBlockchainService';
import {
  createOrder,
  createPurchase,
  getActivePurchases,
  getPendingOrders,
  getPurchaseById
} from '../services/mongo/mongoPolymarketService';
import {
  acceptTerms,
  cancelAllOrders,
  cancelOrder,
  createPolymarketAccount,
  getAccountStatus,
  getBridgeQuote,
  getCategories,
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
  resolveMaxSize,
  searchMarkets,
  syncOpenOrders,
  withdrawSellProceeds
} from '../services/polymarket';
import { executeBridge, getPreferredScrollStablecoin, withdrawToScroll } from '../services/polymarket/polymarketBridgeService';
import { executeGaslessWithdrawal } from '../services/polymarket/polymarketRelayerService';
import { executePurchase } from '../services/polymarket/polymarketPurchaseService';
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
  PolymarketPurchaseBody,
  PolymarketPurchaseStatusBody,
  PolymarketSearchQuery,
  PolymarketSlugParams,
  PolymarketUserDataBody,
  PolymarketWithdrawBody
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
    const order = request.query.order ?? 'volume24hr';
    const ascending = request.query.ascending ?? false;
    const filterZeroVolume = request.query.filter_zero_volume ?? true;

    const markets = await getMarkets(
      {
        limit: request.query.limit,
        offset: request.query.offset,
        active: request.query.active,
        closed: request.query.closed,
        category: request.query.category,
        order,
        ascending,
        filterZeroVolume
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
    const order = request.query.order ?? 'volume24hr';
    const ascending = request.query.ascending ?? false;
    const filterZeroVolume = request.query.filter_zero_volume ?? true;

    const events = await getEvents(
      {
        limit: request.query.limit,
        offset: request.query.offset,
        active: request.query.active,
        closed: request.query.closed,
        category: request.query.category,
        slug: request.query.slug,
        order,
        ascending,
        filterZeroVolume
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

/** GET /polymarket/categories */
export const polymarketGetCategories = async (
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-categories]`;

  try {
    const categories = await getCategories(logKey);
    return successReply(reply, { categories });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch categories');
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
    let user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }

    // Auto-create the Polymarket account if it doesn't exist yet.
    // This allows the terms overlay to be the single entry point — the user
    // accepts terms and their account is created in one step.
    if (!user.polymarket_account) {
      Logger.log(
        'info',
        LOG_PREFIX,
        `${logKey} No account found — auto-creating before terms acceptance`
      );
      const privateKey = await getUserPrivateKey(user);
      user = await createPolymarketAccount(user, privateKey, logKey);
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

    const { token_id, price, size: rawSize, side, order_type } = request.body;
    if (!token_id || price == null || rawSize == null || !side) {
      return errorReply(reply, 400, 'Missing required order parameters');
    }

    if (rawSize === 'max' && side !== 'SELL') {
      return errorReply(reply, 400, 'size=max is only supported for SELL orders');
    }

    const privateKey = await getUserPrivateKey(user);

    // Resolve 'max' size for SELL orders by querying the CLOB balance
    let size: number;
    if (rawSize === 'max') {
      size = await resolveMaxSize(user, privateKey, token_id, logKey);
      Logger.log('info', LOG_PREFIX, `${logKey} Resolved max size: ${size} shares`);
    } else {
      size = rawSize;
    }

    // ── Auto-bridge: Scroll → Polygon ────────────────────────────────────
    // The user's USDC lives on Scroll. We need to bridge it to Polygon
    // before placing the order on Polymarket.
    //
    // Required USDC = price × size (e.g. 0.55 × 10 = 5.5 USDC)
    // We add a small buffer (2%) to cover bridge fees / slippage.
    if (side === 'BUY') {
      const requiredUsdc = price * size;
      const bridgeBuffer = 1.02; // 2% buffer for bridge fees
      const bridgeAmountHuman = requiredUsdc * bridgeBuffer;
      // Convert to smallest units (USDC has 6 decimals)
      const bridgeAmountSmallest = Math.ceil(bridgeAmountHuman * 1_000_000).toString();

      Logger.log(
        'info',
        LOG_PREFIX,
        `${logKey} Auto-bridging ${bridgeAmountHuman.toFixed(2)} USDC (Scroll→Polygon) for order`
      );

      try {
        const bridgeResult = await executeBridge(user, privateKey, bridgeAmountSmallest, logKey);
        Logger.log('info', LOG_PREFIX, `${logKey} Bridge completed: ${bridgeResult.txHash}`);
      } catch (bridgeError) {
        Logger.log('error', LOG_PREFIX, `${logKey} Bridge failed: ${String(bridgeError)}`);
        return errorReply(reply, 500, `Bridge from Scroll to Polygon failed: ${String(bridgeError)}`);
      }
    } else {
      Logger.log('info', LOG_PREFIX, `${logKey} SELL order detected. Skipping Scroll→Polygon bridge.`);
    }

    // ── Place order (using the bridged amount as the actual order size) ──
    // The bridge output may differ slightly from the input due to fees.
    // We use the original requested size since the buffer should cover it.
    const result = await placeOrder(
      user,
      privateKey,
      {
        tokenId: token_id,
        price,
        size,
        side,
        orderType: order_type
      },
      logKey
    );

    // The CLOB SDK response may use different field names for the order ID.
    const raw = result as unknown as Record<string, unknown>;
    const orderId = raw.orderID ?? raw.id ?? raw.order_id ?? randomUUID();

    // Persist order to MongoDB
    const orderRecord = await createOrder({
      user_phone: user.phone_number,
      order_id: String(orderId),
      market_condition_id: token_id,
      market_slug: '',
      token_id,
      side,
      price,
      size,
      status: 'pending'
    });

    // Auto-withdraw SELL proceeds from Polygon Safe → Scroll proxy.
    // Fire-and-forget so the API response isn't delayed.
    if (side === 'SELL') {
      withdrawSellProceeds(user, privateKey, logKey).catch((err) => {
        Logger.log('error', LOG_PREFIX, `${logKey} Background withdrawal failed: ${String(err)}`);
      });
    }

    return successReply(reply, {
      order: result,
      order_id: String(orderId),
      status: 'pending',
      side,
      price,
      size,
      token_id,
      withdrawal_pending: side === 'SELL',
      created_at: orderRecord.created_at
    });
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

    // Fetch CLOB live orders, active purchases, and pending local orders in parallel
    const [orders, activePurchases, pendingOrders] = await Promise.all([
      getOpenOrders(user, privateKey, logKey),
      getActivePurchases(user.phone_number),
      getPendingOrders(user.phone_number)
    ]);

    // Sync local DB orders with CLOB state (fire-and-forget)
    syncOpenOrders(user, privateKey, logKey).catch((err) => {
      Logger.log('warn', LOG_PREFIX, `${logKey} Background order sync failed: ${String(err)}`);
    });

    return successReply(reply, {
      orders,
      active_purchases: activePurchases.map((p) => ({
        purchase_id: p.purchase_id,
        token_id: p.token_id,
        side: p.side,
        price: p.price,
        size: p.size,
        status: p.status,
        current_step: p.current_step,
        steps: p.steps,
        order_id: p.order_id,
        created_at: p.created_at,
        updated_at: p.updated_at
      })),
      pending_orders: pendingOrders.map((o) => ({
        order_id: o.order_id,
        token_id: o.token_id,
        side: o.side,
        price: o.price,
        size: o.size,
        status: o.status,
        created_at: o.created_at
      }))
    });
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

    const [positions, activePurchases] = await Promise.all([
      getPositions(user.polymarket_account.polygon_address, logKey),
      getActivePurchases(user.phone_number)
    ]);

    // Sync local DB order statuses with CLOB in the background
    getUserPrivateKey(user).then((pk) =>
      syncOpenOrders(user, pk, logKey).catch((err) => {
        Logger.log('warn', LOG_PREFIX, `${logKey} Background order sync failed: ${String(err)}`);
      })
    ).catch(() => { /* key derivation failed — skip sync */ });

    return successReply(reply, {
      positions,
      active_purchases: activePurchases.map((p) => ({
        purchase_id: p.purchase_id,
        token_id: p.token_id,
        side: p.side,
        price: p.price,
        size: p.size,
        status: p.status,
        current_step: p.current_step,
        steps: p.steps,
        order_id: p.order_id,
        created_at: p.created_at,
        updated_at: p.updated_at
      }))
    });
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

    // Determine which stablecoin the user holds on Scroll (USDC or USDT)
    const proxyAddress = user.wallets[0]?.wallet_proxy || '';
    const fromToken = proxyAddress
      ? await getPreferredScrollStablecoin(proxyAddress, logKey)
      : 'USDC';

    const quote = await getBridgeQuote(
      user.polymarket_account.polygon_address,
      request.body.amount,
      logKey,
      fromToken
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

    // Determine which stablecoin the user holds on Scroll (USDC or USDT)
    const proxyAddress = user.wallets[0]?.wallet_proxy || '';
    const fromToken = proxyAddress
      ? await getPreferredScrollStablecoin(proxyAddress, logKey)
      : 'USDC';

    // Bridge execution uses the same LiFi flow as other cross-chain operations.
    // The quote is obtained first, then the user's wallet signs the transaction.
    const quote = await getBridgeQuote(
      user.polymarket_account.polygon_address,
      request.body.amount,
      logKey,
      fromToken
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

/** POST /polymarket/bridge/withdraw */
export const polymarketWithdraw = async (
  request: FastifyRequest<{ Body: PolymarketWithdrawBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-withdraw]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }
    if (!user.polymarket_account) {
      return errorReply(reply, 400, 'Polymarket account not created');
    }
    
    // Ensure the wallet was derived properly so we can transact for them
    const privateKey = await getUserPrivateKey(user);

    if (!request.body.amount || Number(request.body.amount) <= 0) {
      return errorReply(reply, 400, 'Missing or invalid amount');
    }

    const proxyAddress = user.wallets[0]?.wallet_proxy || '';
    if (!proxyAddress) {
      return errorReply(reply, 400, 'User missing proxy wallet');
    }

    // Amount comes from frontend as human-readable (e.g. "6.59")
    // Convert to smallest units (USDC.e has 6 decimals)
    const amountSmallest = Math.floor(Number(request.body.amount) * 1_000_000).toString();

    // Determine which stablecoin the user holds on Scroll (USDC or USDT)
    const toToken = await getPreferredScrollStablecoin(proxyAddress, logKey);

    const quote = await withdrawToScroll(
      user.polymarket_account.polygon_address,
      proxyAddress,
      amountSmallest,
      logKey,
      toToken
    );

    // Step 2: Push quote payloads into Relayer for gasless execution
    // executeGaslessWithdrawal takes (privateKey, withdrawData, amount, logKey)
    await executeGaslessWithdrawal(
      privateKey,
      {
        approvalAddress: quote.approvalAddress,
        to: quote.to,
        data: quote.data,
        value: quote.value
      },
      amountSmallest,
      logKey
    );

    return successReply(reply, {
      message: 'Withdrawal to Scroll initiated via Relayer gaslessly',
      quote_details: {
        to: quote.to,
        amount: quote.value
      }
    });

  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, `Withdrawal failed: ${String(error)}`);
    return errorReply(reply, 500, `Failed to execute withdrawal: ${String(error)}`);
  }
};

// ============================================================================
// Purchase Endpoints (unified flow)
// ============================================================================

/** POST /polymarket/purchase */
export const polymarketPurchase = async (
  request: FastifyRequest<{ Body: PolymarketPurchaseBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-purchase]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }

    const { token_id, price, size: rawSize, side, order_type, bridge_amount, terms_version } = request.body;
    if (!token_id || price == null || rawSize == null || !side) {
      return errorReply(
        reply,
        400,
        'Missing required parameters (token_id, price, size, side)'
      );
    }

    if (rawSize === 'max' && side !== 'SELL') {
      return errorReply(reply, 400, 'size=max is only supported for SELL orders');
    }

    const safeBridgeAmount = bridge_amount ?? '0';
    if (side === 'BUY' && (!bridge_amount || bridge_amount === '0')) {
      return errorReply(
        reply,
        400,
        'Missing required parameter (bridge_amount) for BUY order'
      );
    }

    // Terms validation:
    // - Account exists + terms accepted → proceed
    // - Account exists + terms NOT accepted → error
    // - No account → terms_version required in body (will create account + accept terms)
    if (user.polymarket_account) {
      if (!hasAcceptedCurrentTerms(user)) {
        return errorReply(
          reply,
          403,
          'Terms not accepted. Call /polymarket/account/accept_terms first.'
        );
      }
    } else {
      if (!terms_version) {
        return errorReply(
          reply,
          400,
          'Polymarket account does not exist. Provide terms_version to create account during purchase.'
        );
      }
    }

    const privateKey = await getUserPrivateKey(user);

    // Resolve 'max' size for SELL orders by querying the CLOB balance
    let size: number;
    if (rawSize === 'max') {
      size = await resolveMaxSize(user, privateKey, token_id, logKey);
      Logger.log('info', LOG_PREFIX, `${logKey} Resolved max size: ${size} shares`);
    } else {
      size = rawSize;
    }

    const purchaseId = randomUUID();

    // Create purchase record
    await createPurchase({
      purchase_id: purchaseId,
      user_phone: user.phone_number,
      token_id,
      price,
      size,
      side,
      order_type,
      bridge_amount: safeBridgeAmount,
      terms_version
    });

    // Fire-and-forget: execute the purchase flow in background
    executePurchase(
      user,
      privateKey,
      purchaseId,
      {
        tokenId: token_id,
        price,
        size,
        side,
        orderType: order_type,
        bridgeAmount: safeBridgeAmount,
        termsVersion: terms_version
      },
      logKey
    ).catch((error) => {
      Logger.error(LOG_PREFIX, logKey, `Background purchase failed: ${String(error)}`);
    });

    return successReply(reply, { purchase_id: purchaseId });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, `Failed to initiate purchase: ${String(error)}`);
  }
};

/** POST /polymarket/purchase/status */
export const polymarketPurchaseStatus = async (
  request: FastifyRequest<{ Body: PolymarketPurchaseStatusBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-purchase-status]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }

    if (!request.body.purchase_id) {
      return errorReply(reply, 400, 'Missing purchase_id');
    }

    const purchase = await getPurchaseById(request.body.purchase_id);
    if (!purchase) {
      return errorReply(reply, 404, 'Purchase not found');
    }

    // Ensure the purchase belongs to the requesting user
    if (purchase.user_phone !== user.phone_number) {
      return errorReply(reply, 403, 'Purchase does not belong to this user');
    }

    return successReply(reply, {
      purchase_id: purchase.purchase_id,
      status: purchase.status,
      current_step: purchase.current_step,
      steps: purchase.steps,
      order_id: purchase.order_id,
      bridge_tx_hash: purchase.bridge_tx_hash,
      error: purchase.error,
      created_at: purchase.created_at,
      updated_at: purchase.updated_at
    });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to get purchase status');
  }
};

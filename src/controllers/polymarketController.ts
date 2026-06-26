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
import { ethers } from 'ethers';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  CHATTERPAY_DOMAIN,
  POLYMARKET_ENABLED,
  POLYMARKET_POLYGON_RPC_URL,
  POLYMARKET_TERMS_VERSION
} from '../config/constants';
import { Logger } from '../helpers/loggerHelper';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import type { IUser } from '../models/userModel';
import { mongoBlockchainService } from '../services/mongo/mongoBlockchainService';
import { mongoCountryService } from '../services/mongo/mongoCountryService';
import {
  createOrder,
  createPurchase,
  getActivePurchases,
  getPendingOrders,
  getPurchaseById,
  updatePurchaseStatus
} from '../services/mongo/mongoPolymarketService';
import {
  sendPolymarketDisabledNotification,
  sendPolymarketTermsNotAcceptedNotification,
  sendPolymarketTermsRequest
} from '../services/notificationService';
import {
  acceptTerms,
  BRIDGE_FEE_BUFFER,
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
  getMarketByClobTokenId,
  getMarketBySlug,
  getMarketPrice,
  getMarkets,
  getOpenOrders,
  getPnlHistory,
  getPolymarketBalanceSummary,
  getPortfolioValue,
  getPositions,
  getTradeHistory,
  getTradesHistory,
  hasAcceptedCurrentTerms,
  MIN_BUY_ORDER_USD,
  POLYMARKET_MAX_PRICE,
  POLYMARKET_MIN_PRICE,
  PUSD_ADDRESS,
  placeOrder,
  resolveMaxSize,
  searchEvents,
  syncOpenOrders,
  withdrawSellProceeds
} from '../services/polymarket';
import {
  executeBridge,
  getPreferredScrollStablecoin,
  getScrollStablecoinTotal,
  withdrawToScroll
} from '../services/polymarket/polymarketBridgeService';
import {
  discardSupersededOrder,
  enrichOrderModelSlug,
  markOrderInProgress,
  recordBridge,
  recordOrderFailed,
  recordOrderIntent,
  recordOrderPlaced,
  recordWithdraw,
  refineBuyToken
} from '../services/polymarket/polymarketHistoryService';
import {
  claimWinningPositions,
  executePurchase
} from '../services/polymarket/polymarketPurchaseService';
import {
  createRelayClient,
  deploySafeWallet,
  deriveSafeAddress,
  executeGaslessWithdrawal,
  transferPusdFromDepositWallet
} from '../services/polymarket/polymarketRelayerService';
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
  PolymarketPnlHistoryBody,
  PolymarketPurchaseBody,
  PolymarketPurchaseStatusBody,
  PolymarketSearchQuery,
  PolymarketSlugParams,
  PolymarketTradeHistoryBody,
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

/** Check if Polymarket is enabled. If a channelUserId is provided, sends a WhatsApp notification. */
function checkEnabled(reply: FastifyReply, channelUserId?: string): boolean {
  if (!POLYMARKET_ENABLED) {
    if (channelUserId) {
      sendPolymarketDisabledNotification(channelUserId).catch(() => {});
    }
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
    sendPolymarketTermsNotAcceptedNotification(
      user.phone_number,
      String(POLYMARKET_TERMS_VERSION)
    ).catch(() => {});
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
    const userChannelId = request.query.user_channel_id;

    // Resolve country name from phone number for region-specific events
    // Skip country-based search when filtering by category
    let countryName: string | null = null;
    if (userChannelId && !request.query.category) {
      try {
        const country = await mongoCountryService.getCountryByPhoneNumber(userChannelId);
        if (country?.name) {
          countryName = country.name;
          Logger.log(
            'info',
            LOG_PREFIX,
            `${logKey} Resolved country "${countryName}" from phone ${userChannelId}`
          );
        }
      } catch {
        // Country lookup is best-effort; fall through to regular events
      }
    }

    // Only prepend regional events on the first page (offset 0).
    // Subsequent pages return only regular events for proper infinite scrolling.
    const isFirstPage = !Number(request.query.offset);
    const COUNTRY_EVENTS_COUNT = 3;

    const [countryEvents, regularEvents] = await Promise.all([
      countryName && isFirstPage
        ? searchEvents(countryName, COUNTRY_EVENTS_COUNT, logKey)
        : Promise.resolve([]),
      getEvents(
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
      )
    ]);

    // Deduplicate: remove country events from the regular list, then prepend them
    const countryEventIds = new Set(countryEvents.map((e) => e.id));
    const dedupedRegular = regularEvents.filter((e) => !countryEventIds.has(e.id));
    const events = [...countryEvents, ...dedupedRegular];

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

    const events = await searchEvents(request.query.query, request.query.limit ?? 10, logKey);

    return successReply(reply, { events });
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

    const updatedUser = await acceptTerms(user, logKey);
    return successReply(reply, {
      message: `Terms v${POLYMARKET_TERMS_VERSION} accepted`,
      account: getAccountStatus(updatedUser)
    });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, `Failed to accept terms: ${String(error)}`);
  }
};

// ============================================================================
// Terms Endpoints
// ============================================================================

/** GET /polymarket/terms — public, no auth required */
export const polymarketGetPublicTerms = async (
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-public-terms]`;

  try {
    const terms = await getCurrentTerms(logKey);
    if (!terms) {
      return errorReply(reply, 404, 'Terms not found');
    }

    return successReply(reply, {
      version: terms.version,
      content: terms.content,
      effective_date: terms.effective_date,
      terms_url: `${CHATTERPAY_DOMAIN}/polymarket/terms`
    });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch terms');
  }
};

/** POST /polymarket/terms/send — sends WhatsApp interactive Accept/Decline button to user */
export const polymarketSendTerms = async (
  request: FastifyRequest<{ Body: PolymarketAccountBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-send-terms]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }

    const terms = await getCurrentTerms(logKey);
    if (!terms) {
      return errorReply(reply, 404, 'Terms not found');
    }

    const termsUrl = `${CHATTERPAY_DOMAIN}/polymarket/terms`;

    await sendPolymarketTermsRequest(user.phone_number, String(terms.version), termsUrl);

    return successReply(reply, { message: 'NO_REPLY_REQUIRED' });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to send terms request');
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
  // Stable id for the order lifecycle history record (declared here so the
  // outer catch can mark it failed). Assigned once the account/price are known.
  let orderTrx: string | undefined;

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

    // ── Price validation ──────────────────────────────────────────────────
    // Polymarket requires prices strictly in (0.001, 0.999). A price of exactly
    // 0 or 1 means the market has resolved; clamp to the boundary and let the
    // CLOB reject with its own error if the market is truly closed.
    // priceClampedToMax is used below as a fallback signal: if the SELL order
    // fails after clamping, the market is almost certainly resolved and we
    // should try CTF redemption instead.
    const priceClampedToMax = price >= POLYMARKET_MAX_PRICE;
    let effectivePrice = price;
    if (priceClampedToMax) {
      effectivePrice = POLYMARKET_MAX_PRICE;
      Logger.log(
        'warn',
        LOG_PREFIX,
        `${logKey} Price ${price} clamped to ${POLYMARKET_MAX_PRICE} — market may be near resolution`
      );
    } else if (price <= POLYMARKET_MIN_PRICE) {
      effectivePrice = POLYMARKET_MIN_PRICE;
      Logger.log(
        'warn',
        LOG_PREFIX,
        `${logKey} Price ${price} clamped to ${POLYMARKET_MIN_PRICE} — market may be near resolution`
      );
    }

    // ── Minimum order value (BUY) ─────────────────────────────────────────
    // Enforced above Polymarket's $1.00 FOK minimum so bridge fees/slippage
    // can't push the deliverable amount below the CLOB's floor.
    if (side === 'BUY' && effectivePrice * size < MIN_BUY_ORDER_USD) {
      const minShares = Math.ceil((MIN_BUY_ORDER_USD / effectivePrice) * 100) / 100;
      return errorReply(
        reply,
        400,
        `Order value $${(effectivePrice * size).toFixed(2)} is below the $${MIN_BUY_ORDER_USD.toFixed(2)} minimum for BUY orders. ` +
          `At price $${effectivePrice}, buy at least ${minShares} shares.`
      );
    }

    // Record the order intent (status `submitted`) before any bridge so a
    // failure at the bridge step still leaves a `failed` order row in history.
    orderTrx = await recordOrderIntent({
      side,
      refId: randomUUID(),
      userProxy: user.wallets[0]?.wallet_proxy || '',
      price: effectivePrice,
      size,
      tokenId: token_id,
      logKey
    });

    // ── Auto-bridge: Scroll → Polygon ────────────────────────────────────
    // The user's USDC lives on Scroll. We need to bridge it to Polygon
    // before placing the order on Polymarket.
    //
    // Required USDC = price × size (e.g. 0.55 × 10 = 5.5 USDC)
    // We add a small buffer (2%) to cover bridge fees / slippage.
    if (side === 'BUY') {
      const requiredUsdc = effectivePrice * size;
      const bridgeAmountHuman = requiredUsdc * BRIDGE_FEE_BUFFER;

      Logger.log(
        'info',
        LOG_PREFIX,
        `${logKey} Auto-bridging ${bridgeAmountHuman.toFixed(2)} USDC (Scroll→Polygon) for order`
      );

      try {
        const bridgeResult = await executeBridge(
          user,
          privateKey,
          bridgeAmountHuman.toFixed(6),
          logKey
        );
        Logger.log('info', LOG_PREFIX, `${logKey} Bridge completed: ${bridgeResult.txHash}`);

        // Save bridge to transaction history
        await recordBridge({
          txHash: bridgeResult.txHash,
          walletFrom: user.wallets[0]?.wallet_proxy || '',
          walletTo: user.polymarket_account!.polygon_address,
          amount: bridgeAmountHuman,
          token: bridgeResult.fromToken || 'USDC',
          side
        });

        // Refine the buy order record to show the Scroll-side token/amount.
        void refineBuyToken(orderTrx!, bridgeResult.fromToken || 'pUSD', bridgeAmountHuman);
      } catch (bridgeError) {
        Logger.log('error', LOG_PREFIX, `${logKey} Bridge failed: ${String(bridgeError)}`);
        await recordOrderFailed(orderTrx, `Bridge failed: ${String(bridgeError)}`);
        return errorReply(
          reply,
          500,
          `Bridge from Scroll to Polygon failed: ${String(bridgeError)}`
        );
      }
    } else {
      Logger.log(
        'info',
        LOG_PREFIX,
        `${logKey} SELL order detected. Skipping Scroll→Polygon bridge.`
      );
    }

    // ── Place order (using the bridged amount as the actual order size) ──
    // The bridge output may differ slightly from the input due to fees.
    // We use the original requested size since the buffer should cover it.
    //
    // If the SELL order fails after the price was clamped to the max boundary,
    // the market is almost certainly resolved — fall back to CTF redemption
    // instead of surfacing a confusing CLOB error to the caller.
    // Placement underway — move the order history record to in_progress.
    await markOrderInProgress(orderTrx);

    let result;
    try {
      result = await placeOrder(
        user,
        privateKey,
        {
          tokenId: token_id,
          price: effectivePrice,
          size,
          side,
          orderType: order_type
        },
        logKey
      );
    } catch (orderError) {
      if (side === 'SELL' && priceClampedToMax) {
        Logger.log(
          'warn',
          LOG_PREFIX,
          `${logKey} SELL failed on boundary price (${effectivePrice}) — attempting CTF claim fallback. Error: ${String(orderError)}`
        );
        const marketInfo = await getMarketByClobTokenId(token_id, logKey).catch(() => null);
        const claimConditionId = marketInfo?.conditionId;
        const claimResult = await claimWinningPositions(user, privateKey, logKey, claimConditionId);
        if (claimResult.claimed > 0) {
          // The SELL was superseded by a CTF claim (recorded inside
          // claimWinningPositions) — discard the redundant sell row so the user
          // sees a single "settlement" entry, not a phantom failed sell.
          await discardSupersededOrder(orderTrx);
          return successReply(reply, {
            claimed: claimResult.claimed,
            tx_hash: claimResult.txHash,
            withdrawal_pending: true,
            message: `Market appears resolved. Claimed ${claimResult.claimed} winning position(s). Proceeds are being withdrawn to Scroll.`
          });
        }
      }
      throw orderError;
    }

    // The CLOB SDK response may use different field names for the order ID.
    const raw = result as unknown as Record<string, unknown>;
    const orderId = raw.orderID ?? raw.id ?? raw.order_id ?? randomUUID();

    // Persist order to MongoDB
    const orderRecord = await createOrder({
      user_phone: user.phone_number,
      order_id: String(orderId),
      market_condition_id: token_id,
      token_id,
      side,
      price: effectivePrice,
      size,
      status: 'pending'
    });
    void enrichOrderModelSlug(String(orderId), token_id, logKey);

    // Order accepted by the CLOB — evolve the history record to completed and
    // attach the real CLOB order id (async fills refine it via syncOpenOrders).
    await recordOrderPlaced(orderTrx, {
      orderId: String(orderId),
      price: effectivePrice,
      effectiveSize: size
    });

    // Auto-withdraw SELL proceeds from Polygon Safe → Scroll proxy.
    // Fire-and-forget so the API response isn't delayed.
    if (side === 'SELL') {
      withdrawSellProceeds(user, privateKey, logKey, undefined, orderTrx).catch((err) => {
        Logger.log('error', LOG_PREFIX, `${logKey} Background withdrawal failed: ${String(err)}`);
      });
    }

    return successReply(reply, {
      order: result,
      order_id: String(orderId),
      status: 'pending',
      side,
      price: effectivePrice,
      size,
      token_id,
      withdrawal_pending: side === 'SELL',
      created_at: orderRecord.created_at
    });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    if (orderTrx) await recordOrderFailed(orderTrx, String(error));
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
    getUserPrivateKey(user)
      .then((pk) =>
        syncOpenOrders(user, pk, logKey).catch((err) => {
          Logger.log('warn', LOG_PREFIX, `${logKey} Background order sync failed: ${String(err)}`);
        })
      )
      .catch(() => {
        /* key derivation failed — skip sync */
      });

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

    const polygonAddress = user.polymarket_account.polygon_address;
    const eoaAddress = user.wallets[0]?.wallet_eoa;
    const safeAddress =
      user.polymarket_account.wallet_type === 'deposit' && eoaAddress
        ? deriveSafeAddress(eoaAddress)
        : undefined;

    const [portfolio, { idle_usdc }] = await Promise.all([
      getPortfolioValue(polygonAddress, logKey),
      getPolymarketBalanceSummary(polygonAddress, logKey, safeAddress)
    ]);
    return successReply(reply, { portfolio, idle_usdc });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch portfolio value');
  }
};

/** POST /polymarket/trades */
export const polymarketGetTradesHistory = async (
  request: FastifyRequest<{ Body: PolymarketTradeHistoryBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-trades-history]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }
    if (!user.polymarket_account) {
      return errorReply(reply, 400, 'Polymarket account not created');
    }

    const { market, limit, offset, side } = request.body;
    const trades = await getTradesHistory(
      user.polymarket_account.polygon_address,
      { market, limit, offset, side },
      logKey
    );
    return successReply(reply, { trades });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch trades history');
  }
};

/** POST /polymarket/pnl/history */
export const polymarketGetPnlHistory = async (
  request: FastifyRequest<{ Body: PolymarketPnlHistoryBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-pnl-history]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) {
      return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    }
    if (!user.polymarket_account) {
      return errorReply(reply, 400, 'Polymarket account not created');
    }

    const history = await getPnlHistory(
      user.polymarket_account.polygon_address,
      logKey,
      request.body.limit
    );
    return successReply(reply, { history });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, 'Failed to fetch PNL history');
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

    const walletType = user.polymarket_account.wallet_type ?? 'safe';
    let bridgeSourceAddress = user.polymarket_account.polygon_address;

    const { ethers } = await import('ethers');
    const { POLYMARKET_POLYGON_RPC_URL } = await import('../config/constants');
    const { PUSD_ADDRESS, USDCE_ADDRESS } = await import(
      '../services/polymarket/polymarketConstants'
    );

    const balanceAbi = ['function balanceOf(address) view returns (uint256)'];
    const provider = new ethers.providers.JsonRpcProvider(POLYMARKET_POLYGON_RPC_URL);
    const pusd = new ethers.Contract(PUSD_ADDRESS, balanceAbi, provider);
    const usdce = new ethers.Contract(USDCE_ADDRESS, balanceAbi, provider);

    // Deposit wallet: relayer blocks LiFi spender approval.
    // Transfer pUSD to Safe first, then bridge from Safe.
    if (walletType === 'deposit') {
      const safeAddress = deriveSafeAddress(new ethers.Wallet(privateKey).address);

      // Transfer any pUSD and USDC.e sitting in the deposit wallet to the Safe.
      // Settlements from legacy markets pay in USDC.e; new markets pay in pUSD.
      const [depositPusd, depositUsdce] = await Promise.all([
        pusd.balanceOf(bridgeSourceAddress),
        usdce.balanceOf(bridgeSourceAddress)
      ]);

      if (depositPusd.gt(0)) {
        await transferPusdFromDepositWallet(
          privateKey,
          user.polymarket_account.polygon_address,
          safeAddress,
          depositPusd.toString(),
          logKey
        );
      }

      if (depositUsdce.gt(0)) {
        const erc20Iface = new ethers.utils.Interface([
          'function transfer(address to, uint256 amount) returns (bool)'
        ]);
        const client = createRelayClient(privateKey);
        const deadline = Math.floor(Date.now() / 1000 + 3600).toString();
        const resp = await client.executeDepositWalletBatch(
          [
            {
              target: USDCE_ADDRESS,
              data: erc20Iface.encodeFunctionData('transfer', [
                safeAddress,
                depositUsdce.toString()
              ]),
              value: '0'
            }
          ],
          user.polymarket_account.polygon_address,
          deadline
        );
        await resp.wait();
        Logger.log(LOG_PREFIX, `${logKey} Transferred USDC.e from deposit wallet to Safe`);
      }

      bridgeSourceAddress = safeAddress;
    }

    // Check both pUSD and USDC.e balances in the bridge source (Safe).
    // Prefer pUSD; fall back to USDC.e for legacy market settlements.
    const [safePusdBal, safeUsdceBal] = await Promise.all([
      pusd.balanceOf(bridgeSourceAddress),
      usdce.balanceOf(bridgeSourceAddress)
    ]);

    const requestedBn = ethers.BigNumber.from(amountSmallest);
    const MIN_BRIDGE_UNITS = ethers.BigNumber.from(1_000_000); // $1

    let actualBal: ethers.BigNumber;
    let fromTokenAddress: string;

    if (safePusdBal.gte(MIN_BRIDGE_UNITS)) {
      actualBal = safePusdBal;
      fromTokenAddress = PUSD_ADDRESS;
    } else if (safeUsdceBal.gte(MIN_BRIDGE_UNITS)) {
      actualBal = safeUsdceBal;
      fromTokenAddress = USDCE_ADDRESS;
    } else {
      Logger.log(
        'warn',
        LOG_PREFIX,
        `${logKey} No bridgeable stablecoin in Safe (pUSD=${safePusdBal}, USDC.e=${safeUsdceBal}). Triggering claim+withdraw flow.`
      );
      claimWinningPositions(user, privateKey, logKey).catch((err) =>
        Logger.log('error', LOG_PREFIX, `${logKey} Background claim failed: ${String(err)}`)
      );
      return successReply(reply, {
        withdrawal_pending: true,
        message:
          'Insufficient pUSD in wallet. Claim + withdrawal initiated — funds will arrive on Scroll once positions are redeemed.'
      });
    }

    const bridgeAmountSmallest = actualBal.lt(requestedBn) ? actualBal.toString() : amountSmallest;

    if (actualBal.lt(requestedBn)) {
      Logger.log(
        'warn',
        LOG_PREFIX,
        `${logKey} Capping bridge from ${requestedBn} to actual balance ${actualBal}`
      );
    }

    await deploySafeWallet(privateKey, logKey);

    const quote = await withdrawToScroll(
      bridgeSourceAddress,
      proxyAddress,
      bridgeAmountSmallest,
      logKey,
      toToken,
      fromTokenAddress
    );
    await executeGaslessWithdrawal(
      privateKey,
      {
        approvalAddress: quote.approvalAddress,
        to: quote.to,
        data: quote.data,
        value: quote.value
      },
      bridgeAmountSmallest,
      logKey,
      fromTokenAddress
    );

    const withdrawAmountHuman = Number(bridgeAmountSmallest) / 1_000_000;
    await recordWithdraw({
      walletFrom: user.polymarket_account.polygon_address,
      walletTo: proxyAddress,
      amount: withdrawAmountHuman,
      token: toToken
    });

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

    const {
      token_id,
      price,
      size: rawSize,
      side,
      order_type,
      bridge_amount,
      bridge_token,
      terms_version
    } = request.body;

    if (!token_id || price == null || rawSize == null || !side) {
      return errorReply(reply, 400, 'Missing required parameters (token_id, price, size, side)');
    }

    if (rawSize === 'max' && side !== 'SELL') {
      return errorReply(reply, 400, 'size=max is only supported for SELL orders');
    }

    // Polymarket requires prices in (0.001, 0.999).
    // For BUY orders with an out-of-range price, reject early — no bridge should start.
    // For SELL orders with price >= 0.999 the market is likely resolved; fall through to
    // the claim flow below instead of returning an error.
    const priceClampedToMax = side === 'SELL' && price >= POLYMARKET_MAX_PRICE;
    if (!priceClampedToMax && (price < 0.001 || price > 0.999)) {
      return errorReply(
        reply,
        400,
        `Invalid price ${price}: must be between 0.001 and 0.999. The market may have already been resolved.`
      );
    }

    // Minimum order value for BUY: enforced above Polymarket's $1.00 FOK
    // minimum so bridge fees/slippage can't push the deliverable below it.
    // (BUY size is always numeric — size=max is rejected above for BUY.)
    if (side === 'BUY' && price * (rawSize as number) < MIN_BUY_ORDER_USD) {
      const minShares = Math.ceil((MIN_BUY_ORDER_USD / price) * 100) / 100;
      return errorReply(
        reply,
        400,
        `Order value $${(price * (rawSize as number)).toFixed(2)} is below the $${MIN_BUY_ORDER_USD.toFixed(2)} minimum for BUY orders. ` +
          `At price $${price}, buy at least ${minShares} shares.`
      );
    }

    // Auto-compute bridge_amount when not provided for BUY orders.
    // Computed as: ceil(price * size * BRIDGE_FEE_BUFFER * 1_000_000) to cover fees/slippage.
    // This avoids requiring the caller (e.g. an LLM) to do floating-point arithmetic.
    let safeBridgeAmount: string;
    if (side === 'BUY') {
      if (bridge_amount && bridge_amount !== '0') {
        safeBridgeAmount = bridge_amount;
      } else {
        // Auto-compute: bridge enough to cover the full order + fee buffer.
        // size=max is resolved later, so use 0 here — executePurchase will use the actual deficit.
        const sizeNum = rawSize === 'max' ? 0 : (rawSize as number);
        safeBridgeAmount = (price * sizeNum * BRIDGE_FEE_BUFFER).toFixed(6);
      }
    } else {
      safeBridgeAmount = '0';
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

    // SELL at price >= 0.999 means the market is resolved — go straight to CTF claim.
    // We still create a purchase record so the UI can poll /purchase/status and resolve
    // the "placing order…" state, rather than hanging on 404 forever.
    if (priceClampedToMax) {
      const claimPurchaseId = randomUUID();
      await createPurchase({
        purchase_id: claimPurchaseId,
        user_phone: user.phone_number,
        token_id,
        price,
        size: typeof rawSize === 'number' ? rawSize : 0,
        side: 'SELL',
        order_type,
        bridge_amount: '0',
        terms_version
      });
      await updatePurchaseStatus(
        claimPurchaseId,
        'processing',
        'order_placement',
        undefined,
        logKey
      );

      Logger.log(
        'warn',
        LOG_PREFIX,
        `${logKey} SELL at boundary price (${price}) — market likely resolved, attempting CTF claim (purchase: ${claimPurchaseId})`
      );

      try {
        const marketInfo = await getMarketByClobTokenId(token_id, logKey).catch(() => null);
        const claimResult = await claimWinningPositions(
          user,
          privateKey,
          logKey,
          marketInfo?.conditionId
        );
        if (claimResult.claimed > 0) {
          await updatePurchaseStatus(claimPurchaseId, 'completed', 'done', undefined, logKey);
          return successReply(reply, {
            purchase_id: claimPurchaseId,
            claimed: claimResult.claimed,
            tx_hash: claimResult.txHash,
            withdrawal_pending: true,
            message: `Market appears resolved. Claimed ${claimResult.claimed} winning position(s). Proceeds are being withdrawn to Scroll.`
          });
        }
        await updatePurchaseStatus(
          claimPurchaseId,
          'failed',
          'done',
          { error: 'No claimable winning positions found' },
          logKey
        );
        return errorReply(
          reply,
          400,
          `Price ${price} suggests a resolved market but no claimable winning positions were found.`
        );
      } catch (claimError) {
        const errMsg = String(claimError);
        await updatePurchaseStatus(claimPurchaseId, 'failed', 'done', { error: errMsg }, logKey);
        throw claimError;
      }
    }

    // Resolve 'max' size for SELL orders by querying the CLOB balance
    let size: number;
    if (rawSize === 'max') {
      size = await resolveMaxSize(user, privateKey, token_id, logKey);
      Logger.log('info', LOG_PREFIX, `${logKey} Resolved max size: ${size} shares`);
    } else {
      size = rawSize;
    }

    // Early balance check for BUY: fail fast before starting async flow.
    // Skipped when bridge_token is a non-stablecoin (e.g. WETH) — resolveSourceToken
    // validates that balance later with the correct USD conversion.
    const SCROLL_STABLECOINS = new Set(['USDC', 'USDT']);
    const bridgeTokenIsStablecoin =
      !bridge_token || SCROLL_STABLECOINS.has(bridge_token.toUpperCase());
    if (side === 'BUY' && bridgeTokenIsStablecoin) {
      const proxyAddress = user.wallets[0]?.wallet_proxy || '';
      if (proxyAddress) {
        const requiredUsd = price * size;
        const scrollBalance = await getScrollStablecoinTotal(proxyAddress, logKey);
        if (scrollBalance < requiredUsd) {
          return errorReply(
            reply,
            400,
            `Insufficient balance: $${scrollBalance.toFixed(2)} available, need $${requiredUsd.toFixed(2)}`
          );
        }
      }
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
        orderType: order_type ?? 'FOK',
        bridgeAmountUsd: safeBridgeAmount,
        bridgeToken: bridge_token,
        termsVersion: terms_version
      },
      logKey
    ).catch(async (error) => {
      Logger.error(LOG_PREFIX, logKey, `Background purchase failed: ${String(error)}`);
      // Ensure the purchase record is marked as failed so it doesn't stay
      // stuck in "processing" forever if the error occurred before
      // executePurchase had a chance to update the status itself.
      try {
        await updatePurchaseStatus(purchaseId, 'failed', 'done', { error: String(error) }, logKey);
      } catch (statusError) {
        Logger.error(
          LOG_PREFIX,
          logKey,
          `Failed to mark purchase as failed: ${String(statusError)}`
        );
      }
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

/** POST /polymarket/positions/claim */
export const polymarketClaimPositions = async (
  request: FastifyRequest<{ Body: PolymarketUserDataBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  if (!checkEnabled(reply)) return reply;
  const logKey = `[op:polymarket-claim-positions]`;

  try {
    const user = await resolveUser(request.body.channel_user_id, logKey);
    if (!user) return errorReply(reply, 400, 'Invalid or missing channel_user_id');
    if (!validatePolymarketReady(user, reply)) return reply;

    const privateKey = await getUserPrivateKey(user);
    const result = await claimWinningPositions(user, privateKey, logKey);

    if (result.claimed === 0) {
      return successReply(reply, { claimed: 0, message: 'No winning positions to claim' });
    }

    return successReply(reply, {
      claimed: result.claimed,
      tx_hash: result.txHash,
      withdrawal_pending: true,
      message: `Claimed ${result.claimed} position(s). Proceeds are being withdrawn to Scroll.`
    });
  } catch (error) {
    Logger.error(LOG_PREFIX, logKey, String(error));
    return errorReply(reply, 500, `Failed to claim positions: ${String(error)}`);
  }
};

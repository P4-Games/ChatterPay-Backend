/**
 * Polymarket API Routes
 *
 * Registers all Polymarket endpoints on the Fastify instance.
 */

import type { FastifyInstance } from 'fastify';

import {
  polymarketAcceptTerms,
  polymarketBridge,
  polymarketBridgeQuote,
  polymarketCancelAllOrders,
  polymarketCancelOrder,
  polymarketCreateAccount,
  polymarketGetAccountStatus,
  polymarketGetCategories,
  polymarketGetClosedPositions,
  polymarketGetEventDetail,
  polymarketGetEvents,
  polymarketGetMarketDetail,
  polymarketGetMarkets,
  polymarketGetOpenOrders,
  polymarketGetPortfolioValue,
  polymarketGetPositions,
  polymarketGetTradeHistory,
  polymarketPlaceOrder,
  polymarketPurchase,
  polymarketPurchaseStatus,
  polymarketSearchMarkets
} from '../controllers/polymarketController';

export default async function polymarketRoutes(fastify: FastifyInstance): Promise<void> {
  // ── Read (no auth) ──────────────────────────────────────────────────────
  fastify.get('/polymarket/markets', polymarketGetMarkets);
  fastify.get('/polymarket/markets/:slug', polymarketGetMarketDetail);
  fastify.get('/polymarket/events', polymarketGetEvents);
  fastify.get('/polymarket/events/:slug', polymarketGetEventDetail);
  fastify.get('/polymarket/categories', polymarketGetCategories);
  fastify.get('/polymarket/search', polymarketSearchMarkets);

  // ── Account ─────────────────────────────────────────────────────────────
  fastify.post('/polymarket/account/status', polymarketGetAccountStatus);
  fastify.post('/polymarket/account/create', polymarketCreateAccount);
  fastify.post('/polymarket/account/accept_terms', polymarketAcceptTerms);

  // ── Trading ─────────────────────────────────────────────────────────────
  fastify.post('/polymarket/order/place', polymarketPlaceOrder);
  fastify.post('/polymarket/order/cancel', polymarketCancelOrder);
  fastify.post('/polymarket/order/cancel_all', polymarketCancelAllOrders);
  fastify.post('/polymarket/orders', polymarketGetOpenOrders);
  fastify.post('/polymarket/positions', polymarketGetPositions);
  fastify.post('/polymarket/positions/closed', polymarketGetClosedPositions);
  fastify.post('/polymarket/history', polymarketGetTradeHistory);
  fastify.post('/polymarket/portfolio', polymarketGetPortfolioValue);

  // ── Bridge ──────────────────────────────────────────────────────────────
  fastify.post('/polymarket/bridge/quote', polymarketBridgeQuote);
  fastify.post('/polymarket/bridge/execute', polymarketBridge);

  // ── Purchase (unified flow) ────────────────────────────────────────────
  fastify.post('/polymarket/purchase', polymarketPurchase);
  fastify.post('/polymarket/purchase/status', polymarketPurchaseStatus);
}

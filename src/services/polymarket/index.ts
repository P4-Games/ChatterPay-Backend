/**
 * Polymarket Service — Public API
 *
 * Re-exports all Polymarket service modules for convenient imports.
 */

// Account lifecycle
export {
  acceptTerms,
  createPolymarketAccount,
  getAccountStatus,
  getCurrentTerms,
  hasAcceptedCurrentTerms
} from './polymarketAccountService';
// Bridge (Scroll → Polygon)
export {
  checkBridgeStatus,
  executeBridge,
  getBridgeQuote,
  validateBridgeQuote
} from './polymarketBridgeService';
// Client management
export {
  createAuthenticatedClobClient,
  createPublicClobClient,
  decryptApiCredentials,
  derivePolygonAddress,
  encryptApiCredentials,
  getAuthenticatedClientForUser,
  getOrCreateApiCredentials
} from './polymarketClientService';
// Market data (read-only)
export {
  getCategories,
  getClobMarketInfo,
  getEventBySlug,
  getEvents,
  getMarketBySlug,
  getMarketPrice,
  getMarkets,
  getOrderBook,
  searchMarkets
} from './polymarketMarketService';
// Trading
export {
  cancelAllOrders,
  cancelOrder,
  getClosedPositions,
  getOpenOrders,
  getPortfolioValue,
  getPositions,
  getTradeHistory,
  placeOrder
} from './polymarketTradingService';
// Purchase (unified flow)
export { executePurchase } from './polymarketPurchaseService';
export type { PurchaseParams } from './polymarketPurchaseService';

// Types
export type {
  ClobMarketInfo,
  ClobOpenOrder,
  ClobOrderBook,
  ClobOrderResponse,
  DataPosition,
  DataTradeActivity,
  EventQueryParams,
  GammaEvent,
  GammaMarket,
  GammaSearchResult,
  MarketQueryParams,
  PlaceOrderParams
} from './polymarketTypes';

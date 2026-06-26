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
  getPreferredScrollStablecoin,
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
// Constants and Magic Numbers
export {
  BRIDGE_FEE_BUFFER,
  CLOB_FEE_RESERVE,
  CTF_ADDRESS,
  CTF_EXCHANGE_ADDRESS,
  FOK_SLIPPAGE_TOLERANCE,
  MIN_BRIDGE_AMOUNT_USD,
  NEG_RISK_ADAPTER_ADDRESS,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  POLYMARKET_MAX_PRICE,
  POLYMARKET_MIN_PRICE,
  PUSD_ADDRESS
} from './polymarketConstants';
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
  searchEvents
} from './polymarketMarketService';
// API authentication adapter
export { registerPolymarketApiAdapter } from './polymarketProxyHelper';
export type { PurchaseParams } from './polymarketPurchaseService';
// Purchase (unified flow)
export { executePurchase, withdrawSellProceeds } from './polymarketPurchaseService';
// Relayer (gasless on-chain operations)
export {
  createRelayClient,
  deploySafeWallet,
  deriveSafeAddress,
  ensureTokenApprovals,
  setupGaslessTrading
} from './polymarketRelayerService';
// Trading
export {
  cancelAllOrders,
  cancelOrder,
  getClosedPositions,
  getOpenOrders,
  getPnlHistory,
  getPolymarketBalanceSummary,
  getPortfolioValue,
  getPositions,
  getTradeHistory,
  getTradesHistory,
  placeOrder,
  resolveMaxSize,
  syncOpenOrders
} from './polymarketTradingService';

// Types
export type {
  ClobMarketInfo,
  ClobOpenOrder,
  ClobOrderBook,
  ClobOrderResponse,
  DataPosition,
  DataTrade,
  DataTradeActivity,
  EventQueryParams,
  GammaEvent,
  GammaMarket,
  GammaSearchResult,
  MarketQueryParams,
  PlaceOrderParams,
  PnlHistoryPoint,
  TradeHistoryQuery
} from './polymarketTypes';

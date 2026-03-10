/**
 * Polymarket Controller Types
 *
 * Request/response type definitions for the Polymarket API endpoints.
 * These types are consumed by the controller layer.
 *
 * @see https://docs.polymarket.com
 */

// ============================================================================
// Common
// ============================================================================

export type PolymarketOrderSide = 'BUY' | 'SELL';
export type PolymarketOrderType = 'GTC' | 'FOK' | 'GTD';

// ============================================================================
// Request Bodies
// ============================================================================

/** Body for account status / create / accept terms */
export interface PolymarketAccountBody {
  channel_user_id: string;
}

/** Body for accepting terms */
export interface PolymarketAcceptTermsBody {
  channel_user_id: string;
  terms_version: number;
}

/** Body for placing an order */
export interface PolymarketPlaceOrderBody {
  channel_user_id: string;
  token_id: string;
  price: number;
  size: number;
  side: PolymarketOrderSide;
  order_type?: PolymarketOrderType;
}

/** Body for cancelling a specific order */
export interface PolymarketCancelOrderBody {
  channel_user_id: string;
  order_id: string;
}

/** Body for cancelling all orders */
export interface PolymarketCancelAllOrdersBody {
  channel_user_id: string;
}

/** Body for fetching positions / orders / history / portfolio */
export interface PolymarketUserDataBody {
  channel_user_id: string;
}

/** Body for bridge operations */
export interface PolymarketBridgeBody {
  channel_user_id: string;
  amount: string;
  token?: string;
}

/** Body for unified purchase flow */
export interface PolymarketPurchaseBody {
  channel_user_id: string;
  token_id: string;
  price: number;
  size: number;
  side: PolymarketOrderSide;
  order_type?: PolymarketOrderType;
  bridge_amount: string;
  terms_version?: number;
}

/** Body for checking purchase status */
export interface PolymarketPurchaseStatusBody {
  channel_user_id: string;
  purchase_id: string;
}

// ============================================================================
// Query Parameters
// ============================================================================

/** Query params for listing markets */
export interface PolymarketMarketsQuery {
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
  category?: string;
  order?: string;
  ascending?: boolean;
  filter_zero_volume?: boolean;
}

/** Query params for listing events */
export interface PolymarketEventsQuery {
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
  category?: string;
  slug?: string;
  order?: string;
  ascending?: boolean;
  filter_zero_volume?: boolean;
}

/** Query params for searching markets */
export interface PolymarketSearchQuery {
  query: string;
  limit?: number;
}

/** Query params for market detail */
export interface PolymarketSlugParams {
  slug: string;
}

/** Common query for bot delay */
export interface PolymarketCommonQuery {
  lastBotMsgDelaySeconds?: number;
}

// ============================================================================
// Response Types (for frontend / chatbot consumption)
// ============================================================================

/** Simplified market summary for list views */
export interface PolymarketMarketSummary {
  condition_id: string;
  question: string;
  slug: string;
  category: string;
  end_date: string;
  image: string;
  outcomes: string[];
  outcome_prices: string[];
  volume: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
}

/** Market detail with order book data */
export interface PolymarketMarketDetail extends PolymarketMarketSummary {
  description: string;
  clob_token_ids: string[];
  best_bid: number;
  best_ask: number;
  spread: number;
  minimum_tick_size: string;
  neg_risk: boolean;
}

/** Category summary */
export interface PolymarketCategory {
  id: string;
  label: string;
  slug: string;
  parentCategory?: string;
}

/** Event summary */
export interface PolymarketEventSummary {
  id: string;
  title: string;
  slug: string;
  description: string;
  category: string;
  start_date: string;
  end_date: string;
  image: string;
  markets: PolymarketMarketSummary[];
  volume: number;
  liquidity: number;
  active: boolean;
}

/** User's Polymarket account status */
export interface PolymarketAccountStatus {
  has_account: boolean;
  polygon_address: string | null;
  terms_accepted: boolean;
  terms_current_version: number;
  terms_accepted_version: number | null;
}

/** Order placement result */
export interface PolymarketOrderResult {
  order_id: string;
  status: string;
  market_slug?: string;
}

/** Position info */
export interface PolymarketPosition {
  condition_id: string;
  market_slug?: string;
  question?: string;
  outcome: string;
  size: number;
  avg_price: number;
  current_price: number;
  pnl: number;
}

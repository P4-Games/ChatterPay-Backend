/**
 * Polymarket Internal Service Types
 *
 * Type definitions for the Polymarket service layer.
 * These types map to the Polymarket Gamma, CLOB, and Data API responses.
 *
 * @see https://docs.polymarket.com
 */

// ============================================================================
// Gamma API Types (Market Data)
// ============================================================================

/** Gamma API market response */
export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  category: string;
  endDate: string;
  image: string;
  icon: string;
  description: string;
  outcomes: string;
  outcomePrices: string;
  volume: string;
  liquidity: string;
  active: boolean;
  closed: boolean;
  marketType: string;
  clobTokenIds: string;
  volume24hr?: string | number;
  volumeNum: number;
  liquidityNum: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  lastTradePrice: number;
  oneDayPriceChange: number;
  negRiskOther: boolean;
}

/** Gamma API event response */
export interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  category: string;
  startDate: string;
  endDate: string;
  image: string;
  icon: string;
  active: boolean;
  volume: number;
  liquidity: number;
  markets?: GammaMarket[];
  enableNegRisk: boolean;
  commentCount: number;
  volume24hr?: string | number;
}

/** Gamma API category response */
export interface GammaCategory {
  id: string;
  name: string;
  count: number;
}

/** Gamma API search result */
export interface GammaSearchResult {
  id: string;
  question: string;
  slug: string;
  image: string;
  outcomePrices: string;
  volume: string;
  active: boolean;
}

// ============================================================================
// CLOB API Types (Trading)
// ============================================================================

/** CLOB market info */
export interface ClobMarketInfo {
  condition_id: string;
  question_id: string;
  tokens: ClobToken[];
  minimum_order_size: number;
  minimum_tick_size: number;
  description: string;
  category: string;
  end_date_iso: string;
  game_start_time: string;
  question: string;
  market_slug: string;
  min_incentive_size: number;
  max_incentive_spread: number;
  active: boolean;
  closed: boolean;
  seconds_delay: number;
  icon: string;
  fpmm: string;
  neg_risk: boolean;
}

/** CLOB token within a market */
export interface ClobToken {
  token_id: string;
  outcome: string;
  price: number;
  winner: boolean;
}

/** CLOB order book */
export interface ClobOrderBook {
  market: string;
  asset_id: string;
  hash: string;
  timestamp: string;
  bids: ClobOrderBookEntry[];
  asks: ClobOrderBookEntry[];
}

export interface ClobOrderBookEntry {
  price: string;
  size: string;
}

/** CLOB price response */
export interface ClobPriceResponse {
  price: string;
}

/** CLOB order response */
export interface ClobOrderResponse {
  orderID: string;
  status: string;
  transactHash?: string;
}

/** CLOB open order */
export interface ClobOpenOrder {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  original_size: string;
  size_matched: string;
  price: string;
  status: string;
  outcome: string;
  owner: string;
  created_at: number;
  expiration: number;
  type: string;
  associate_trades: string[];
}

/** API credentials from CLOB auth */
export interface ClobApiCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

// ============================================================================
// Data API Types (Positions, Trades)
// ============================================================================

/** Data API position */
export interface DataPosition {
  asset: string;
  conditionId: string;
  curPrice: number;
  currentValue: number;
  initialValue: number;
  cashPnl: number;
  percentPnl: number;
  proxyWalletAddress: string;
  size: number;
  avgPrice: number;
  outcome: string;
  market: DataMarketInfo;
}

/** Minimal market info embedded in Data API responses */
export interface DataMarketInfo {
  conditionId: string;
  slug: string;
  question: string;
  image: string;
  endDate: string;
}

/** Data API trade activity */
export interface DataTradeActivity {
  id: string;
  conditionId: string;
  asset: string;
  side: 'BUY' | 'SELL';
  price: string;
  size: string;
  timestamp: string;
  outcome: string;
  market: DataMarketInfo;
  transactionHash: string;
}

/** Data API portfolio value */
export interface DataPortfolioValue {
  totalValue: number;
  totalInvested: number;
  totalPnl: number;
  positions: DataPosition[];
}

// ============================================================================
// Internal Service Types
// ============================================================================

/** Market list query parameters for Gamma API */
export interface MarketQueryParams {
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
  category?: string;
  order?: string;
  ascending?: boolean;
  filterZeroVolume?: boolean;
}

/** Event list query parameters for Gamma API */
export interface EventQueryParams {
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
  category?: string;
  slug?: string;
  order?: string;
  ascending?: boolean;
  filterZeroVolume?: boolean;
}

/** Internal order placement params */
export interface PlaceOrderParams {
  tokenId: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  orderType?: 'GTC' | 'FOK' | 'GTD';
}

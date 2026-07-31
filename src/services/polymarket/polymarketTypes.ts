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
  /**
   * Full resolution rules for the market (e.g. sports markets: "This market
   * refers only to the outcome within the first 90 minutes of regular play
   * plus stoppage time."). This is the text to surface as the market's
   * conditions in the UI.
   */
  description: string;
  /**
   * Short outcome label within the parent event's group (e.g. "England",
   * "Argentina", "Draw (England vs. Argentina)"). Cleaner than `question`
   * for rendering event sub-markets.
   */
  groupItemTitle?: string;
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

/**
 * Team metadata attached to Gamma sports events. `logo` is the team flag/crest
 * Polymarket's own UI composes for the event thumbnail — the event-level
 * `image`/`icon` on sports events is just the generic sport image (e.g. a
 * soccer ball), so UIs should prefer these logos when present.
 */
export interface GammaEventTeam {
  id: number;
  name: string;
  league: string;
  record: string;
  logo: string;
  abbreviation: string;
  /** Team accent color (hex) */
  color: string;
  /** Side within the fixture: 'home' | 'away' */
  ordering: string;
}

/** Sport metadata on Gamma sports events (source of the generic event image) */
export interface GammaEventSport {
  id: number;
  sport: string;
  image: string;
  resolution: string;
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
  /** Present on sports events — team names, flags/crests, colors */
  teams?: GammaEventTeam[];
  /** Present on sports events */
  sport?: GammaEventSport;
  /**
   * Gamma hint: when false (sports events), per-market images are generic
   * placeholders and should not be rendered — use `teams[].logo` instead.
   */
  showMarketImages?: boolean;
  /** Fixture date (YYYY-MM-DD), sports events only */
  eventDate?: string;
  /** Fixture kickoff time (ISO), sports events only */
  startTime?: string;
  /** Slug of the series the event belongs to (e.g. 'soccer-fifwc') */
  seriesSlug?: string;
}

/** Gamma API category response */
export interface GammaCategory {
  id: string;
  label: string;
  slug: string;
  parentCategory?: string;
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
  /** Total USDC spent acquiring this position (cost basis). */
  totalBought?: number;
  /** UNREALIZED P&L on tokens still held. Drops to 0 once a position is fully exited. */
  cashPnl: number;
  percentPnl: number;
  /** REALIZED P&L from the portion already sold or redeemed. Holds the profit of a
   *  redeemed winner, where cashPnl is 0 because no tokens remain. */
  realizedPnl?: number;
  percentRealizedPnl?: number;
  proxyWalletAddress: string;
  size: number;
  avgPrice: number;
  outcome: string;
  market: DataMarketInfo;
  /**
   * Set by the Data API once the market has resolved on-chain — true for both
   * winning positions (curPrice ≈ 1, claimable) and losing ones (curPrice ≈ 0).
   * Open markets always report false. Used to split resolved-lost positions out
   * of the active list and into closed.
   */
  redeemable?: boolean;
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

/** Data API trade (from /trades endpoint) */
export interface DataTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: string;
  price: string;
  /** UNIX epoch in SECONDS (not milliseconds) */
  timestamp: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  transactionHash: string;
}

/** Time range accepted by the user-pnl API */
export type PnlInterval = '1d' | '1w' | '1m' | 'all';

/** Raw point returned by the user-pnl API: t = epoch seconds, p = P&L in USD */
export interface UserPnlApiPoint {
  t: number;
  p: number;
}

/** A single point in the PNL history time series */
export interface PnlHistoryPoint {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Mark-to-market P&L in USD (realized + unrealized) */
  cumulativePnl: number;
  totalInvested?: number;
  totalProceeds?: number;
}

/** Query parameters for the /trades endpoint */
export interface TradeHistoryQuery {
  market?: string;
  limit?: number;
  offset?: number;
  side?: 'BUY' | 'SELL';
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
  /**
   * Available collateral in human USD (on-chain balance minus funds committed to
   * in-flight orders). When set, it caps the balance passed to the CLOB SDK so the
   * order amount is auto-reduced to cover the CLOB fee estimate.
   */
  availableUsdc?: number;
}

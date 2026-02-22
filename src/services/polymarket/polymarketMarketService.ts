/**
 * Polymarket Market Service
 *
 * Read-only market data operations via Gamma API and CLOB API.
 * No authentication required. Responses are cached with node-cache.
 *
 * @see https://docs.polymarket.com/market-data/overview
 */

import axios from 'axios';
import NodeCache from 'node-cache';

import {
  CACHE_POLYMARKET_MARKETS_CHECK_PERIOD,
  CACHE_POLYMARKET_MARKETS_TTL,
  CACHE_POLYMARKET_PRICES_CHECK_PERIOD,
  CACHE_POLYMARKET_PRICES_TTL,
  POLYMARKET_GAMMA_API_URL
} from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import { createPublicClobClient } from './polymarketClientService';
import type {
  ClobOrderBook,
  EventQueryParams,
  GammaEvent,
  GammaMarket,
  GammaSearchResult,
  MarketQueryParams
} from './polymarketTypes';

const LOG_PREFIX = 'polymarketMarketService';

// ============================================================================
// Cache
// ============================================================================

const marketsCache = new NodeCache({
  stdTTL: CACHE_POLYMARKET_MARKETS_TTL,
  checkperiod: CACHE_POLYMARKET_MARKETS_CHECK_PERIOD
});

const pricesCache = new NodeCache({
  stdTTL: CACHE_POLYMARKET_PRICES_TTL,
  checkperiod: CACHE_POLYMARKET_PRICES_CHECK_PERIOD
});

// ============================================================================
// Gamma API — Markets
// ============================================================================

/**
 * Fetch markets from Gamma API with optional filtering.
 *
 * @param params - Query parameters for filtering
 * @param logKey - Logging identifier
 * @returns Array of Gamma market objects
 */
export async function getMarkets(
  params: MarketQueryParams,
  logKey: string
): Promise<GammaMarket[]> {
  const cacheKey = `markets:${JSON.stringify(params)}`;
  const cached = marketsCache.get<GammaMarket[]>(cacheKey);
  if (cached) {
    Logger.log('debug', `[${LOG_PREFIX}:getMarkets]`, `${logKey} Cache hit for markets`);
    return cached;
  }

  try {
    const queryParams: Record<string, string | number | boolean> = {
      limit: params.limit ?? 20,
      offset: params.offset ?? 0
    };

    if (params.active !== undefined) queryParams.active = params.active;
    if (params.closed !== undefined) queryParams.closed = params.closed;
    if (params.category) queryParams.category = params.category;
    if (params.order) queryParams.order = params.order;

    // Filter for CLOB-enabled markets only
    queryParams.enableOrderBook = true;

    const response = await axios.get<GammaMarket[]>(`${POLYMARKET_GAMMA_API_URL}/markets`, {
      params: queryParams,
      timeout: 10000
    });

    marketsCache.set(cacheKey, response.data);
    return response.data;
  } catch (error) {
    Logger.log('error', `[${LOG_PREFIX}:getMarkets]`, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch Polymarket markets: ${String(error)}`);
  }
}

/**
 * Fetch a single market by slug.
 */
export async function getMarketBySlug(slug: string, logKey: string): Promise<GammaMarket | null> {
  const cacheKey = `market:${slug}`;
  const cached = marketsCache.get<GammaMarket[]>(cacheKey);
  if (cached?.[0]) return cached[0];

  try {
    const response = await axios.get<GammaMarket[]>(`${POLYMARKET_GAMMA_API_URL}/markets`, {
      params: { slug },
      timeout: 10000
    });

    if (response.data.length > 0) {
      marketsCache.set(cacheKey, response.data);
      return response.data[0];
    }

    return null;
  } catch (error) {
    Logger.log('error', `[${LOG_PREFIX}:getMarketBySlug]`, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch market by slug: ${String(error)}`);
  }
}

// ============================================================================
// Gamma API — Events
// ============================================================================

/**
 * Fetch events from Gamma API with optional filtering.
 */
export async function getEvents(params: EventQueryParams, logKey: string): Promise<GammaEvent[]> {
  const cacheKey = `events:${JSON.stringify(params)}`;
  const cached = marketsCache.get<GammaEvent[]>(cacheKey);
  if (cached) return cached;

  try {
    const queryParams: Record<string, string | number | boolean> = {
      limit: params.limit ?? 20,
      offset: params.offset ?? 0
    };

    if (params.active !== undefined) queryParams.active = params.active;
    if (params.closed !== undefined) queryParams.closed = params.closed;
    if (params.slug) queryParams.slug = params.slug;

    const response = await axios.get<GammaEvent[]>(`${POLYMARKET_GAMMA_API_URL}/events`, {
      params: queryParams,
      timeout: 10000
    });

    marketsCache.set(cacheKey, response.data);
    return response.data;
  } catch (error) {
    Logger.log('error', `[${LOG_PREFIX}:getEvents]`, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch Polymarket events: ${String(error)}`);
  }
}

/**
 * Fetch a single event by slug.
 */
export async function getEventBySlug(slug: string, logKey: string): Promise<GammaEvent | null> {
  const cacheKey = `event:${slug}`;
  const cached = marketsCache.get<GammaEvent[]>(cacheKey);
  if (cached?.[0]) return cached[0];

  try {
    const response = await axios.get<GammaEvent[]>(`${POLYMARKET_GAMMA_API_URL}/events`, {
      params: { slug },
      timeout: 10000
    });

    if (response.data.length > 0) {
      marketsCache.set(cacheKey, response.data);
      return response.data[0];
    }

    return null;
  } catch (error) {
    Logger.log('error', `[${LOG_PREFIX}:getEventBySlug]`, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch event by slug: ${String(error)}`);
  }
}

// ============================================================================
// Gamma API — Search
// ============================================================================

/**
 * Search markets using Gamma's public search endpoint.
 */
export async function searchMarkets(
  query: string,
  limit: number = 10,
  logKey: string
): Promise<GammaSearchResult[]> {
  try {
    const response = await axios.get<GammaSearchResult[]>(
      `${POLYMARKET_GAMMA_API_URL}/public-search`,
      {
        params: { query, limit },
        timeout: 10000
      }
    );

    return response.data;
  } catch (error) {
    Logger.log('error', `[${LOG_PREFIX}:searchMarkets]`, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to search Polymarket: ${String(error)}`);
  }
}

// ============================================================================
// CLOB API — Prices & Order Book
// ============================================================================

/**
 * Get the current price for a token.
 */
export async function getMarketPrice(tokenId: string, logKey: string): Promise<number> {
  const cacheKey = `price:${tokenId}`;
  const cached = pricesCache.get<number>(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const client = createPublicClobClient();
    const price = await client.getPrice(tokenId, 'buy');
    const numPrice = Number(price);

    pricesCache.set(cacheKey, numPrice);
    return numPrice;
  } catch (error) {
    Logger.log('error', `[${LOG_PREFIX}:getMarketPrice]`, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch market price: ${String(error)}`);
  }
}

/**
 * Get the order book for a token.
 */
export async function getOrderBook(tokenId: string, logKey: string): Promise<ClobOrderBook> {
  try {
    const client = createPublicClobClient();
    const book = await client.getOrderBook(tokenId);

    return book as unknown as ClobOrderBook;
  } catch (error) {
    Logger.log('error', `[${LOG_PREFIX}:getOrderBook]`, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch order book: ${String(error)}`);
  }
}

/**
 * Get the CLOB market info for a condition ID.
 * Includes tick size, neg_risk, and other trading parameters.
 */
export async function getClobMarketInfo(
  conditionId: string,
  logKey: string
): Promise<Record<string, unknown>> {
  const cacheKey = `clobMarket:${conditionId}`;
  const cached = marketsCache.get<Record<string, unknown>>(cacheKey);
  if (cached) return cached;

  try {
    const client = createPublicClobClient();
    const market = await client.getMarket(conditionId);

    marketsCache.set(cacheKey, market as Record<string, unknown>);
    return market as Record<string, unknown>;
  } catch (error) {
    Logger.log('error', `[${LOG_PREFIX}:getClobMarketInfo]`, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch CLOB market info: ${String(error)}`);
  }
}

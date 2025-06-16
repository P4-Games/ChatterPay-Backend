import NodeCache from 'node-cache';

import { CacheNames } from '../../types/commonType';
import {
  CACHE_ABI_TTL,
  CACHE_TOR_TTL,
  CACHE_PRICE_TTL,
  CACHE_OPENSEA_TTL,
  CACHE_COINGECKO_TTL,
  CACHE_ABI_CHECK_PERIOD,
  CACHE_NOTIFICATION_TTL,
  CACHE_TOR_CHECK_PERIOD,
  CACHE_PRICE_CHECK_PERIOD,
  CACHE_OPENSEA_CHECK_PERIOD,
  CACHE_COINGECKO_CHECK_PERIOD,
  CACHE_NOTIFICATION_CHECK_PERIOD
} from '../../config/constants';

/**
 * TTL and checkperiod configurations (in seconds).
 */
const TTL_CONFIG = {
  [CacheNames.OPENSEA]: { stdTTL: CACHE_OPENSEA_TTL, checkperiod: CACHE_OPENSEA_CHECK_PERIOD },
  [CacheNames.PRICE]: { stdTTL: CACHE_PRICE_TTL, checkperiod: CACHE_PRICE_CHECK_PERIOD },
  [CacheNames.ABI]: { stdTTL: CACHE_ABI_TTL, checkperiod: CACHE_ABI_CHECK_PERIOD },
  [CacheNames.NOTIFICATION]: {
    stdTTL: CACHE_NOTIFICATION_TTL,
    checkperiod: CACHE_NOTIFICATION_CHECK_PERIOD
  },
  [CacheNames.TOR]: { stdTTL: CACHE_TOR_TTL, checkperiod: CACHE_TOR_CHECK_PERIOD },
  [CacheNames.COINGECKO]: { stdTTL: CACHE_COINGECKO_TTL, checkperiod: CACHE_COINGECKO_CHECK_PERIOD }
};

/**
 * Initialize NodeCache instances per cache category.
 */
const caches: Record<CacheNames, NodeCache> = {
  [CacheNames.OPENSEA]: new NodeCache(TTL_CONFIG[CacheNames.OPENSEA]),
  [CacheNames.PRICE]: new NodeCache(TTL_CONFIG[CacheNames.PRICE]),
  [CacheNames.ABI]: new NodeCache(TTL_CONFIG[CacheNames.ABI]),
  [CacheNames.NOTIFICATION]: new NodeCache(TTL_CONFIG[CacheNames.NOTIFICATION]),
  [CacheNames.TOR]: new NodeCache(TTL_CONFIG[CacheNames.TOR]),
  [CacheNames.COINGECKO]: new NodeCache(TTL_CONFIG[CacheNames.COINGECKO])
};

/**
 * Centralized cache service for getting/setting/clearing data across all cache types.
 */
export const cacheService = {
  get: <T>(cacheName: CacheNames, key: string): T | undefined => caches[cacheName]?.get<T>(key),

  set: <T>(cacheName: CacheNames, key: string, value: T, ttl?: number): void => {
    if (ttl !== undefined) {
      caches[cacheName].set<T>(key, value, ttl);
    } else {
      caches[cacheName].set<T>(key, value);
    }
  },

  remove: (cacheName: CacheNames, key: string): void => {
    caches[cacheName]?.del(key);
  },

  has: (cacheName: CacheNames, key: string): boolean => caches[cacheName]?.has(key) ?? false,

  keys: (cacheName: CacheNames): string[] => caches[cacheName]?.keys() ?? [],

  clearCache: (cacheName: CacheNames): void => {
    caches[cacheName]?.flushAll();
  },

  clearAllCaches: (): void => {
    Object.values(caches).forEach((cache) => cache.flushAll());
  },

  isValidCacheName: (name: string): name is CacheNames =>
    Object.values(CacheNames).includes(name as CacheNames)
};

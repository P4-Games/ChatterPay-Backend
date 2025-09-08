// cacheService.ts
import NodeCache from 'node-cache';

import { CacheNames } from '../../types/commonType';
import { Logger } from '../../helpers/loggerHelper';
import {
  CACHE_ABI_TTL,
  CACHE_TOR_TTL,
  CACHE_PRICE_TTL,
  CACHE_OPENSEA_TTL,
  CACHE_COINGECKO_TTL,
  CACHE_ERC20_DATA_TTL,
  CACHE_ABI_CHECK_PERIOD,
  CACHE_NOTIFICATION_TTL,
  CACHE_TOR_CHECK_PERIOD,
  CACHE_PRICE_CHECK_PERIOD,
  CACHE_OPENSEA_CHECK_PERIOD,
  CACHE_COINGECKO_CHECK_PERIOD,
  CACHE_ERC20_DATA_CHECK_PERIOD,
  CACHE_NOTIFICATION_CHECK_PERIOD
} from '../../config/constants';

/** TTL and checkperiod (seconds) */
const TTL_CONFIG = {
  [CacheNames.OPENSEA]: { stdTTL: CACHE_OPENSEA_TTL, checkperiod: CACHE_OPENSEA_CHECK_PERIOD },
  [CacheNames.PRICE]: { stdTTL: CACHE_PRICE_TTL, checkperiod: CACHE_PRICE_CHECK_PERIOD },
  [CacheNames.ABI]: { stdTTL: CACHE_ABI_TTL, checkperiod: CACHE_ABI_CHECK_PERIOD },
  [CacheNames.NOTIFICATION]: {
    stdTTL: CACHE_NOTIFICATION_TTL,
    checkperiod: CACHE_NOTIFICATION_CHECK_PERIOD
  },
  [CacheNames.TOR]: { stdTTL: CACHE_TOR_TTL, checkperiod: CACHE_TOR_CHECK_PERIOD },
  [CacheNames.COINGECKO]: {
    stdTTL: CACHE_COINGECKO_TTL,
    checkperiod: CACHE_COINGECKO_CHECK_PERIOD
  },
  [CacheNames.ERC20]: { stdTTL: CACHE_ERC20_DATA_TTL, checkperiod: CACHE_ERC20_DATA_CHECK_PERIOD }
};

const caches: Record<CacheNames, NodeCache> = {
  [CacheNames.OPENSEA]: new NodeCache(TTL_CONFIG[CacheNames.OPENSEA]),
  [CacheNames.PRICE]: new NodeCache(TTL_CONFIG[CacheNames.PRICE]),
  [CacheNames.ABI]: new NodeCache(TTL_CONFIG[CacheNames.ABI]),
  [CacheNames.NOTIFICATION]: new NodeCache(TTL_CONFIG[CacheNames.NOTIFICATION]),
  [CacheNames.TOR]: new NodeCache(TTL_CONFIG[CacheNames.TOR]),
  [CacheNames.COINGECKO]: new NodeCache(TTL_CONFIG[CacheNames.COINGECKO]),
  [CacheNames.ERC20]: new NodeCache(TTL_CONFIG[CacheNames.ERC20])
};

// De-duplication of concurrent loads (global, cross-cache)
const inflightGlobal = new Map<string, Promise<unknown>>();

const inflightKey = (cacheName: CacheNames, key: string) => `${cacheName}:${key}`;

// --- Overloads ---
function cacheGet<T>(cacheName: CacheNames, key: string): T | undefined;

function cacheGet<T>(
  cacheName: CacheNames,
  key: string,
  loader: () => Promise<T>,
  ttl?: number
): Promise<T>;

// --- Single implementation ---
function cacheGet(
  cacheName: CacheNames,
  key: string,
  loader?: () => Promise<unknown>,
  ttl?: number
): unknown {
  // Mode 1: sync (legacy-compatible)
  if (!loader) {
    return caches[cacheName].get(key);
  }

  // Mode 2: async with loader + dedupe
  const hit = caches[cacheName].get(key);
  if (hit !== undefined) {
    Logger.log('cacheService:get', `CACHE HIT key=${key} [${cacheName}]`);
    return Promise.resolve(hit);
  }

  const ikey = inflightKey(cacheName, key);
  const existing = inflightGlobal.get(ikey);
  if (existing) {
    Logger.log('cacheService:get', `INFLIGHT HIT key=${key} [${cacheName}]`);
    return existing;
  }

  Logger.log('cacheService:get', `CACHE MISS key=${key} [${cacheName}] — loading...`);

  const p = (async () => {
    try {
      const value = await loader();
      if (ttl !== undefined) {
        caches[cacheName].set(key, value, ttl);
      } else {
        caches[cacheName].set(key, value);
      }
      return value;
    } finally {
      inflightGlobal.delete(ikey);
    }
  })();

  inflightGlobal.set(ikey, p);
  return p;
}

export const cacheService = {
  // unified get (sync or async with loader)
  get: cacheGet,

  set: <T>(cacheName: CacheNames, key: string, value: T, ttl?: number): void => {
    if (ttl !== undefined) caches[cacheName].set<T>(key, value, ttl);
    else caches[cacheName].set<T>(key, value);
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
    Object.values(CacheNames).includes(name as CacheNames),

  /**
   * Get from cache; if missing, dedupe concurrent loads using a shared Promise.
   */
  async getOrLoad<T>(
    cacheName: CacheNames,
    key: string,
    loader: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    // 1) L2 NodeCache
    const cached = caches[cacheName].get<T>(key);
    if (cached !== undefined) {
      // Log mínimo, como pediste
      Logger.log('cacheService:getOrLoad', `CACHE HIT key=${key} [${cacheName}]`);
      return cached;
    }

    // 2) In-flight dedup
    const ikey = inflightKey(cacheName, key);
    const existing = inflightGlobal.get(ikey) as Promise<T> | undefined;
    if (existing) {
      Logger.log('cacheService:getOrLoad', `INFLIGHT HIT key=${key} [${cacheName}]`);
      return existing;
    }

    Logger.log('cacheService:getOrLoad', `CACHE MISS key=${key} [${cacheName}] — loading...`);

    const p = (async () => {
      try {
        const value = await loader();
        if (ttl !== undefined) {
          caches[cacheName].set<T>(key, value, ttl);
        } else {
          caches[cacheName].set<T>(key, value);
        }
        return value;
      } finally {
        inflightGlobal.delete(ikey);
      }
    })();

    inflightGlobal.set(ikey, p);
    return p;
  }
};

/**
 * Tests for polymarketProxyHelper
 *
 * Covers:
 *  1. resolveRequestUrl  – pure URL resolution logic
 *  2. targetsProxiedHost – pure host-matching logic
 *  3. registerPolymarketApiAdapter – interceptor registration:
 *     a. Idempotency (registers only once)
 *     b. No-op when token is absent
 *     c. Authorization header injected for Polymarket hosts
 *     d. Authorization header NOT injected for unrelated hosts
 */

import axios, { type InternalAxiosRequestConfig } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mock (applied before any import of the module under test)
// ---------------------------------------------------------------------------
vi.mock('../../../src/config/constants', () => ({
  POLYMARKET_ADAPTER_TOKEN: 'test-adapter-token',
  POLYMARKET_CLOB_API_URL: 'https://clob.polymarket.com',
  POLYMARKET_GAMMA_API_URL: 'https://gamma-api.polymarket.com',
  POLYMARKET_DATA_API_URL: 'https://data-api.polymarket.com'
}));

vi.mock('../../../src/helpers/loggerHelper', () => ({
  Logger: { log: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}));

import {
  _resetAdapterForTesting,
  registerPolymarketApiAdapter,
  resolveRequestUrl,
  targetsProxiedHost
} from '../../../src/services/polymarket/polymarketProxyHelper';

// ---------------------------------------------------------------------------
// Helper – fire a GET through axios interceptors without a real network call.
// Returns the request headers as seen by the mock adapter after all request
// interceptors have run.
// ---------------------------------------------------------------------------
async function fireAndCapture(
  mock: MockAdapter,
  url: string,
  opts: { baseURL?: string } = {}
): Promise<Record<string, string | undefined>> {
  let captured: Record<string, string | undefined> = {};

  mock.onGet(url).reply((config) => {
    captured = (config.headers ?? {}) as Record<string, string | undefined>;
    return [200, {}];
  });

  try {
    if (opts.baseURL) {
      await axios.get(url, { baseURL: opts.baseURL });
    } else {
      await axios.get(url);
    }
  } catch {
    // Ignore network-layer errors; we only care about captured headers
  }

  return captured;
}

// ---------------------------------------------------------------------------
// 1. resolveRequestUrl
// ---------------------------------------------------------------------------
describe('resolveRequestUrl', () => {
  it('returns url as-is when it is already absolute', () => {
    const config = { url: 'https://clob.polymarket.com/orders' } as InternalAxiosRequestConfig;
    expect(resolveRequestUrl(config)).toBe('https://clob.polymarket.com/orders');
  });

  it('prepends baseURL when url is a relative path', () => {
    const config = {
      url: '/orders',
      baseURL: 'https://clob.polymarket.com'
    } as InternalAxiosRequestConfig;
    expect(resolveRequestUrl(config)).toBe('https://clob.polymarket.com/orders');
  });

  it('returns empty string when both url and baseURL are absent', () => {
    const config = {} as InternalAxiosRequestConfig;
    expect(resolveRequestUrl(config)).toBe('');
  });

  it('handles http:// URLs as absolute', () => {
    const config = { url: 'http://clob.polymarket.com/orders' } as InternalAxiosRequestConfig;
    expect(resolveRequestUrl(config)).toBe('http://clob.polymarket.com/orders');
  });
});

// ---------------------------------------------------------------------------
// 2. targetsProxiedHost
// ---------------------------------------------------------------------------
describe('targetsProxiedHost', () => {
  it('returns true for the CLOB API base URL', () => {
    expect(targetsProxiedHost('https://clob.polymarket.com/orders')).toBe(true);
  });

  it('returns true for the Gamma API base URL', () => {
    expect(targetsProxiedHost('https://gamma-api.polymarket.com/markets')).toBe(true);
  });

  it('returns true for the Data API base URL', () => {
    expect(targetsProxiedHost('https://data-api.polymarket.com/prices')).toBe(true);
  });

  it('returns false for an unrelated host', () => {
    expect(targetsProxiedHost('https://li.quest/v1/quote')).toBe(false);
  });

  it('returns false when a Polymarket host appears only in the path/query', () => {
    expect(targetsProxiedHost('https://evil.example.com/?to=https://clob.polymarket.com')).toBe(
      false
    );
  });

  it('returns false for an empty string', () => {
    expect(targetsProxiedHost('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. registerPolymarketApiAdapter – integration tests via axios interceptors
// ---------------------------------------------------------------------------
describe('registerPolymarketApiAdapter', () => {
  let mock: MockAdapter;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    // Clear any interceptors left by a previous test and reset the flag
    // @ts-expect-error – accessing internal Axios property for test isolation
    axios.interceptors.request.handlers = [];
    _resetAdapterForTesting();
    mock = new MockAdapter(axios);
  });

  afterEach(() => {
    mock.restore();
    vi.restoreAllMocks();
    process.env.NODE_ENV = originalNodeEnv;
  });

  // ── Idempotency ──────────────────────────────────────────────────────────
  it('registers the interceptor only once even when called multiple times', () => {
    registerPolymarketApiAdapter();
    registerPolymarketApiAdapter();
    registerPolymarketApiAdapter();

    // @ts-expect-error – internal property
    const active = (axios.interceptors.request.handlers as unknown[]).filter(Boolean);
    expect(active).toHaveLength(1);
  });

  // ── No-op without token ───────────────────────────────────────────────────
  it('does not register any interceptor when POLYMARKET_ADAPTER_TOKEN is empty', async () => {
    // Temporarily override the token to empty
    const constants = await import('../../../src/config/constants');
    const original = constants.POLYMARKET_ADAPTER_AUTH_TOKEN;
    (constants as Record<string, unknown>).POLYMARKET_ADAPTER_TOKEN = '';

    registerPolymarketApiAdapter();

    // @ts-expect-error – internal property
    const active = (axios.interceptors.request.handlers as unknown[]).filter(Boolean);
    expect(active).toHaveLength(0);

    // Restore
    (constants as Record<string, unknown>).POLYMARKET_ADAPTER_TOKEN = original;
  });

  // ── Header injection ──────────────────────────────────────────────────────
  it('injects Authorization header for CLOB API requests', async () => {
    registerPolymarketApiAdapter();
    const headers = await fireAndCapture(mock, 'https://clob.polymarket.com/orders');
    expect(headers.Authorization).toBe('Bearer test-adapter-token');
  });

  it('injects Authorization header for Gamma API requests', async () => {
    registerPolymarketApiAdapter();
    const headers = await fireAndCapture(mock, 'https://gamma-api.polymarket.com/markets');
    expect(headers.Authorization).toBe('Bearer test-adapter-token');
  });

  it('injects Authorization header for Data API requests', async () => {
    registerPolymarketApiAdapter();
    const headers = await fireAndCapture(mock, 'https://data-api.polymarket.com/prices');
    expect(headers.Authorization).toBe('Bearer test-adapter-token');
  });

  it('injects Authorization when using baseURL + relative path (SDK pattern)', async () => {
    registerPolymarketApiAdapter();
    const headers = await fireAndCapture(mock, '/orders', {
      baseURL: 'https://clob.polymarket.com'
    });
    expect(headers.Authorization).toBe('Bearer test-adapter-token');
  });

  // ── No injection for unrelated traffic ────────────────────────────────────
  it('does NOT inject Authorization for LiFi requests', async () => {
    registerPolymarketApiAdapter();
    const headers = await fireAndCapture(mock, 'https://li.quest/v1/quote');
    expect(headers.Authorization).toBeUndefined();
  });

  it('does NOT inject Authorization for Alchemy requests', async () => {
    registerPolymarketApiAdapter();
    const headers = await fireAndCapture(mock, 'https://polygon-mainnet.g.alchemy.com/v2/some-key');
    expect(headers.Authorization).toBeUndefined();
  });

  it('does NOT inject Authorization for a URL that embeds a Polymarket host as a segment', async () => {
    registerPolymarketApiAdapter();
    const headers = await fireAndCapture(
      mock,
      'https://evil.example.com/?to=https://clob.polymarket.com'
    );
    expect(headers.Authorization).toBeUndefined();
  });
});

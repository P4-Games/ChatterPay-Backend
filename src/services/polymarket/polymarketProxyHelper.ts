/**
 * Polymarket API Adapter
 *
 * Attaches a bearer token to every outbound request targeting the configured
 * Polymarket base URLs (`POLYMARKET_CLOB_API_URL`, `POLYMARKET_GAMMA_API_URL`,
 * `POLYMARKET_DATA_API_URL`). A single global Axios request handler covers both
 * direct Gamma/Data calls and the CLOB SDK (`@polymarket/clob-client-v2`),
 * since the SDK shares the same hoisted Axios singleton. Only requests whose
 * URL matches a configured Polymarket base URL are touched; unrelated traffic
 * (LiFi, Manteca, Alchemy, The Graph, ...) is never modified. When
 * `POLYMARKET_ADAPTER_TOKEN` is unset the adapter is never registered.
 */

import axios, { type InternalAxiosRequestConfig } from 'axios';

import {
  POLYMARKET_ADAPTER_TOKEN,
  POLYMARKET_CLOB_API_URL,
  POLYMARKET_DATA_API_URL,
  POLYMARKET_GAMMA_API_URL
} from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';

const LOG_PREFIX = 'polymarketAdapterHelper';

let adapterRegistered = false;

/** Polymarket base URLs that require authenticated requests. */
function getProxiedBaseUrls(): string[] {
  return [POLYMARKET_CLOB_API_URL, POLYMARKET_GAMMA_API_URL, POLYMARKET_DATA_API_URL].filter(
    (url): url is string => Boolean(url)
  );
}

/**
 * Resolve the absolute target URL of a request for prefix matching.
 * Exported for unit testing.
 */
export function resolveRequestUrl(config: InternalAxiosRequestConfig): string {
  const url = config.url ?? '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${config.baseURL ?? ''}${url}`;
}

/**
 * True when the request targets one of the configured Polymarket base URLs.
 * Exported for unit testing.
 */
export function targetsProxiedHost(requestUrl: string): boolean {
  return getProxiedBaseUrls().some((base) => requestUrl.startsWith(base));
}

/**
 * Register the global Axios adapter that injects the bearer token
 * into Polymarket-bound requests.
 *
 * Idempotent: safe to call multiple times, registers at most once. No-op when
 * `POLYMARKET_ADAPTER_TOKEN` is empty.
 */
export function registerPolymarketApiAdapter(): void {
  if (adapterRegistered) return;
  // TEMP DIAGNOSTIC: log token length (not value) to confirm runtime injection. Remove after debug.
  Logger.log(
    'warn',
    `[${LOG_PREFIX}:diag]`,
    `POLYMARKET_ADAPTER_TOKEN length=${POLYMARKET_ADAPTER_TOKEN?.length ?? 'undefined'}`
  );
  if (!POLYMARKET_ADAPTER_TOKEN) return;

  axios.interceptors.request.use((config) => {
    const requestUrl = resolveRequestUrl(config);
    if (requestUrl && targetsProxiedHost(requestUrl)) {
      config.headers.set('Authorization', `Bearer ${POLYMARKET_ADAPTER_TOKEN}`);
    }
    return config;
  });

  adapterRegistered = true;
  Logger.log('info', `[${LOG_PREFIX}:register]`, 'Polymarket API adapter registered');
}

/**
 * Reset the adapter registration flag.
 * **For use in tests only** – allows re-registering the adapter in isolated
 * test cases without reloading the module.
 * @internal
 */
export function _resetAdapterForTesting(): void {
  if (process.env.NODE_ENV !== 'test') return;
  adapterRegistered = false;
}

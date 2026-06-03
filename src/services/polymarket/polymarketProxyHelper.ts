/**
 * Polymarket EU Proxy Helper
 *
 * In geo-restricted regions the Polymarket APIs (CLOB, Gamma, Data) are reached
 * through an authenticated EU proxy. In production the proxy URL replaces the
 * upstream URL in the corresponding env vars (`POLYMARKET_CLOB_API_URL`,
 * `POLYMARKET_GAMMA_API_URL`, `POLYMARKET_DATA_API_URL`); this module attaches
 * the proxy bearer token to every outbound request that targets one of those
 * configured base URLs. The proxy validates the token, strips it, and forwards
 * the request upstream transparently.
 *
 * A single global Axios request interceptor covers both the direct Gamma/Data
 * calls and the CLOB SDK (`@polymarket/clob-client-v2`), since the SDK shares
 * the same hoisted Axios singleton. The token is only added to URLs matching a
 * configured Polymarket base URL, so unrelated traffic (LiFi, Manteca, Alchemy,
 * The Graph, ...) is never touched. When `EU_PROXY_TOKEN` is unset the
 * interceptor is never registered, so behaviour is unchanged.
 */

import axios, { type InternalAxiosRequestConfig } from 'axios';

import {
  EU_PROXY_TOKEN,
  POLYMARKET_CLOB_API_URL,
  POLYMARKET_DATA_API_URL,
  POLYMARKET_GAMMA_API_URL
} from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';

const LOG_PREFIX = 'polymarketProxyHelper';

let interceptorRegistered = false;

/** Base URLs routed through the EU proxy (whatever the env vars currently point to). */
function getProxiedBaseUrls(): string[] {
  return [POLYMARKET_CLOB_API_URL, POLYMARKET_GAMMA_API_URL, POLYMARKET_DATA_API_URL].filter(
    (url): url is string => Boolean(url)
  );
}

/** Resolve the absolute target URL of a request for prefix matching. */
function resolveRequestUrl(config: InternalAxiosRequestConfig): string {
  const url = config.url ?? '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${config.baseURL ?? ''}${url}`;
}

/** True when the request targets one of the configured Polymarket base URLs. */
function targetsProxiedHost(requestUrl: string): boolean {
  return getProxiedBaseUrls().some((base) => requestUrl.startsWith(base));
}

/**
 * Register the global Axios interceptor that injects the EU proxy bearer token
 * into Polymarket-bound requests.
 *
 * Idempotent: safe to call multiple times, registers at most once. No-op when
 * `EU_PROXY_TOKEN` is empty, so non-proxied deployments are unaffected.
 */
export function registerPolymarketProxyInterceptor(): void {
  if (interceptorRegistered) return;
  if (!EU_PROXY_TOKEN) return;

  axios.interceptors.request.use((config) => {
    const requestUrl = resolveRequestUrl(config);
    if (requestUrl && targetsProxiedHost(requestUrl)) {
      config.headers.set('Authorization', `Bearer ${EU_PROXY_TOKEN}`);
    }
    return config;
  });

  interceptorRegistered = true;
  Logger.log(
    'info',
    `[${LOG_PREFIX}:register]`,
    'EU proxy interceptor registered for Polymarket requests'
  );
}

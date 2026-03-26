/**
 * Polymarket Trading Service
 *
 * Handles order placement, cancellation, and position queries.
 * All operations require an authenticated CLOB client.
 *
 * @see https://docs.polymarket.com/trading/quickstart
 */

import { AssetType, OrderType, Side } from '@polymarket/clob-client';
import axios from 'axios';
import { ethers } from 'ethers';

import {
  POLYMARKET_DATA_API_URL,
  POLYMARKET_GAMMA_API_URL,
  POLYMARKET_POLYGON_RPC_URL
} from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import { PolymarketOrderModel } from '../../models/polymarketModel';
import type { IUser } from '../../models/userModel';
import { getAuthenticatedClientForUser } from './polymarketClientService';
import { FOK_SLIPPAGE_TOLERANCE, USDC_E_ADDRESS } from './polymarketConstants';
import { ensureTokenApprovals } from './polymarketRelayerService';
import type {
  ClobOpenOrder,
  ClobOrderResponse,
  DataPosition,
  DataTrade,
  DataTradeActivity,
  PlaceOrderParams,
  PnlHistoryPoint,
  TradeHistoryQuery
} from './polymarketTypes';

const LOG_PREFIX = 'polymarketTradingService';


// CLOB error detection patterns — extracted to avoid brittle inline string matching
const CLOB_ERROR_PATTERNS = {
  ALLOWANCE: ['not enough balance', 'allowance'],
  MIN_SIZE: ['lower than the minimum']
} as const;

function matchesClobError(detail: string, patterns: readonly string[]): boolean {
  const lower = detail.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve 'max' size for SELL orders by querying the CLOB conditional token balance.
 * Returns the human-readable share count (e.g. 1.11) for the given token.
 */
export async function resolveMaxSize(
  user: IUser,
  privateKey: string,
  tokenId: string,
  logKey: string
): Promise<number> {
  const fnLog = `[${LOG_PREFIX}:resolveMaxSize]`;
  const client = await getAuthenticatedClientForUser(user, privateKey);

  const conditionalParams = { asset_type: AssetType.CONDITIONAL, token_id: tokenId };
  await client.updateBalanceAllowance(conditionalParams);
  const status = await client.getBalanceAllowance(conditionalParams);
  const rawBalance = Number(status?.balance ?? 0);
  const shares = rawBalance / 1_000_000;

  Logger.log('info', fnLog, `${logKey} Resolved max size: ${shares} shares (raw=${rawBalance})`);

  if (shares <= 0) {
    throw new Error('No shares found for this token. Cannot sell with size=max.');
  }
  return shares;
}

// ============================================================================
// Order Management
// ============================================================================

/**
 * Place an order on Polymarket.
 * Automatically fetches tick size and neg_risk from the market.
 * The CLOB client handles on-chain approvals via the operator/API key system.
 *
 * @param user - User with polymarket_account
 * @param privateKey - User's EOA private key
 * @param params - Order parameters
 * @returns Order response with ID and status
 */
export async function placeOrder(
  user: IUser,
  privateKey: string,
  params: PlaceOrderParams,
  logKey: string
): Promise<ClobOrderResponse> {
  const fnLog = `[${LOG_PREFIX}:placeOrder]`;

  try {
    Logger.log(
      'info',
      fnLog,
      `${logKey} Placing ${params.side} order: ${params.size}@${params.price}`
    );

    const client = await getAuthenticatedClientForUser(user, privateKey);

    // Ensure the CLOB's cached balance/allowance is fresh before placing the order.
    //
    // For CONDITIONAL (SELL), the CLOB API requires the specific token_id
    // because ERC-1155 balances are per-token. Without it the API returns:
    //   "assetId invalid value -1, as this is a erc1155 operation"
    //
    // IMPORTANT: The CLOB's getBalanceAllowance for AssetType.CONDITIONAL
    // returns allowance=0 even when on-chain setApprovalForAll is set.
    // ERC-1155 uses boolean operator approvals (isApprovedForAll), not
    // granular ERC-20-style allowances, so the CLOB's allowance field is
    // unreliable for CONDITIONAL tokens. We only use it for COLLATERAL.
    try {
      const isSell = params.side === 'SELL';

      if (isSell) {
        // SELL: Validate conditional token balance. Don't gate on allowance
        // (always reads 0 for ERC-1155). On-chain approvals are set once
        // during account creation via setupGaslessTrading/ensureTokenApprovals.
        const conditionalParams = { asset_type: AssetType.CONDITIONAL, token_id: params.tokenId };

        Logger.log('info', fnLog, `${logKey} Refreshing CLOB cache for CONDITIONAL + COLLATERAL`);
        const [conditionalResult, collateralResult] = await Promise.allSettled([
          client.updateBalanceAllowance(conditionalParams),
          client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL })
        ]);
        if (conditionalResult.status === 'rejected') {
          throw new Error(`Failed to refresh CONDITIONAL balance: ${String(conditionalResult.reason)}`);
        }
        if (collateralResult.status === 'rejected') {
          Logger.log('warn', fnLog, `${logKey} COLLATERAL refresh failed (non-critical): ${String(collateralResult.reason)}`);
        }

        const allowanceStatus = await client.getBalanceAllowance(conditionalParams);
        const currentBalance = Number(allowanceStatus?.balance ?? 0);

        Logger.log(
          'info',
          fnLog,
          `${logKey} CONDITIONAL balance=${currentBalance} (${currentBalance / 1_000_000} shares)`
        );

        // Validate balance before submitting
        const balanceHuman = currentBalance / 1_000_000;
        if (currentBalance === 0) {
          throw new Error(
            `No shares found for this token in your Polymarket account. ` +
              `Check your positions before selling.`
          );
        }
        if (balanceHuman < params.size) {
          throw new Error(
            `Insufficient shares: you have ${balanceHuman} but trying to sell ${params.size}. ` +
              `Reduce size to ${balanceHuman} or less.`
          );
        }
      } else {
        // BUY: Check COLLATERAL (USDC.e) balance/allowance.
        // ERC-20 allowances ARE reported correctly by the CLOB.
        const collateralParams = { asset_type: AssetType.COLLATERAL };

        Logger.log('info', fnLog, `${logKey} Refreshing CLOB cache for COLLATERAL`);
        await client.updateBalanceAllowance(collateralParams);

        const allowanceStatus = await client.getBalanceAllowance(collateralParams);
        const currentAllowance = Number(allowanceStatus?.allowance ?? 0);
        const currentBalance = Number(allowanceStatus?.balance ?? 0);

        Logger.log(
          'info',
          fnLog,
          `${logKey} COLLATERAL balance=${currentBalance}, allowance=${currentAllowance}`
        );

        if (currentAllowance === 0) {
          Logger.log(
            'info',
            fnLog,
            `${logKey} No COLLATERAL allowance — setting up approvals via Relayer`
          );
          await ensureTokenApprovals(privateKey, logKey);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await client.updateBalanceAllowance(collateralParams);
          Logger.log('info', fnLog, `${logKey} Approvals set and CLOB cache refreshed`);
        } else {
          Logger.log('info', fnLog, `${logKey} COLLATERAL allowance already cached on CLOB`);
        }
      }
    } catch (allowanceError) {
      if (
        String(allowanceError).includes('No shares found') ||
        String(allowanceError).includes('Insufficient shares')
      ) {
        throw allowanceError;
      }
      Logger.log(
        'warn',
        fnLog,
        `${logKey} Allowance check/update failed (non-fatal): ${String(allowanceError)}`
      );
    }

    const side = params.side === 'BUY' ? Side.BUY : Side.SELL;

    const submitOrder = async (): Promise<Record<string, unknown>> => {
      if (params.orderType === 'FOK') {
        // FOK orders use createAndPostMarketOrder (fill-or-kill).
        // SDK UserMarketOrder.amount semantics:
        //   BUY  → dollar amount to spend (price × size)
        //   SELL → number of shares to sell (size)
        //
        // `price` is the worst acceptable price (slippage protection).
        // `amount` stays based on the original price so we don't overspend.
        const amount = params.side === 'BUY' ? params.price * params.size : params.size;
        const slippagePrice =
          params.side === 'BUY'
            ? Math.min(params.price * (1 + FOK_SLIPPAGE_TOLERANCE), 0.999)
            : Math.max(params.price * (1 - FOK_SLIPPAGE_TOLERANCE), 0.001);

        Logger.log(
          'info',
          fnLog,
          `${logKey} FOK order: amount=${amount.toFixed(2)}, ` +
            `price=${params.price} → slippagePrice=${slippagePrice.toFixed(4)}`
        );

        return client.createAndPostMarketOrder({
          tokenID: params.tokenId,
          price: slippagePrice,
          amount,
          side
        });
      }
      // GTC (default) and GTD orders use createAndPostOrder
      const orderType = params.orderType === 'GTD' ? OrderType.GTD : OrderType.GTC;
      return client.createAndPostOrder(
        {
          tokenID: params.tokenId,
          price: params.price,
          size: params.size,
          side
        },
        undefined,
        orderType
      );
    };

    let response = await submitOrder();

    // The CLOB SDK may swallow HTTP errors and return the error body
    // instead of throwing (e.g. {"error": "not enough balance / allowance"}).
    // Detect this and throw so callers get a proper failure.
    if (!response.orderID) {
      const errorDetail = String(response.error || response.message || 'no orderID in response');

      // For SELL orders that fail with allowance errors, retry once after
      // setting fresh approvals. The CLOB cache for ERC-1155 (CONDITIONAL)
      // is unreliable — the on-chain approval may exist but not be cached.
      const isAllowanceError = matchesClobError(errorDetail, CLOB_ERROR_PATTERNS.ALLOWANCE);
      const isMinSizeError = matchesClobError(errorDetail, CLOB_ERROR_PATTERNS.MIN_SIZE);

      if (params.side === 'SELL' && isAllowanceError) {
        Logger.log(
          'warn',
          fnLog,
          `${logKey} SELL rejected (${errorDetail}). Setting fresh approvals and retrying...`
        );
        await ensureTokenApprovals(privateKey, logKey);
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Refresh both asset type caches after approvals
        await Promise.all([
          client.updateBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: params.tokenId
          }),
          client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL })
        ]);

        response = await submitOrder();

        // After retry, check again — might reveal a different error (e.g. min size)
        if (!response.orderID) {
          const retryDetail = String(response.error || response.message || '');

          // If GTC still fails, fall back to FOK market order (works for both
          // balance/allowance and minimum-size errors)
          if (params.orderType !== 'FOK') {
            Logger.log(
              'warn',
              fnLog,
              `${logKey} GTC SELL failed after retry (${retryDetail}). Falling back to FOK market order.`
            );
            response = await client.createAndPostMarketOrder({
              tokenID: params.tokenId,
              price: params.price,
              amount: params.size,
              side
            });
            if (!response.orderID) {
              const fokError = response.error || response.message || 'no orderID in response';
              throw new Error(`CLOB rejected FOK fallback: ${fokError}`);
            }
          } else {
            throw new Error(
              `CLOB rejected order after retry: ${retryDetail || 'no orderID in response'}`
            );
          }
        }
      } else if (params.side === 'SELL' && isMinSizeError && params.orderType !== 'FOK') {
        // GTC SELL rejected for being below minimum order size.
        // Fall back to FOK (market order) which typically has lower minimums.
        Logger.log(
          'warn',
          fnLog,
          `${logKey} GTC SELL below minimum (${errorDetail}). Falling back to FOK market order.`
        );
        response = await client.createAndPostMarketOrder({
          tokenID: params.tokenId,
          price: params.price,
          amount: params.size,
          side
        });
        if (!response.orderID) {
          const fokError = response.error || response.message || 'no orderID in response';
          throw new Error(`CLOB rejected FOK fallback: ${fokError}`);
        }
      } else {
        throw new Error(`CLOB rejected order: ${errorDetail}`);
      }
    }

    Logger.log('info', fnLog, `${logKey} Order placed: ${response.orderID}`);
    return response as unknown as ClobOrderResponse;
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to place order: ${String(error)}`);
  }
}

/**
 * Cancel a specific open order.
 */
export async function cancelOrder(
  user: IUser,
  privateKey: string,
  orderId: string,
  logKey: string
): Promise<void> {
  const fnLog = `[${LOG_PREFIX}:cancelOrder]`;

  try {
    Logger.log('info', fnLog, `${logKey} Cancelling order: ${orderId}`);
    const client = await getAuthenticatedClientForUser(user, privateKey);
    await client.cancelOrder({ orderID: orderId });
    Logger.log('info', fnLog, `${logKey} Order cancelled: ${orderId}`);
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to cancel order: ${String(error)}`);
  }
}

/**
 * Cancel all open orders for the user.
 */
export async function cancelAllOrders(
  user: IUser,
  privateKey: string,
  logKey: string
): Promise<void> {
  const fnLog = `[${LOG_PREFIX}:cancelAllOrders]`;

  try {
    Logger.log('info', fnLog, `${logKey} Cancelling all orders`);
    const client = await getAuthenticatedClientForUser(user, privateKey);
    await client.cancelAll();
    Logger.log('info', fnLog, `${logKey} All orders cancelled`);
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to cancel all orders: ${String(error)}`);
  }
}

/**
 * Get open orders for the user.
 */
export async function getOpenOrders(
  user: IUser,
  privateKey: string,
  logKey: string
): Promise<ClobOpenOrder[]> {
  const fnLog = `[${LOG_PREFIX}:getOpenOrders]`;

  try {
    const client = await getAuthenticatedClientForUser(user, privateKey);
    const orders = await client.getOpenOrders();

    return orders as unknown as ClobOpenOrder[];
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch open orders: ${String(error)}`);
  }
}

// ============================================================================
// Data API — Positions & History
// ============================================================================

import NodeCache from 'node-cache';

const tokenMarketCache = new NodeCache({ stdTTL: 3600, maxKeys: 2000 });

async function enrichWithMarketData(
  tokenId: string,
  logKey: string
): Promise<{ market_title: string; market_slug: string }> {
  const cached = tokenMarketCache.get<{ market_title: string; market_slug: string }>(tokenId);
  if (cached) return cached;

  try {
    const response = await axios.get(`${POLYMARKET_GAMMA_API_URL}/markets`, {
      params: { clobTokenIds: tokenId },
      timeout: 5000
    });

    if (response.data && response.data.length > 0) {
      const market = response.data[0];
      const result = {
        market_title: market.question || market.title || 'Unknown Market',
        market_slug: market.slug || ''
      };
      tokenMarketCache.set(tokenId, result);
      return result;
    }
  } catch (err) {
    Logger.log(
      'warn',
      `[${LOG_PREFIX}:enrichment]`,
      `Failed to enrich token ${tokenId} from Gamma: ${String(err)}`
    );
  }

  // Best-effort local DB fallback
  try {
    const localOrder = await PolymarketOrderModel.findOne({ token_id: tokenId })
      .select('market_slug')
      .lean();
    if (localOrder && localOrder.market_slug) {
      const result = {
        market_title: 'Unknown Market (Local)',
        market_slug: localOrder.market_slug
      };
      tokenMarketCache.set(tokenId, result);
      return result;
    }
  } catch (dbErr) {
    Logger.log(
      'warn',
      `[${LOG_PREFIX}:enrichment]`,
      `Failed local fallback for token ${tokenId}: ${String(dbErr)}`
    );
  }

  const defaultResult = { market_title: 'Unknown Market', market_slug: '' };
  tokenMarketCache.set(tokenId, defaultResult);
  return defaultResult;
}

async function enrichItems<T extends { asset?: string; token_id?: string }>(
  items: T[],
  logKey: string
): Promise<(T & { market_title?: string; market_slug?: string })[]> {
  // Collect unique uncached tokenIds to batch-fetch from Gamma
  const uncachedIds = new Set<string>();
  for (const item of items) {
    const tokenId = item.asset || item.token_id;
    if (tokenId && tokenId !== 'USDC' && !tokenMarketCache.get(tokenId)) {
      uncachedIds.add(tokenId);
    }
  }

  // Batch-fetch uncached tokens from Gamma (up to 20 per request)
  if (uncachedIds.size > 0) {
    const batches: string[][] = [];
    const ids = [...uncachedIds];
    for (let i = 0; i < ids.length; i += 20) {
      batches.push(ids.slice(i, i + 20));
    }

    await Promise.all(
      batches.map(async (batch) => {
        try {
          const response = await axios.get(`${POLYMARKET_GAMMA_API_URL}/markets`, {
            params: { clobTokenIds: batch.join(',') },
            timeout: 10000
          });

          if (response.data && Array.isArray(response.data)) {
            for (const market of response.data) {
              // Gamma returns markets with tokens[].token_id — match against our batch
              const marketTokenIds: string[] = (market.tokens || [])
                .map((t: { token_id?: string }) => t.token_id)
                .filter(Boolean);

              const result = {
                market_title: market.question || market.title || 'Unknown Market',
                market_slug: market.slug || ''
              };

              for (const tid of marketTokenIds) {
                if (uncachedIds.has(tid)) {
                  tokenMarketCache.set(tid, result);
                }
              }

              // Also cache by condition_id if it matches a batch ID directly
              if (market.condition_id && uncachedIds.has(market.condition_id)) {
                tokenMarketCache.set(market.condition_id, result);
              }
            }
          }
        } catch (err) {
          Logger.log(
            'warn',
            `[${LOG_PREFIX}:enrichment]`,
            `${logKey} Batch Gamma fetch failed for ${batch.length} tokens: ${String(err)}`
          );
        }
      })
    );
  }

  // Now enrich each item from cache (with fallback for any still-uncached)
  return Promise.all(
    items.map(async (item) => {
      const tokenId = item.asset || item.token_id;
      if (tokenId && tokenId !== 'USDC') {
        const metadata = await enrichWithMarketData(tokenId, logKey);
        return { ...item, ...metadata };
      }
      return item;
    })
  );
}

/**
 * Get current positions for a user address.
 */
export async function getPositions(
  userAddress: string,
  logKey: string,
  market?: string
): Promise<DataPosition[]> {
  const fnLog = `[${LOG_PREFIX}:getPositions]`;

  try {
    const params: Record<string, unknown> = { user: userAddress };
    if (market) params.market = market;

    const response = await axios.get<DataPosition[]>(`${POLYMARKET_DATA_API_URL}/positions`, {
      params,
      timeout: 10000
    });

    const enriched = await enrichItems(response.data, logKey);
    return enriched as DataPosition[];
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch positions: ${String(error)}`);
  }
}

/**
 * Get closed positions for a user address.
 */
export async function getClosedPositions(
  userAddress: string,
  logKey: string,
  market?: string
): Promise<DataPosition[]> {
  const fnLog = `[${LOG_PREFIX}:getClosedPositions]`;

  try {
    const params: Record<string, unknown> = { user: userAddress };
    if (market) params.market = market;

    const response = await axios.get<DataPosition[]>(
      `${POLYMARKET_DATA_API_URL}/closed-positions`,
      {
        params,
        timeout: 10000
      }
    );

    const enriched = await enrichItems(response.data, logKey);
    return enriched as DataPosition[];
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch closed positions: ${String(error)}`);
  }
}

/**
 * Get trade activity history for a user address.
 */
export async function getTradeHistory(
  userAddress: string,
  logKey: string,
  market?: string
): Promise<DataTradeActivity[]> {
  const fnLog = `[${LOG_PREFIX}:getTradeHistory]`;

  try {
    const params: Record<string, unknown> = { user: userAddress };
    if (market) params.market = market;

    const response = await axios.get<DataTradeActivity[]>(`${POLYMARKET_DATA_API_URL}/activity`, {
      params,
      timeout: 10000
    });

    const enriched = await enrichItems(response.data, logKey);
    return enriched as DataTradeActivity[];
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch trade history: ${String(error)}`);
  }
}

/**
 * Get portfolio value for a user address.
 */
export async function getPortfolioValue(
  userAddress: string,
  logKey: string
): Promise<Record<string, unknown>> {
  const fnLog = `[${LOG_PREFIX}:getPortfolioValue]`;

  try {
    const response = await axios.get<Record<string, unknown>>(`${POLYMARKET_DATA_API_URL}/value`, {
      params: { user: userAddress },
      timeout: 10000
    });

    return response.data;
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch portfolio value: ${String(error)}`);
  }
}

/**
 * Get trades history for a user address with optional filters.
 * Uses the /trades endpoint which supports market, side, limit, offset.
 */
export async function getTradesHistory(
  userAddress: string,
  query: TradeHistoryQuery,
  logKey: string
): Promise<DataTrade[]> {
  const fnLog = `[${LOG_PREFIX}:getTradesHistory]`;

  try {
    const params: Record<string, unknown> = { user: userAddress };
    if (query.market) params.market = query.market;
    if (query.limit) params.limit = query.limit;
    if (query.offset) params.offset = query.offset;
    if (query.side) params.side = query.side;

    const response = await axios.get<DataTrade[]>(`${POLYMARKET_DATA_API_URL}/trades`, {
      params,
      timeout: 15000
    });

    return response.data;
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch trades history: ${String(error)}`);
  }
}

/**
 * LTTB (Largest Triangle Three Buckets) downsampling.
 *
 * Reduces a time-series to `target` points while preserving visually significant
 * peaks and valleys — much better than uniform stride-based sampling for charts.
 *
 * @see https://skemman.is/bitstream/1946/15343/3/SS_MSthesis.pdf
 */
function lttbDownsample(points: PnlHistoryPoint[], target: number): PnlHistoryPoint[] {
  const len = points.length;
  if (target >= len || target < 3) return points.slice();

  const sampled: PnlHistoryPoint[] = [points[0]]; // Always keep first point
  const bucketSize = (len - 2) / (target - 2);

  let prevIndex = 0;

  for (let bucket = 1; bucket < target - 1; bucket++) {
    // Current bucket boundaries
    const bucketStart = Math.floor((bucket - 1) * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor(bucket * bucketSize) + 1, len - 1);

    // Next bucket boundaries (for computing the average point)
    const nextBucketStart = Math.floor(bucket * bucketSize) + 1;
    const nextBucketEnd = Math.min(Math.floor((bucket + 1) * bucketSize) + 1, len - 1);

    // Average of the NEXT bucket (used as the third vertex of the triangle)
    let avgX = 0;
    let avgY = 0;
    const nextBucketLen = nextBucketEnd - nextBucketStart + 1;
    for (let j = nextBucketStart; j <= nextBucketEnd; j++) {
      avgX += new Date(points[j].timestamp).getTime();
      avgY += points[j].cumulativePnl;
    }
    avgX /= nextBucketLen;
    avgY /= nextBucketLen;

    // Previous selected point (first vertex)
    const prevX = new Date(points[prevIndex].timestamp).getTime();
    const prevY = points[prevIndex].cumulativePnl;

    // Find the point in current bucket that maximizes triangle area
    let maxArea = -1;
    let bestIndex = bucketStart;

    for (let j = bucketStart; j <= bucketEnd; j++) {
      const currX = new Date(points[j].timestamp).getTime();
      const currY = points[j].cumulativePnl;
      // Triangle area formula (doubled, sign doesn't matter — we want max absolute)
      const area = Math.abs(
        (prevX - avgX) * (currY - prevY) - (prevX - currX) * (avgY - prevY)
      );
      if (area > maxArea) {
        maxArea = area;
        bestIndex = j;
      }
    }

    sampled.push(points[bestIndex]);
    prevIndex = bestIndex;
  }

  sampled.push(points[len - 1]); // Always keep last point
  return sampled;
}

/**
 * Compute cumulative PNL history from all user trades, suitable for charting.
 *
 * Fetches all trades via /trades, sorts by timestamp ascending, and computes
 * a running total of cost (BUYs) vs proceeds (SELLs).
 *
 * If `limit` is provided, the resulting points are downsampled to that count.
 */
export async function getPnlHistory(
  userAddress: string,
  logKey: string,
  limit?: number
): Promise<PnlHistoryPoint[]> {
  const fnLog = `[${LOG_PREFIX}:getPnlHistory]`;

  try {
    // Fetch all trades (max 10000)
    const response = await axios.get<DataTrade[]>(`${POLYMARKET_DATA_API_URL}/trades`, {
      params: { user: userAddress, limit: 10000 },
      timeout: 30000
    });

    const trades = response.data;
    if (!trades.length) return [];

    // Sort by timestamp ascending (oldest first)
    trades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Compute cumulative PNL
    let cumulativeCost = 0;
    let cumulativeProceeds = 0;

    const points: PnlHistoryPoint[] = trades.map((trade) => {
      const amount = parseFloat(trade.price) * parseFloat(trade.size);
      if (trade.side === 'BUY') {
        cumulativeCost += amount;
      } else {
        cumulativeProceeds += amount;
      }

      return {
        timestamp: trade.timestamp,
        cumulativePnl: cumulativeProceeds - cumulativeCost,
        totalInvested: cumulativeCost,
        totalProceeds: cumulativeProceeds
      };
    });

    // Downsample using LTTB (Largest Triangle Three Buckets) algorithm.
    // Unlike uniform sampling, LTTB preserves visually significant peaks and valleys.
    if (limit && limit > 0 && points.length > limit) {
      return lttbDownsample(points, limit);
    }

    return points;
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to compute PNL history: ${String(error)}`);
  }
}


/**
 * Get a summary of the user's Polymarket balances: idle USDC.e + active positions.
 *
 * - idle_usdc: USDC.e sitting in the Polygon Safe (not in any position)
 * - positions_value: total current value of all active positions (in USD)
 *
 * This is best-effort: failures return zeroes so the balance endpoint stays resilient.
 */
export async function getPolymarketBalanceSummary(
  polygonAddress: string,
  logKey: string
): Promise<{ idle_usdc: number; positions_value: number }> {
  const fnLog = `[${LOG_PREFIX}:getPolymarketBalanceSummary]`;

  try {
    // Query idle USDC.e balance on Polygon and active positions in parallel
    const provider = new ethers.providers.JsonRpcProvider(POLYMARKET_POLYGON_RPC_URL);
    const usdc = new ethers.Contract(
      USDC_E_ADDRESS,
      ['function balanceOf(address) view returns (uint256)'],
      provider
    );

    const [rawBalance, positions] = await Promise.all([
      usdc.balanceOf(polygonAddress) as Promise<ethers.BigNumber>,
      getPositions(polygonAddress, logKey).catch(() => [] as DataPosition[])
    ]);

    const idle_usdc = Number(ethers.utils.formatUnits(rawBalance, 6));
    const positions_value = positions.reduce((sum, p) => sum + (p.currentValue || 0), 0);

    Logger.log(
      'info',
      fnLog,
      `${logKey} Polymarket balances — idle USDC.e: $${idle_usdc.toFixed(2)}, positions: $${positions_value.toFixed(2)}`
    );

    return { idle_usdc, positions_value };
  } catch (error) {
    Logger.log('warn', fnLog, `${logKey} Failed to fetch Polymarket balances: ${String(error)}`);
    return { idle_usdc: 0, positions_value: 0 };
  }
}

/**
 * Synchronize all open orders on the Polymarket CLOB with our MongoDB.
 * Fetches from CLOB, compares against pending, updates MongoDB.
 */
export async function syncOpenOrders(
  user: IUser,
  privateKey: string,
  logKey: string
): Promise<void> {
  const fnLog = `[${LOG_PREFIX}:syncOpenOrders]`;
  try {
    Logger.log(
      'info',
      fnLog,
      `${logKey} Starting local vs remote order state reconciliation for user ${user.phone_number}`
    );

    // Fetch live open orders from CLOB
    const clobOrders = await getOpenOrders(user, privateKey, logKey);
    const liveOrderIds = new Set(
      clobOrders
        .map((o) => o.id || (o as any).orderID)
        .filter((id): id is string => {
          if (!id) {
            Logger.log('warn', fnLog, `${logKey} CLOB order missing both id and orderID fields`);
          }
          return !!id;
        })
    );

    // Fetch local pending orders from DB
    const localPendingOrders = await PolymarketOrderModel.find({
      user_phone: user.phone_number,
      status: 'pending'
    }).lean();

    const client = await getAuthenticatedClientForUser(user, privateKey);

    // Collect bulk updates instead of sequential saves
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bulkOps: any[] = [];

    for (const pendingOrder of localPendingOrders) {
      if (!liveOrderIds.has(pendingOrder.order_id)) {
        // It's no longer open on CLOB
        let newStatus = 'cancelled';
        try {
          // getOrder returns the order details including status and matched size
          const orderData = await client.getOrder(pendingOrder.order_id);
          if (orderData) {
            const sizeMatched = Number((orderData as any).size_matched || 0);
            if (sizeMatched >= pendingOrder.size) {
              newStatus = 'filled';
            } else if (sizeMatched > 0) {
              newStatus = 'partial';
            }
          }
        } catch (getOrderError) {
          Logger.log(
            'warn',
            fnLog,
            `${logKey} Could not fetch closed order ${pendingOrder.order_id} from CLOB. Marking as cancelled.`
          );
        }

        bulkOps.push({
          updateOne: {
            filter: { _id: pendingOrder._id },
            update: { $set: { status: newStatus, updated_at: new Date() } }
          }
        });

        Logger.log(
          'info',
          fnLog,
          `${logKey} Synced order ${pendingOrder.order_id}: pending -> ${newStatus}`
        );
      }
    }

    if (bulkOps.length > 0) {
      await PolymarketOrderModel.bulkWrite(bulkOps);
    }
    Logger.log('info', fnLog, `${logKey} Reconciliation complete (${bulkOps.length} orders updated)`);
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Reconciliation failed: ${String(error)}`);
    throw new Error(`Failed to sync orders: ${String(error)}`);
  }
}

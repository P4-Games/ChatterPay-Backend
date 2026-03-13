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

import { POLYMARKET_DATA_API_URL, POLYMARKET_GAMMA_API_URL } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import { PolymarketOrderModel } from '../../models/polymarketModel';
import type { IUser } from '../../models/userModel';
import { getAuthenticatedClientForUser } from './polymarketClientService';
import { ensureTokenApprovals } from './polymarketRelayerService';
import type {
  ClobOpenOrder,
  ClobOrderResponse,
  DataPosition,
  DataTradeActivity,
  PlaceOrderParams
} from './polymarketTypes';

const LOG_PREFIX = 'polymarketTradingService';

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
        await Promise.all([
          client.updateBalanceAllowance(conditionalParams),
          client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL })
        ]);

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
        // FOK orders use createAndPostMarketOrder.
        // SDK UserMarketOrder.amount semantics:
        //   BUY  → dollar amount to spend (price × size)
        //   SELL → number of shares to sell (size)
        const amount = params.side === 'BUY' ? params.price * params.size : params.size;

        return client.createAndPostMarketOrder({
          tokenID: params.tokenId,
          price: params.price,
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
      const isAllowanceError = errorDetail.includes('not enough balance') || errorDetail.includes('allowance');
      const isMinSizeError = errorDetail.includes('lower than the minimum');

      if (params.side === 'SELL' && isAllowanceError) {
        Logger.log(
          'warn',
          fnLog,
          `${logKey} SELL rejected (${errorDetail}). Setting fresh approvals and retrying...`
        );
        await ensureTokenApprovals(privateKey, logKey);
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Refresh both asset type caches after approvals
        await Promise.all([
          client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: params.tokenId }),
          client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL })
        ]);

        response = await submitOrder();

        // After retry, check again — might reveal a different error (e.g. min size)
        if (!response.orderID) {
          const retryDetail = String(response.error || response.message || '');
          if (params.side === 'SELL' && retryDetail.includes('lower than the minimum') && params.orderType !== 'FOK') {
            Logger.log('warn', fnLog, `${logKey} GTC SELL below minimum after retry. Falling back to FOK market order.`);
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
            throw new Error(`CLOB rejected order after retry: ${retryDetail || 'no orderID in response'}`);
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
const tokenMarketCache = new NodeCache({ stdTTL: 3600 });

async function enrichWithMarketData(tokenId: string, logKey: string): Promise<{ market_title: string; market_slug: string }> {
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
    Logger.log('warn', `[${LOG_PREFIX}:enrichment]`, `Failed to enrich token ${tokenId} from Gamma: ${String(err)}`);
  }
  
  // Best-effort local DB fallback
  try {
    const localOrder = await PolymarketOrderModel.findOne({ token_id: tokenId }).select('market_slug').lean();
    if (localOrder && localOrder.market_slug) {
      const result = { market_title: 'Unknown Market (Local)', market_slug: localOrder.market_slug };
      tokenMarketCache.set(tokenId, result);
      return result;
    }
  } catch (dbErr) {
    Logger.log('warn', `[${LOG_PREFIX}:enrichment]`, `Failed local fallback for token ${tokenId}: ${String(dbErr)}`);
  }
  
  const defaultResult = { market_title: 'Unknown Market', market_slug: '' };
  tokenMarketCache.set(tokenId, defaultResult);
  return defaultResult;
}

async function enrichItems<T extends { asset?: string; token_id?: string }>(items: T[], logKey: string): Promise<(T & { market_title?: string; market_slug?: string })[]> {
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
export async function getPositions(userAddress: string, logKey: string): Promise<DataPosition[]> {
  const fnLog = `[${LOG_PREFIX}:getPositions]`;

  try {
    const response = await axios.get<DataPosition[]>(`${POLYMARKET_DATA_API_URL}/positions`, {
      params: { user: userAddress },
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
  logKey: string
): Promise<DataPosition[]> {
  const fnLog = `[${LOG_PREFIX}:getClosedPositions]`;

  try {
    const response = await axios.get<DataPosition[]>(
      `${POLYMARKET_DATA_API_URL}/closed-positions`,
      {
        params: { user: userAddress },
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
  logKey: string
): Promise<DataTradeActivity[]> {
  const fnLog = `[${LOG_PREFIX}:getTradeHistory]`;

  try {
    const response = await axios.get<DataTradeActivity[]>(`${POLYMARKET_DATA_API_URL}/activity`, {
      params: { user: userAddress },
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
    Logger.log('info', fnLog, `${logKey} Starting local vs remote order state reconciliation for user ${user.phone_number}`);
    
    // Fetch live open orders from CLOB
    const clobOrders = await getOpenOrders(user, privateKey, logKey);
    const liveOrderIds = new Set(clobOrders.map((o) => o.id || (o as any).orderID));

    // Fetch local pending orders from DB
    const localPendingOrders = await PolymarketOrderModel.find({
      user_phone: user.phone_number,
      status: 'pending'
    });

    const client = await getAuthenticatedClientForUser(user, privateKey);

    for (const pendingOrder of localPendingOrders) {
      if (!liveOrderIds.has(pendingOrder.order_id)) {
        // It's no longer open on CLOB
        try {
          // getOrder returns the order details including status and matched size
          const orderData = await client.getOrder(pendingOrder.order_id);
          let newStatus = 'cancelled';
          if (orderData) {
            const sizeMatched = Number((orderData as any).size_matched || 0);
            if (sizeMatched >= pendingOrder.size) {
              newStatus = 'filled';
            } else if (sizeMatched > 0) {
              newStatus = 'partial';
            }
          }
          pendingOrder.status = newStatus as any;
          await pendingOrder.save();
          Logger.log('info', fnLog, `${logKey} Synced order ${pendingOrder.order_id}: pending -> ${newStatus}`);
        } catch (getOrderError) {
          Logger.log('warn', fnLog, `${logKey} Could not fetch closed order ${pendingOrder.order_id} from CLOB. Marking as cancelled.`);
          pendingOrder.status = 'cancelled' as any;
          await pendingOrder.save();
        }
      }
    }
    Logger.log('info', fnLog, `${logKey} Reconciliation complete`);
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Reconciliation failed: ${String(error)}`);
    throw new Error(`Failed to sync orders: ${String(error)}`);
  }
}

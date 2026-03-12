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

import { POLYMARKET_DATA_API_URL } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
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

    // Ensure on-chain approvals are in place (gasless via Relayer)
    // The CLOB client's updateBalanceAllowance only refreshes the server-side cache.
    // If the on-chain approval is missing, we need to submit it via the Relayer first.
    try {
      const allowanceStatus = await client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL
      });

      const currentAllowance = Number(allowanceStatus?.allowance ?? 0);

      if (currentAllowance === 0) {
        Logger.log(
          'info',
          fnLog,
          `${logKey} No USDC.e allowance detected — setting up approvals via Relayer`
        );
        await ensureTokenApprovals(privateKey, logKey);

        // Refresh the CLOB's cached allowance after on-chain approval
        await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        Logger.log('info', fnLog, `${logKey} Approvals set and CLOB cache refreshed`);
      } else {
        // Just refresh the cache
        await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        Logger.log('info', fnLog, `${logKey} Balance/allowance updated on CLOB`);
      }
    } catch (allowanceError) {
      Logger.log(
        'warn',
        fnLog,
        `${logKey} Allowance check/update failed (non-fatal): ${String(allowanceError)}`
      );
    }

    const side = params.side === 'BUY' ? Side.BUY : Side.SELL;

    let response: Record<string, unknown>;

    if (params.orderType === 'FOK') {
      // FOK orders use createAndPostMarketOrder.
      // SDK UserMarketOrder.amount semantics:
      //   BUY  → dollar amount to spend (price × size)
      //   SELL → number of shares to sell (size)
      const amount = params.side === 'BUY' ? params.price * params.size : params.size;

      response = await client.createAndPostMarketOrder({
        tokenID: params.tokenId,
        price: params.price,
        amount,
        side
      });
    } else {
      // GTC (default) and GTD orders use createAndPostOrder
      const orderType = params.orderType === 'GTD' ? OrderType.GTD : OrderType.GTC;
      response = await client.createAndPostOrder(
        {
          tokenID: params.tokenId,
          price: params.price,
          size: params.size,
          side
        },
        undefined,
        orderType
      );
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

    return response.data;
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

    return response.data;
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

    return response.data;
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

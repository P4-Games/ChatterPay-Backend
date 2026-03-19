/**
 * Polymarket Purchase Service
 *
 * Orchestrates the unified purchase flow:
 *   1. Account creation (if needed) + terms acceptance
 *   2. Bridge USDC from Scroll → Polygon
 *   3. Place order on Polymarket
 *
 * Each step updates the purchase record in MongoDB so the status
 * endpoint can return real-time progress.
 */

import { ethers } from 'ethers';
import PQueue from 'p-queue';

import { POLYMARKET_POLYGON_RPC_URL } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import type { IUser } from '../../models/userModel';
import {
  createOrder,
  updatePurchaseStatus,
  updatePurchaseStep
} from '../mongo/mongoPolymarketService';
import { getUser } from '../userService';
import { acceptTerms, createPolymarketAccount } from './polymarketAccountService';
import {
  executeBridge,
  getPreferredScrollStablecoin,
  withdrawToScroll
} from './polymarketBridgeService';
import { executeGaslessWithdrawal } from './polymarketRelayerService';
import { placeOrder } from './polymarketTradingService';

const LOG_PREFIX = 'polymarketPurchaseService';

// ============================================================================
// Per-user order placement lock
// ============================================================================
//
// Serializes ONLY the order placement step (not bridges) so concurrent
// purchases for the same user don't race on CLOB balance.
// Also tracks committed USDC.e for GTC orders where on-chain balance
// doesn't change until the order is matched/filled.

interface UserOrderLock {
  queue: PQueue;
  committedUsdce: number;
}

const userOrderLocks = new Map<string, UserOrderLock>();

function getOrderLock(userId: string): UserOrderLock {
  let entry = userOrderLocks.get(userId);
  if (!entry) {
    const queue = new PQueue({ concurrency: 1 });
    entry = { queue, committedUsdce: 0 };
    userOrderLocks.set(userId, entry);
    queue.on('idle', () => userOrderLocks.delete(userId));
  }
  return entry;
}

// Polygon USDC.e address
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// 2% buffer applied to bridged amounts to cover LiFi/bridge fees and slippage
const BRIDGE_FEE_BUFFER = 1.02;

/**
 * Read the on-chain USDC.e balance of a Polygon address.
 *
 * @param address - Polygon address to check (typically the user's Safe)
 * @param logKey - Logging identifier
 * @returns Balance as a human-readable number (e.g. 15.50 for $15.50)
 */
async function getPolygonUsdceBalance(address: string, logKey: string): Promise<number> {
  const fnLog = `[${LOG_PREFIX}:getPolygonUsdceBalance]`;

  const provider = new ethers.providers.JsonRpcProvider(POLYMARKET_POLYGON_RPC_URL);
  const usdc = new ethers.Contract(
    USDC_E_ADDRESS,
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );

  const rawBalance: ethers.BigNumber = await usdc.balanceOf(address);
  const balance = Number(ethers.utils.formatUnits(rawBalance, 6));

  Logger.log('info', fnLog, `${logKey} USDC.e balance for ${address}: $${balance.toFixed(2)}`);

  return balance;
}

/**
 * Withdraw ALL USDC.e from the Polygon Safe back to Scroll proxy.
 *
 * Uses on-chain RPC balance check (not the CLOB cache) so it picks up
 * both sell proceeds AND any pre-existing idle USDC.e in the Safe.
 *
 * When `purchaseId` is provided, the function updates the `withdrawal`
 * purchase step so the frontend can poll for real-time progress.
 *
 * Best-effort: failures are logged but do not propagate (unless tracked
 * via a purchase record, in which case the step is marked as failed).
 */
export async function withdrawSellProceeds(
  user: IUser,
  privateKey: string,
  logKey: string,
  purchaseId?: string
): Promise<void> {
  const fnLog = `[${LOG_PREFIX}:withdrawSellProceeds]`;

  try {
    if (!user.polymarket_account) {
      Logger.log('warn', fnLog, `${logKey} No Polymarket account — skipping withdrawal`);
      return;
    }

    const proxyAddress = user.wallets[0]?.wallet_proxy || '';
    if (!proxyAddress) {
      Logger.log('warn', fnLog, `${logKey} No proxy wallet — skipping withdrawal`);
      return;
    }

    const safeAddress = user.polymarket_account.polygon_address;

    // On-chain USDC.e balance check (catches sell proceeds + any idle balance)
    const provider = new ethers.providers.JsonRpcProvider(POLYMARKET_POLYGON_RPC_URL);
    const usdc = new ethers.Contract(
      USDC_E_ADDRESS,
      ['function balanceOf(address) view returns (uint256)'],
      provider
    );

    // Wait for USDC.e to arrive after the sell fill, with retries.
    // Intervals: 3s → 10s → 20s → 30s (total ~63s max wait)
    const retryDelays = [3000, 10000, 20000, 30000];
    let rawBalance: ethers.BigNumber = ethers.BigNumber.from(0);

    for (let i = 0; i < retryDelays.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, retryDelays[i]));

      rawBalance = await usdc.balanceOf(safeAddress);
      const balanceHuman = Number(ethers.utils.formatUnits(rawBalance, 6));

      Logger.log(
        'info',
        fnLog,
        `${logKey} Safe USDC.e on-chain balance (attempt ${i + 1}/${retryDelays.length}): ${rawBalance.toString()} ($${balanceHuman.toFixed(2)})`
      );

      if (rawBalance.gt(0)) break;
    }

    if (rawBalance.lte(0)) {
      Logger.log(
        'info',
        fnLog,
        `${logKey} No USDC.e after ${retryDelays.length} attempts. GTC order may still be pending.`
      );
      if (purchaseId) {
        await updatePurchaseStep(purchaseId, 'withdrawal', { status: 'skipped' }, logKey);
      }
      return;
    }

    const amount = rawBalance.toString();
    const balanceHuman = Number(ethers.utils.formatUnits(rawBalance, 6));

    // Determine which stablecoin the user holds on Scroll (USDC or USDT)
    const toToken = await getPreferredScrollStablecoin(proxyAddress, logKey);

    Logger.log(
      'info',
      fnLog,
      `${logKey} Withdrawing $${balanceHuman.toFixed(2)} USDC.e from Polygon Safe to Scroll proxy (→${toToken})`
    );

    // Get LiFi bridge quote (Polygon → Scroll)
    const quote = await withdrawToScroll(safeAddress, proxyAddress, amount, logKey, toToken);

    // Execute via Relayer (gasless from the Safe)
    await executeGaslessWithdrawal(
      privateKey,
      {
        approvalAddress: quote.approvalAddress,
        to: quote.to,
        data: quote.data,
        value: quote.value
      },
      amount,
      logKey
    );

    Logger.log(
      'info',
      fnLog,
      `${logKey} Withdrawal initiated: $${balanceHuman.toFixed(2)} USDC.e → Scroll`
    );

    if (purchaseId) {
      await updatePurchaseStep(purchaseId, 'withdrawal', { status: 'completed' }, logKey);
    }
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Withdrawal failed (non-fatal): ${String(error)}`);
    if (purchaseId) {
      await updatePurchaseStep(
        purchaseId,
        'withdrawal',
        { status: 'failed', error: String(error) },
        logKey
      );
    }
  }
}

export interface PurchaseParams {
  tokenId: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  orderType?: 'GTC' | 'FOK' | 'GTD';
  bridgeAmount: string;
  termsVersion?: number;
}

/**
 * Execute the full purchase flow in background.
 *
 * This function is designed to be called without awaiting (fire-and-forget).
 * It updates the purchase record in MongoDB after each step so the client
 * can poll for progress via the status endpoint.
 */
export async function executePurchase(
  user: IUser,
  privateKey: string,
  purchaseId: string,
  params: PurchaseParams,
  logKey: string
): Promise<void> {
  const fnLog = `[${LOG_PREFIX}:executePurchase]`;

  try {
    // Mark purchase as processing
    await updatePurchaseStatus(purchaseId, 'processing', 'account_creation', undefined, logKey);

    // ── Step 1: Account Creation ──────────────────────────────────────────
    let currentUser = user;

    if (currentUser.polymarket_account) {
      Logger.log('info', fnLog, `${logKey} Account already exists, skipping creation`);
      await updatePurchaseStep(purchaseId, 'account_creation', { status: 'skipped' }, logKey);
    } else {
      Logger.log('info', fnLog, `${logKey} Creating Polymarket account`);
      await updatePurchaseStep(purchaseId, 'account_creation', { status: 'in_progress' }, logKey);

      try {
        currentUser = await createPolymarketAccount(currentUser, privateKey, logKey);

        // Accept terms as part of account creation in the purchase flow
        if (params.termsVersion) {
          currentUser = await acceptTerms(currentUser, params.termsVersion, logKey);
        }

        await updatePurchaseStep(purchaseId, 'account_creation', { status: 'completed' }, logKey);
        Logger.log('info', fnLog, `${logKey} Account created successfully`);
      } catch (error) {
        const errorMsg = `Account creation failed: ${String(error)}`;
        Logger.log('error', fnLog, `${logKey} ${errorMsg}`);
        await updatePurchaseStep(
          purchaseId,
          'account_creation',
          { status: 'failed', error: errorMsg },
          logKey
        );
        await updatePurchaseStatus(
          purchaseId,
          'failed',
          'account_creation',
          { error: errorMsg },
          logKey
        );
        return;
      }
    }

    // ── Step 2: Bridge (BUY only) ───────────────────────────────────────
    // Check existing USDC.e in the Polygon Safe and bridge only the deficit.
    // If the Safe already holds enough, the bridge is skipped entirely.
    if (params.side === 'BUY') {
      Logger.log('info', fnLog, `${logKey} Starting bridge step`);
      await updatePurchaseStatus(purchaseId, 'processing', 'bridge', undefined, logKey);
      await updatePurchaseStep(purchaseId, 'bridge', { status: 'in_progress' }, logKey);

      try {
        const safeAddress = currentUser.polymarket_account!.polygon_address;
        const existingBalance = await getPolygonUsdceBalance(safeAddress, logKey);
        const requiredUsdc = params.price * params.size;
        const deficit = requiredUsdc - existingBalance;

        Logger.log(
          'info',
          fnLog,
          `${logKey} Bridge check — required: $${requiredUsdc.toFixed(2)}, ` +
            `existing: $${existingBalance.toFixed(2)}, deficit: $${deficit.toFixed(2)}`
        );

        if (deficit <= 0) {
          // Existing balance covers the full purchase — skip bridge
          Logger.log(
            'info',
            fnLog,
            `${logKey} Skipping bridge: existing balance ($${existingBalance.toFixed(2)}) ` +
              `covers required ($${requiredUsdc.toFixed(2)})`
          );
          await updatePurchaseStep(purchaseId, 'bridge', { status: 'skipped' }, logKey);
          await updatePurchaseStatus(
            purchaseId,
            'processing',
            'order_placement',
            undefined,
            logKey
          );
        } else {
          // Bridge only the deficit (+ 2% buffer for fees/slippage),
          // but never exceed the client-authorized bridge amount.
          const deficitRaw = Math.ceil(deficit * BRIDGE_FEE_BUFFER * 1_000_000);
          const maxAllowed = Number(params.bridgeAmount);
          const actualBridgeAmount = Math.min(deficitRaw, maxAllowed).toString();

          Logger.log(
            'info',
            fnLog,
            `${logKey} Bridging deficit: $${(deficit * BRIDGE_FEE_BUFFER).toFixed(2)} ` +
              `(${actualBridgeAmount} smallest units, max allowed: ${params.bridgeAmount})`
          );

          const bridgeResult = await executeBridge(
            currentUser,
            privateKey,
            actualBridgeAmount,
            logKey
          );

          await updatePurchaseStep(
            purchaseId,
            'bridge',
            { status: 'completed', tx_hash: bridgeResult.txHash },
            logKey
          );
          await updatePurchaseStatus(
            purchaseId,
            'processing',
            'order_placement',
            { bridge_tx_hash: bridgeResult.txHash },
            logKey
          );
          Logger.log('info', fnLog, `${logKey} Bridge completed: ${bridgeResult.txHash}`);
        }
      } catch (error) {
        const errorMsg = `Bridge failed: ${String(error)}`;
        Logger.log('error', fnLog, `${logKey} ${errorMsg}`);
        await updatePurchaseStep(
          purchaseId,
          'bridge',
          { status: 'failed', error: errorMsg },
          logKey
        );
        await updatePurchaseStatus(purchaseId, 'failed', 'bridge', { error: errorMsg }, logKey);
        return;
      }
    } else {
      // SELL: no bridge needed — go straight to order placement
      Logger.log(
        'info',
        fnLog,
        `${logKey} SELL order — skipping bridge, proceeding to order placement`
      );
      await updatePurchaseStatus(purchaseId, 'processing', 'order_placement', undefined, logKey);
    }

    // ── Step 3: Order Placement ───────────────────────────────────────────
    // Serialized per-user via order lock so concurrent purchases don't race
    // on CLOB balance. Bridges still run fully in parallel — only this step
    // is serialized (~3-5s per order).
    Logger.log('info', fnLog, `${logKey} Placing order`);
    await updatePurchaseStep(purchaseId, 'order_placement', { status: 'in_progress' }, logKey);

    let orderID: string;
    try {
      // Re-fetch user to get updated polymarket_account (may have been created in step 1)
      const freshUser = await getUser(currentUser.phone_number);
      if (!freshUser || !freshUser.polymarket_account) {
        throw new Error('User or Polymarket account not found after bridge');
      }

      const lock = getOrderLock(freshUser.phone_number);

      const { orderResult, effectiveSize } = (await lock.queue.add(async () => {
        let effectiveSize = params.size;

        // For BUY orders, check actual on-chain USDC.e balance and adjust
        // order size to account for bridge slippage and concurrent orders.
        if (params.side === 'BUY') {
          const safeAddress = freshUser.polymarket_account!.polygon_address;
          const onChainBalance = await getPolygonUsdceBalance(safeAddress, logKey);
          const available = Math.max(onChainBalance - lock.committedUsdce, 0);
          const requiredUsdc = params.price * params.size;
          const maxAffordableSize = Math.floor((available / params.price) * 100) / 100;

          Logger.log(
            'info',
            fnLog,
            `${logKey} Balance check — on-chain: $${onChainBalance.toFixed(2)}, ` +
              `committed: $${lock.committedUsdce.toFixed(2)}, available: $${available.toFixed(2)}, ` +
              `required: $${requiredUsdc.toFixed(2)}`
          );

          if (available < requiredUsdc) {
            effectiveSize = maxAffordableSize;

            if (effectiveSize <= 0) {
              throw new Error(
                `Insufficient USDC.e after bridge: $${available.toFixed(2)} available, ` +
                  `need $${requiredUsdc.toFixed(2)} for ${params.size} shares @ $${params.price}`
              );
            }

            Logger.log(
              'warn',
              fnLog,
              `${logKey} Adjusted order size: ${params.size} → ${effectiveSize} ` +
                `(available $${available.toFixed(2)} < required $${requiredUsdc.toFixed(2)})`
            );
          }
        }

        const orderResult = await placeOrder(
          freshUser,
          privateKey,
          {
            tokenId: params.tokenId,
            price: params.price,
            size: effectiveSize,
            side: params.side,
            orderType: params.orderType
          },
          logKey
        );

        // Track committed funds for subsequent orders in the same batch
        // (GTC orders don't change on-chain balance until matched)
        if (params.side === 'BUY') {
          lock.committedUsdce += effectiveSize * params.price;
        }

        return { orderResult, effectiveSize };
      })) as { orderResult: { orderID: string }; effectiveSize: number };

      orderID = orderResult.orderID;

      // Persist order record with the effective (possibly adjusted) size
      await createOrder({
        user_phone: freshUser.phone_number,
        order_id: orderID,
        market_condition_id: params.tokenId,
        market_slug: '',
        token_id: params.tokenId,
        side: params.side,
        price: params.price,
        size: effectiveSize,
        status: 'pending'
      });

      await updatePurchaseStep(
        purchaseId,
        'order_placement',
        { status: 'completed', order_id: orderID },
        logKey
      );
      Logger.log('info', fnLog, `${logKey} Order placed: ${orderID} (size: ${effectiveSize})`);

      // ── Step 4 (SELL only): Withdrawal ──────────────────────────────────
      // After a SELL fills, USDC.e lands in the Polygon Safe. Bridge it back
      // to the user's Scroll proxy automatically, tracking the step progress.
      if (params.side === 'SELL') {
        Logger.log('info', fnLog, `${logKey} Starting SELL proceeds withdrawal`);
        await updatePurchaseStatus(purchaseId, 'processing', 'withdrawal', undefined, logKey);
        await updatePurchaseStep(purchaseId, 'withdrawal', { status: 'in_progress' }, logKey);

        await withdrawSellProceeds(freshUser, privateKey, logKey, purchaseId);
      }

      // Mark entire purchase as completed
      await updatePurchaseStatus(purchaseId, 'completed', 'done', { order_id: orderID }, logKey);
      Logger.log('info', fnLog, `${logKey} Purchase completed. Order: ${orderID}`);
    } catch (error) {
      const errorMsg = `Order placement failed: ${String(error)}`;
      Logger.log('error', fnLog, `${logKey} ${errorMsg}`);
      await updatePurchaseStep(
        purchaseId,
        'order_placement',
        { status: 'failed', error: errorMsg },
        logKey
      );
      await updatePurchaseStatus(
        purchaseId,
        'failed',
        'order_placement',
        { error: errorMsg },
        logKey
      );
    }
  } catch (error) {
    // Catch-all for unexpected errors
    const errorMsg = `Unexpected error: ${String(error)}`;
    Logger.log('error', fnLog, `${logKey} ${errorMsg}`);
    await updatePurchaseStatus(purchaseId, 'failed', 'done', { error: errorMsg }, logKey);
  }
}

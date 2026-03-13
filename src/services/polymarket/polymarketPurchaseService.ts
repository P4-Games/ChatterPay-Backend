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

import { AssetType } from '@polymarket/clob-client';

import { Logger } from '../../helpers/loggerHelper';
import type { IUser } from '../../models/userModel';
import {
  createOrder,
  updatePurchaseStatus,
  updatePurchaseStep
} from '../mongo/mongoPolymarketService';
import { getUser } from '../userService';
import { acceptTerms, createPolymarketAccount } from './polymarketAccountService';
import { executeBridge, withdrawToScroll } from './polymarketBridgeService';
import { getAuthenticatedClientForUser } from './polymarketClientService';
import { executeGaslessWithdrawal } from './polymarketRelayerService';
import { placeOrder } from './polymarketTradingService';

const LOG_PREFIX = 'polymarketPurchaseService';

/**
 * Withdraw USDC.e sell proceeds from Polygon Safe back to Scroll proxy.
 *
 * Queries the Safe's COLLATERAL balance, and if > 0, bridges it all
 * back to the user's Scroll proxy address via LiFi + Polymarket Relayer.
 *
 * This is best-effort: failures are logged but do not propagate.
 */
export async function withdrawSellProceeds(
  user: IUser,
  privateKey: string,
  logKey: string
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

    // Wait for the CLOB/exchange to settle the fill
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Query USDC.e balance in the Polygon Safe
    const client = await getAuthenticatedClientForUser(user, privateKey);
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const status = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const rawBalance = Number(status?.balance ?? 0);

    Logger.log('info', fnLog, `${logKey} Safe USDC.e balance: ${rawBalance} (${rawBalance / 1_000_000} USDC)`);

    if (rawBalance <= 0) {
      Logger.log('info', fnLog, `${logKey} No USDC.e to withdraw (order may be pending fill)`);
      return;
    }

    const amount = String(rawBalance);
    const safeAddress = user.polymarket_account.polygon_address;

    Logger.log('info', fnLog, `${logKey} Withdrawing ${rawBalance / 1_000_000} USDC.e from Polygon Safe to Scroll proxy`);

    // Get LiFi bridge quote (Polygon → Scroll)
    const quote = await withdrawToScroll(safeAddress, proxyAddress, amount, logKey);

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

    Logger.log('info', fnLog, `${logKey} Withdrawal initiated: ${rawBalance / 1_000_000} USDC.e → Scroll`);
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Withdrawal failed (non-fatal): ${String(error)}`);
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

    // ── Step 2: Bridge ────────────────────────────────────────────────────
    if (params.side === 'BUY') {
      Logger.log('info', fnLog, `${logKey} Starting bridge`);
      await updatePurchaseStatus(purchaseId, 'processing', 'bridge', undefined, logKey);
      await updatePurchaseStep(purchaseId, 'bridge', { status: 'in_progress' }, logKey);

      try {
        const bridgeResult = await executeBridge(
          currentUser,
          privateKey,
          params.bridgeAmount,
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
      } catch (error) {
        const errorMsg = `Bridge failed: ${String(error)}`;
        Logger.log('error', fnLog, `${logKey} ${errorMsg}`);
        await updatePurchaseStep(purchaseId, 'bridge', { status: 'failed', error: errorMsg }, logKey);
        await updatePurchaseStatus(purchaseId, 'failed', 'bridge', { error: errorMsg }, logKey);
        return;
      }
    } else {
      Logger.log('info', fnLog, `${logKey} SELL order detected. Skipping bridge step.`);
      await updatePurchaseStep(purchaseId, 'bridge', { status: 'skipped' }, logKey);
      await updatePurchaseStatus(purchaseId, 'processing', 'order_placement', undefined, logKey);
    }

    // ── Step 3: Order Placement ───────────────────────────────────────────
    Logger.log('info', fnLog, `${logKey} Placing order`);
    await updatePurchaseStep(purchaseId, 'order_placement', { status: 'in_progress' }, logKey);

    try {
      // Re-fetch user to get updated polymarket_account (may have been created in step 1)
      const freshUser = await getUser(currentUser.phone_number);
      if (!freshUser || !freshUser.polymarket_account) {
        throw new Error('User or Polymarket account not found after bridge');
      }

      const orderResult = await placeOrder(
        freshUser,
        privateKey,
        {
          tokenId: params.tokenId,
          price: params.price,
          size: params.size,
          side: params.side,
          orderType: params.orderType
        },
        logKey
      );

      // Persist order record
      await createOrder({
        user_phone: freshUser.phone_number,
        order_id: orderResult.orderID,
        market_condition_id: params.tokenId,
        market_slug: '',
        token_id: params.tokenId,
        side: params.side,
        price: params.price,
        size: params.size,
        status: 'pending'
      });

      // Auto-withdraw SELL proceeds from Polygon Safe → Scroll proxy.
      // After a SELL fills, USDC.e lands in the Safe. The user's wallet is
      // on Scroll, so we bridge it back automatically.
      if (params.side === 'SELL') {
        await withdrawSellProceeds(freshUser, privateKey, logKey);
      }

      await updatePurchaseStep(
        purchaseId,
        'order_placement',
        { status: 'completed', order_id: orderResult.orderID },
        logKey
      );
      await updatePurchaseStatus(
        purchaseId,
        'completed',
        'done',
        { order_id: orderResult.orderID },
        logKey
      );
      Logger.log('info', fnLog, `${logKey} Purchase completed. Order: ${orderResult.orderID}`);
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

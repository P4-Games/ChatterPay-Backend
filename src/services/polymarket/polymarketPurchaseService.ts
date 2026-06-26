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
import { mongoTransactionService } from '../mongo/mongoTransactionService';
import {
  sendPolymarketOrderFailedNotification,
  sendPolymarketOrderPlacedNotification,
  sendPolymarketSettlementClaimedNotification
} from '../notificationService';
import { getUser } from '../userService';
import { acceptTerms, createPolymarketAccount } from './polymarketAccountService';
import {
  executeBridge,
  getPreferredScrollStablecoin,
  withdrawToScroll
} from './polymarketBridgeService';
import {
  BRIDGE_FEE_BUFFER,
  CLOB_FEE_RESERVE,
  MIN_BRIDGE_AMOUNT_USD,
  PUSD_ADDRESS
} from './polymarketConstants';
import {
  deriveSafeAddress,
  executeGaslessWithdrawal,
  transferPusdFromDepositWallet
} from './polymarketRelayerService';
import { getPolymarketBalanceSummary, placeOrder } from './polymarketTradingService';

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
    queue.on('idle', () => {
      // Delayed cleanup: wait 60s before deleting so rapid successive orders
      // don't lose committedUsdce tracking (fixes race condition).
      setTimeout(() => {
        if (queue.size === 0 && queue.pending === 0) {
          userOrderLocks.delete(userId);
        }
      }, 60_000);
    });
  }
  return entry;
}

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
    PUSD_ADDRESS,
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

    const walletType = user.polymarket_account.wallet_type ?? 'safe';
    const polygonWalletAddress = user.polymarket_account.polygon_address;

    // On-chain USDC.e balance check (catches sell proceeds + any idle balance)
    const provider = new ethers.providers.JsonRpcProvider(POLYMARKET_POLYGON_RPC_URL);
    const usdc = new ethers.Contract(
      PUSD_ADDRESS,
      ['function balanceOf(address) view returns (uint256)'],
      provider
    );

    // Snapshot idle balance before sell proceeds arrive
    const initialRawBalance: ethers.BigNumber = await usdc.balanceOf(polygonWalletAddress);
    const initialHuman = Number(ethers.utils.formatUnits(initialRawBalance, 6));
    Logger.log('info', fnLog, `${logKey} Initial idle USDC.e balance: $${initialHuman.toFixed(2)}`);

    // Wait for sell proceeds to arrive (balance must INCREASE above the idle amount).
    // Intervals: 3s → 10s → 20s → 30s (total ~63s max wait)
    const retryDelays = [3000, 10000, 20000, 30000];
    let rawBalance = initialRawBalance;

    for (let i = 0; i < retryDelays.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, retryDelays[i]));

      rawBalance = await usdc.balanceOf(polygonWalletAddress);
      const balanceHuman = Number(ethers.utils.formatUnits(rawBalance, 6));

      Logger.log(
        'info',
        fnLog,
        `${logKey} Polygon wallet USDC.e balance (attempt ${i + 1}/${retryDelays.length}): ${rawBalance.toString()} ($${balanceHuman.toFixed(2)})`
      );

      // Break when balance increases above initial (sell proceeds arrived)
      if (rawBalance.gt(initialRawBalance)) break;
    }

    const totalWaitSec = retryDelays.reduce((s, d) => s + d, 0) / 1000;

    if (rawBalance.lte(initialRawBalance)) {
      Logger.log(
        'warn',
        fnLog,
        `${logKey} No sell proceeds detected after ${retryDelays.length} polls (~${totalWaitSec}s). ` +
          `Balance unchanged at $${initialHuman.toFixed(2)}. This is expected for GTC orders that take longer to fill. ` +
          `Proceeds will remain in the Polygon wallet and will be bridged back automatically on the next purchase or via manual sync.`
      );
      if (purchaseId) {
        await updatePurchaseStep(purchaseId, 'withdrawal', { status: 'skipped' }, logKey);
      }
      return;
    }

    // Log whether we're including idle balance alongside sell proceeds
    if (initialRawBalance.gt(0)) {
      const proceedsOnly = rawBalance.sub(initialRawBalance);
      Logger.log(
        'info',
        fnLog,
        `${logKey} Bridging sell proceeds ($${Number(ethers.utils.formatUnits(proceedsOnly, 6)).toFixed(2)}) ` +
          `+ idle balance ($${initialHuman.toFixed(2)}) = $${Number(ethers.utils.formatUnits(rawBalance, 6)).toFixed(2)} total`
      );
    }

    const amount = rawBalance.toString();
    const balanceHuman = Number(ethers.utils.formatUnits(rawBalance, 6));

    // Determine which stablecoin the user holds on Scroll (USDC or USDT)
    const toToken = await getPreferredScrollStablecoin(proxyAddress, logKey);

    Logger.log(
      'info',
      fnLog,
      `${logKey} Withdrawing $${balanceHuman.toFixed(2)} USDC.e from Polygon ${walletType} wallet to Scroll proxy (→${toToken})`
    );

    // Bridge with one retry after 10s on failure.
    // Deposit wallet users: transfer pUSD to Safe first (relayer blocks LiFi approval
    // from deposit wallets), then bridge from Safe via the standard gasless path.
    const attemptBridge = async () => {
      let bridgeSourceAddress = polygonWalletAddress;

      if (walletType === 'deposit') {
        const safeAddress = deriveSafeAddress(new ethers.Wallet(privateKey).address);
        await transferPusdFromDepositWallet(
          privateKey,
          polygonWalletAddress,
          safeAddress,
          amount,
          logKey
        );
        bridgeSourceAddress = safeAddress;
      }

      const quote = await withdrawToScroll(
        bridgeSourceAddress,
        proxyAddress,
        amount,
        logKey,
        toToken
      );
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
    };

    try {
      await attemptBridge();
    } catch (bridgeError) {
      Logger.log('warn', fnLog, `${logKey} Bridge failed, retrying in 10s: ${String(bridgeError)}`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
      await attemptBridge();
    }

    Logger.log(
      'info',
      fnLog,
      `${logKey} Withdrawal initiated: $${balanceHuman.toFixed(2)} USDC.e → Scroll`
    );

    // Save withdrawal to transaction history
    await mongoTransactionService.saveTransaction({
      tx: `withdraw-${Date.now()}`,
      walletFrom: polygonWalletAddress,
      walletTo: proxyAddress,
      amount: balanceHuman,
      fee: 0,
      token: toToken,
      type: 'polymarket_withdraw',
      status: 'completed',
      chain_id: 137,
      user_notes: 'Polymarket withdrawal to Scroll'
    });

    if (purchaseId) {
      await updatePurchaseStep(purchaseId, 'withdrawal', { status: 'completed' }, logKey);
    }

    // WhatsApp notification — settlement claimed
    sendPolymarketSettlementClaimedNotification(user.phone_number, balanceHuman.toFixed(2)).catch(
      (err) => Logger.log('warn', fnLog, `${logKey} Settlement notification failed: ${String(err)}`)
    );
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
  /** Max bridge amount in human-readable USD (e.g. "5.00"). No cap applied if omitted. */
  bridgeAmountUsd?: string;
  /** Scroll token symbol to bridge from (e.g. "WETH"). Auto-detects stablecoin if omitted. */
  bridgeToken?: string;
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

        // Accept terms as part of account creation in the purchase flow.
        // Presence of termsVersion signals the user is accepting now; the
        // actual version recorded is always the latest (see acceptTerms).
        if (params.termsVersion) {
          currentUser = await acceptTerms(currentUser, logKey);
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
        // Subtract committed funds (GTC orders in flight) so bridge decision
        // matches the actual available balance at order placement time.
        const committedAtBridge = getOrderLock(currentUser.phone_number).committedUsdce;
        const availableBalance = Math.max(existingBalance - committedAtBridge, 0);
        const requiredUsdc = params.price * params.size;
        const deficit = requiredUsdc - availableBalance;

        Logger.log(
          'info',
          fnLog,
          `${logKey} Bridge check — required: $${requiredUsdc.toFixed(2)}, ` +
            `on-chain: $${existingBalance.toFixed(2)}, committed: $${committedAtBridge.toFixed(2)}, ` +
            `available: $${availableBalance.toFixed(2)}, deficit: $${deficit.toFixed(2)}`
        );

        if (deficit <= 0) {
          Logger.log(
            'info',
            fnLog,
            `${logKey} Skipping bridge: available balance ($${availableBalance.toFixed(2)}) ` +
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
        } else if (deficit < MIN_BRIDGE_AMOUNT_USD) {
          // Deficit below LiFi minimum — skip bridge, let order placement use the existing
          // balance with automatic size reduction to fit what's available.
          Logger.log(
            'info',
            fnLog,
            `${logKey} Skipping bridge: deficit $${deficit.toFixed(4)} < min $${MIN_BRIDGE_AMOUNT_USD}. ` +
              `Order will be size-adjusted to available balance ($${existingBalance.toFixed(2)}).`
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
          // Bridge the deficit + fee buffer, capped at client-authorized amount if provided.
          const deficitWithBuffer = deficit * BRIDGE_FEE_BUFFER;
          const actualBridgeAmountUsd = params.bridgeAmountUsd
            ? Math.min(deficitWithBuffer, Number(params.bridgeAmountUsd)).toFixed(6)
            : deficitWithBuffer.toFixed(6);

          Logger.log(
            'info',
            fnLog,
            `${logKey} Bridging deficit: $${deficitWithBuffer.toFixed(2)} USD ` +
              `(cap: ${params.bridgeAmountUsd ? `$${Number(params.bridgeAmountUsd).toFixed(2)}` : 'none'}, actual: $${actualBridgeAmountUsd})`
          );

          const bridgeResult = await executeBridge(
            currentUser,
            privateKey,
            actualBridgeAmountUsd,
            logKey,
            params.bridgeToken
          );

          // LiFi may report DONE before the Polygon RPC reflects the new balance.
          // Poll until balance increases from pre-bridge level (max 30s).
          const expectedMinBalance = existingBalance + Number(actualBridgeAmountUsd) * 0.85;
          for (let attempt = 0; attempt < 6; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            const confirmedBalance = await getPolygonUsdceBalance(safeAddress, logKey);
            if (confirmedBalance >= expectedMinBalance) break;
            Logger.log(
              'warn',
              fnLog,
              `${logKey} Bridge DONE but balance not yet reflected ($${confirmedBalance.toFixed(2)} < $${expectedMinBalance.toFixed(2)}), waiting...`
            );
          }

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

          // Save bridge to transaction history
          const bridgeAmountHuman = Number(actualBridgeAmountUsd);
          await mongoTransactionService.saveTransaction({
            tx: bridgeResult.txHash,
            walletFrom: currentUser.wallets[0]?.wallet_proxy || '',
            walletTo: safeAddress,
            amount: bridgeAmountHuman,
            fee: 0,
            token: bridgeResult.fromToken || 'USDC',
            type: 'polymarket_bridge',
            status: 'completed',
            chain_id: 534352,
            user_notes: `Polymarket ${params.side} bridge`
          });
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
          // Reserve CLOB_FEE_RESERVE (3%) headroom for the 2% CLOB taker fee + rounding.
          // Without this, placing an order for the exact balance causes "not enough balance/
          // allowance" because CLOB requires amount + fee_estimate <= balance.
          // Always cap at maxAffordableSize so CLOB fee (≈2-3%) never causes rejection.
          // Condition "available < requiredUsdc" alone is insufficient: even when balance
          // nominally covers the order amount, the CLOB adds a fee on top and rejects
          // if amount + fee_estimate > balance.
          const maxAffordableSize =
            Math.floor(((available * CLOB_FEE_RESERVE) / params.price) * 10000) / 10000;

          Logger.log(
            'info',
            fnLog,
            `${logKey} Balance check — on-chain: $${onChainBalance.toFixed(2)}, ` +
              `committed: $${lock.committedUsdce.toFixed(2)}, available: $${available.toFixed(2)}, ` +
              `required: $${requiredUsdc.toFixed(2)}, max affordable: ${maxAffordableSize}`
          );

          if (params.size > maxAffordableSize) {
            effectiveSize = maxAffordableSize;

            if (effectiveSize <= 0) {
              throw new Error(
                `Insufficient pUSD after bridge: $${available.toFixed(2)} available, ` +
                  `need $${requiredUsdc.toFixed(2)} for ${params.size} shares @ $${params.price}`
              );
            }

            // For FOK orders, CLOB V2 requires minimum $1 per marketable BUY.
            const isFok = params.orderType === 'FOK';
            const effectiveAmount = effectiveSize * params.price;
            if (isFok && effectiveAmount < 1.0) {
              throw new Error(
                `Insufficient pUSD for FOK order: $${available.toFixed(2)} available ` +
                  `(of $${onChainBalance.toFixed(2)} on-chain, $${lock.committedUsdce.toFixed(2)} committed). ` +
                  `Polymarket requires minimum $1.00 per FOK order.`
              );
            }

            Logger.log(
              'warn',
              fnLog,
              `${logKey} Adjusted order size: ${params.size} → ${effectiveSize} ` +
                `(max affordable with fee reserve: $${(maxAffordableSize * params.price).toFixed(2)})`
            );
          }
        }

        // Optimistically commit funds BEFORE placing the order so that
        // concurrent queued orders see the reserved amount even if the
        // service crashes after placeOrder succeeds but before returning.
        const commitAmount = params.side === 'BUY' ? effectiveSize * params.price : 0;
        lock.committedUsdce += commitAmount;

        let orderResult: { orderID: string };
        try {
          orderResult = await placeOrder(
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
        } catch (orderError) {
          // Roll back the optimistic commitment on failure
          lock.committedUsdce -= commitAmount;
          throw orderError;
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

      // Save order to transaction history
      await mongoTransactionService.saveTransaction({
        tx: orderID,
        walletFrom: freshUser.polymarket_account!.polygon_address,
        walletTo: 'polymarket',
        amount: params.price * effectiveSize,
        fee: 0,
        token: 'USDC',
        type: 'polymarket_order',
        status: 'completed',
        chain_id: 137,
        user_notes: `Polymarket ${params.side} order`
      });

      // WhatsApp notification — fire-and-forget (don't block the flow)
      sendPolymarketOrderPlacedNotification(
        freshUser.phone_number,
        params.side,
        effectiveSize.toString(),
        params.price.toString(),
        orderID
      ).catch((err) =>
        Logger.log('warn', fnLog, `${logKey} Order placed notification failed: ${String(err)}`)
      );

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

      // WhatsApp notification with balance — fire-and-forget
      (async () => {
        try {
          const polygonAddr = currentUser.polymarket_account?.polygon_address;
          let balanceStr = 'unknown';
          if (polygonAddr) {
            const { idle_usdc, positions_value } = await getPolymarketBalanceSummary(
              polygonAddr,
              logKey
            );
            balanceStr = `${(idle_usdc + positions_value).toFixed(2)}`;
          }
          await sendPolymarketOrderFailedNotification(
            currentUser.phone_number,
            params.side,
            String(error),
            balanceStr
          );
        } catch (notifErr) {
          Logger.log(
            'warn',
            fnLog,
            `${logKey} Order failed notification error: ${String(notifErr)}`
          );
        }
      })();
    }
  } catch (error) {
    // Catch-all for unexpected errors
    const errorMsg = `Unexpected error: ${String(error)}`;
    Logger.log('error', fnLog, `${logKey} ${errorMsg}`);
    await updatePurchaseStatus(purchaseId, 'failed', 'done', { error: errorMsg }, logKey);
  }
}

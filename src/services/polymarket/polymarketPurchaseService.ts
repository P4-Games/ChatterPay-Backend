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
  BRIDGE_BALANCE_POLL_INTERVAL_MS,
  BRIDGE_BALANCE_POLL_TIMEOUT_MS,
  BRIDGE_FEE_BUFFER,
  CLOB_FEE_RESERVE,
  CTF_ADDRESS,
  MIN_BRIDGE_AMOUNT_USD,
  POLYMARKET_MAX_PRICE,
  PUSD_ADDRESS,
  USDCE_ADDRESS,
  WITHDRAWABLE_STABLECOINS
} from './polymarketConstants';
import {
  discardSupersededOrder,
  enrichOrderModelSlug,
  markOrderInProgress,
  recordBridge,
  recordClaim,
  recordOrderFailed,
  recordOrderIntent,
  recordOrderPlaced,
  recordWithdraw,
  refineBuyToken,
  refineSellToken,
  USDCE_SYMBOL
} from './polymarketHistoryService';
import {
  getClobMarketInfo,
  getMarketByClobTokenId,
  getOutcomeForToken
} from './polymarketMarketService';
import {
  deriveSafeAddress,
  executeGaslessWithdrawal,
  executeRedeemPositions,
  type RedeemPosition,
  transferPusdFromDepositWallet
} from './polymarketRelayerService';
import { getPolymarketBalanceSummary, getPositions, placeOrder } from './polymarketTradingService';

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
 * Detect which stablecoin actually sits in a Polygon wallet.
 *
 * Redemptions pay out in the market's collateral: pUSD for CLOB-V2 markets,
 * USDC.e for legacy neg-risk markets. The withdrawal flow bridges whichever
 * one is present, so it must look at both. Returns the token holding the
 * largest balance (raw 6-decimal units), or pUSD with zero if the wallet is empty.
 */
async function getWithdrawableStablecoin(
  address: string,
  logKey: string
): Promise<{ address: string; symbol: string; raw: ethers.BigNumber }> {
  const fnLog = `[${LOG_PREFIX}:getWithdrawableStablecoin]`;
  const provider = new ethers.providers.JsonRpcProvider(POLYMARKET_POLYGON_RPC_URL);
  const balanceAbi = ['function balanceOf(address) view returns (uint256)'];

  const balances = await Promise.all(
    WITHDRAWABLE_STABLECOINS.map(async (token) => {
      const raw: ethers.BigNumber = await new ethers.Contract(
        token.address,
        balanceAbi,
        provider
      ).balanceOf(address);
      return { ...token, raw };
    })
  );

  // Pick the token with the largest balance (the actual proceeds; the rest is dust).
  const best = balances.reduce((a, b) => (b.raw.gt(a.raw) ? b : a));

  Logger.log(
    'info',
    fnLog,
    `${logKey} ${address} → ${balances
      .map((b) => `${b.symbol}: $${Number(ethers.utils.formatUnits(b.raw, 6)).toFixed(2)}`)
      .join(', ')} (selected ${best.symbol})`
  );

  return { address: best.address, symbol: best.symbol, raw: best.raw };
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
  purchaseId?: string,
  sellTrxHash?: string
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

    // Detect the withdrawable stablecoin (pUSD for V2 markets, USDC.e for legacy
    // neg-risk redemptions) and its on-chain balance. Redemption proceeds are
    // already settled by the time this runs, so we bridge whatever is present —
    // we don't wait for an INCREASE (that only applies to async GTC sell fills).
    let withdrawable = await getWithdrawableStablecoin(polygonWalletAddress, logKey);

    // If nothing is here yet, give an async sell fill a short window to land.
    // Intervals: 3s → 10s → 20s → 30s (total ~63s max wait). Stop as soon as a
    // bridgeable balance appears, so already-settled claims don't wait at all.
    const minRaw = ethers.utils.parseUnits(MIN_BRIDGE_AMOUNT_USD.toString(), 6);
    const retryDelays = [3000, 10000, 20000, 30000];

    for (let i = 0; i < retryDelays.length && withdrawable.raw.lt(minRaw); i++) {
      await new Promise((resolve) => setTimeout(resolve, retryDelays[i]));
      withdrawable = await getWithdrawableStablecoin(polygonWalletAddress, logKey);
      Logger.log(
        'info',
        fnLog,
        `${logKey} Waiting for proceeds (attempt ${i + 1}/${retryDelays.length}): ` +
          `${withdrawable.symbol} $${Number(ethers.utils.formatUnits(withdrawable.raw, 6)).toFixed(2)}`
      );
    }

    if (withdrawable.raw.lt(minRaw)) {
      Logger.log(
        'warn',
        fnLog,
        `${logKey} No bridgeable proceeds (${withdrawable.symbol} ` +
          `$${Number(ethers.utils.formatUnits(withdrawable.raw, 6)).toFixed(2)} < min $${MIN_BRIDGE_AMOUNT_USD}). ` +
          `Funds (if any) stay in the Polygon wallet and bridge on the next purchase or manual sync.`
      );
      if (purchaseId) {
        await updatePurchaseStep(purchaseId, 'withdrawal', { status: 'skipped' }, logKey);
      }
      return;
    }

    const fromTokenAddress = withdrawable.address;
    const amount = withdrawable.raw.toString();
    const balanceHuman = Number(ethers.utils.formatUnits(withdrawable.raw, 6));

    // Determine which stablecoin the user holds on Scroll (USDC or USDT)
    const toToken = await getPreferredScrollStablecoin(proxyAddress, logKey);

    Logger.log(
      'info',
      fnLog,
      `${logKey} Withdrawing $${balanceHuman.toFixed(2)} ${withdrawable.symbol} from Polygon ${walletType} wallet to Scroll proxy (→${toToken})`
    );

    // Bridge with one retry after 10s on failure.
    // Deposit wallet users: transfer the token to the Safe first (relayer blocks LiFi
    // approval from deposit wallets), then bridge from the Safe via the gasless path.
    const attemptBridge = async () => {
      let bridgeSourceAddress = polygonWalletAddress;

      if (walletType === 'deposit') {
        const safeAddress = deriveSafeAddress(new ethers.Wallet(privateKey).address);
        await transferPusdFromDepositWallet(
          privateKey,
          polygonWalletAddress,
          safeAddress,
          amount,
          logKey,
          fromTokenAddress
        );
        bridgeSourceAddress = safeAddress;
      }

      const quote = await withdrawToScroll(
        bridgeSourceAddress,
        proxyAddress,
        amount,
        logKey,
        toToken,
        fromTokenAddress
      );
      return await executeGaslessWithdrawal(
        privateKey,
        {
          approvalAddress: quote.approvalAddress,
          to: quote.to,
          data: quote.data,
          value: quote.value
        },
        amount,
        logKey,
        fromTokenAddress
      );
    };

    let txHash: string | undefined;
    try {
      txHash = await attemptBridge();
    } catch (bridgeError) {
      Logger.log('warn', fnLog, `${logKey} Bridge failed, retrying in 10s: ${String(bridgeError)}`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
      txHash = await attemptBridge();
    }

    Logger.log(
      'info',
      fnLog,
      `${logKey} Withdrawal initiated: $${balanceHuman.toFixed(2)} ${withdrawable.symbol} → Scroll (tx: ${txHash})`
    );

    // Save withdrawal to transaction history
    await recordWithdraw({
      txHash,
      walletFrom: polygonWalletAddress,
      walletTo: proxyAddress,
      amount: balanceHuman,
      token: toToken,
      linkedOrderTrxHash: sellTrxHash
    });

    // Refine the linked sell order record to show the Scroll-side token/amount
    // (what the user actually received), replacing the initial pUSD estimate.
    if (sellTrxHash) void refineSellToken(sellTrxHash, toToken, balanceHuman);

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

    // Record the order intent now that the Polymarket account (and its Polygon
    // address) is known. Status starts at `submitted` so a failure at the bridge
    // step still leaves a `failed` order row in the transaction history.
    // trx_hash is keyed on the purchaseId and stays stable across status updates.
    const orderTrx = await recordOrderIntent({
      side: params.side,
      refId: purchaseId,
      purchaseId,
      userProxy: currentUser.wallets[0]?.wallet_proxy || '',
      price: params.price,
      size: params.size,
      tokenId: params.tokenId,
      logKey
    });

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

          // Save bridge to transaction history immediately — the tx is on-chain
          // even if the balance confirmation below times out.
          // Passing `linkedOrderTrxHash` makes this patch the existing buy record
          // (as bridge sub-step fields) instead of inserting a separate bridge row.
          await recordBridge({
            txHash: bridgeResult.txHash,
            walletFrom: currentUser.wallets[0]?.wallet_proxy || '',
            walletTo: safeAddress,
            amount: Number(actualBridgeAmountUsd),
            token: bridgeResult.fromToken || 'USDC',
            side: params.side,
            linkedOrderTrxHash: orderTrx
          });

          // Refine the buy order record to show the Scroll-side token/amount
          // (what the user actually spent), replacing the initial pUSD estimate.
          void refineBuyToken(
            orderTrx,
            bridgeResult.fromToken || 'pUSD',
            Number(actualBridgeAmountUsd)
          );

          // LiFi may report DONE before the Polygon RPC reflects the new balance,
          // or its status API may lag the actual transfer. The on-chain balance
          // is the authoritative confirmation — poll it until the funds arrive.
          // If they never do within the window, fail here instead of proceeding
          // to order placement with $0 available.
          const expectedMinBalance = existingBalance + Number(actualBridgeAmountUsd) * 0.85;
          const pollDeadline = Date.now() + BRIDGE_BALANCE_POLL_TIMEOUT_MS;
          let balanceConfirmed = false;
          while (Date.now() < pollDeadline) {
            await new Promise((resolve) => {
              setTimeout(resolve, BRIDGE_BALANCE_POLL_INTERVAL_MS);
            });
            const confirmedBalance = await getPolygonUsdceBalance(safeAddress, logKey);
            if (confirmedBalance >= expectedMinBalance) {
              balanceConfirmed = true;
              break;
            }
            Logger.log(
              'warn',
              fnLog,
              `${logKey} Bridge sent but balance not yet reflected ($${confirmedBalance.toFixed(2)} < $${expectedMinBalance.toFixed(2)}), waiting...`
            );
          }

          if (!balanceConfirmed) {
            throw new Error(
              `Bridged funds (tx ${bridgeResult.txHash}) have not arrived on Polygon after ` +
                `${Math.round(BRIDGE_BALANCE_POLL_TIMEOUT_MS / 1000)}s. The transfer is still in transit — ` +
                `the funds will be credited to your Polymarket balance shortly. ` +
                `Retry the order once they arrive (no new bridge will be needed).`
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
        // The order never reached the CLOB — mark its history record failed.
        await recordOrderFailed(orderTrx, errorMsg);
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

        // Placement is now underway — move the order history record to in_progress.
        await markOrderInProgress(orderTrx);

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
        token_id: params.tokenId,
        side: params.side,
        price: params.price,
        size: effectiveSize,
        status: 'pending'
      });
      void enrichOrderModelSlug(orderID, params.tokenId, logKey);

      await updatePurchaseStep(
        purchaseId,
        'order_placement',
        { status: 'completed', order_id: orderID },
        logKey
      );
      Logger.log('info', fnLog, `${logKey} Order placed: ${orderID} (size: ${effectiveSize})`);

      // Order accepted by the CLOB — evolve the history record to completed,
      // attach the real CLOB order id, and rewrite the amount to the effective
      // (possibly auto-reduced) size. Async fills refine this later via syncOpenOrders.
      await recordOrderPlaced(orderTrx, {
        orderId: orderID,
        price: params.price,
        effectiveSize
      });

      // WhatsApp notification — fire-and-forget (don't block the flow).
      // Market question/outcome are fetched best-effort to make the message
      // identifiable ("Will X happen? — Yes") instead of just a token ID.
      (async () => {
        let marketQuestion = '';
        let outcome = '';
        try {
          const market = await getMarketByClobTokenId(params.tokenId, logKey);
          if (market) {
            marketQuestion = market.question;
            outcome = getOutcomeForToken(market, params.tokenId);
          }
        } catch (marketError) {
          Logger.log(
            'warn',
            fnLog,
            `${logKey} Market lookup for notification failed: ${String(marketError)}`
          );
        }

        await sendPolymarketOrderPlacedNotification(
          freshUser.phone_number,
          params.side,
          effectiveSize.toString(),
          params.price.toString(),
          orderID,
          marketQuestion,
          outcome,
          (effectiveSize * params.price).toFixed(2)
        );
      })().catch((err) =>
        Logger.log('warn', fnLog, `${logKey} Order placed notification failed: ${String(err)}`)
      );

      // ── Step 4 (SELL only): Withdrawal ──────────────────────────────────
      // After a SELL fills, USDC.e lands in the Polygon Safe. Bridge it back
      // to the user's Scroll proxy automatically, tracking the step progress.
      if (params.side === 'SELL') {
        Logger.log('info', fnLog, `${logKey} Starting SELL proceeds withdrawal`);
        await updatePurchaseStatus(purchaseId, 'processing', 'withdrawal', undefined, logKey);
        await updatePurchaseStep(purchaseId, 'withdrawal', { status: 'in_progress' }, logKey);

        await withdrawSellProceeds(freshUser, privateKey, logKey, purchaseId, orderTrx);
      }

      // Mark entire purchase as completed
      await updatePurchaseStatus(purchaseId, 'completed', 'done', { order_id: orderID }, logKey);
      Logger.log('info', fnLog, `${logKey} Purchase completed. Order: ${orderID}`);
    } catch (error) {
      const errorMsg = `Order placement failed: ${String(error)}`;
      Logger.log('error', fnLog, `${logKey} ${errorMsg}`);

      // SELL at boundary price → market likely resolved. Attempt CTF claim before
      // marking the purchase as failed, mirroring the synchronous sell endpoint's fallback.
      if (params.side === 'SELL' && params.price >= POLYMARKET_MAX_PRICE) {
        try {
          Logger.log(
            'warn',
            fnLog,
            `${logKey} SELL at boundary price (${params.price}) failed — attempting CTF claim fallback`
          );
          const marketInfo = await getMarketByClobTokenId(params.tokenId, logKey).catch(() => null);
          const claimResult = await claimWinningPositions(
            currentUser,
            privateKey,
            logKey,
            marketInfo?.conditionId
          );
          if (claimResult.claimed > 0) {
            // The claim record (created inside claimWinningPositions) is now the
            // source of truth — drop the redundant SELL row so the user sees a
            // single "settlement" entry instead of a phantom failed sell.
            await discardSupersededOrder(orderTrx);
            await updatePurchaseStatus(purchaseId, 'completed', 'done', undefined, logKey);
            Logger.log(
              'info',
              fnLog,
              `${logKey} SELL superseded by claim: ${claimResult.claimed} position(s) claimed (tx: ${claimResult.txHash})`
            );
            return;
          }
        } catch (claimError) {
          Logger.log(
            'warn',
            fnLog,
            `${logKey} Claim fallback after failed SELL failed: ${String(claimError)}`
          );
        }
      }

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
      await recordOrderFailed(orderTrx, errorMsg);

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

// ============================================================================
// Claim Winning Positions
// ============================================================================

const CTF_ERC1155_BALANCE_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)'
];

const CTF_RESOLUTION_ABI = [
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)'
];

const CTF_POSITION_ABI = [
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
  'function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)'
];

/**
 * Read the raw on-chain ERC-1155 balance of a CTF outcome token.
 * `tokenId` is the position id (DataPosition.asset). Returns 0 on RPC failure
 * so a single unreadable position can't abort the whole claim batch.
 */
async function getCtfTokenBalance(
  owner: string,
  tokenId: string,
  logKey: string
): Promise<ethers.BigNumber> {
  const fnLog = `[${LOG_PREFIX}:getCtfTokenBalance]`;
  try {
    const provider = new ethers.providers.JsonRpcProvider(POLYMARKET_POLYGON_RPC_URL);
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ERC1155_BALANCE_ABI, provider);
    return await ctf.balanceOf(owner, tokenId);
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed to read CTF balance: ${String(error)}`);
    return ethers.constants.Zero;
  }
}

/**
 * Check whether a CTF condition has been finalized on-chain.
 * payoutDenominator > 0 means the oracle has reported and funds can be redeemed.
 * Returns true on RPC failure so a network blip never blocks a legitimate claim.
 */
async function isCtfMarketResolved(conditionId: string, logKey: string): Promise<boolean> {
  const fnLog = `[${LOG_PREFIX}:isCtfMarketResolved]`;
  try {
    const provider = new ethers.providers.JsonRpcProvider(POLYMARKET_POLYGON_RPC_URL);
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_RESOLUTION_ABI, provider);
    const denom: ethers.BigNumber = await ctf.payoutDenominator(conditionId);
    return !denom.isZero();
  } catch (error) {
    Logger.log(
      'warn',
      fnLog,
      `${logKey} Could not read payoutDenominator for ${conditionId}: ${String(error)} — assuming resolved`
    );
    return true;
  }
}

/**
 * Determine which collateral token a standard CTF position settles in.
 *
 * The collateral is baked into the ERC-1155 position id, so we recompute the
 * position id for each candidate stablecoin (pUSD for CLOB-V2 markets, USDC.e for
 * legacy markets) and return the one matching the token the user actually holds.
 * Redeeming with the wrong collateral burns 0 tokens and pays out nothing while the
 * tx still confirms — the exact failure that left winning positions un-redeemable.
 * Defaults to pUSD if nothing matches (e.g. RPC failure).
 */
async function resolveCtfCollateral(
  conditionId: string,
  indexSet: number,
  heldAsset: string,
  logKey: string
): Promise<string> {
  const fnLog = `[${LOG_PREFIX}:resolveCtfCollateral]`;
  try {
    const provider = new ethers.providers.JsonRpcProvider(POLYMARKET_POLYGON_RPC_URL);
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_POSITION_ABI, provider);
    const collectionId: string = await ctf.getCollectionId(
      ethers.constants.HashZero,
      conditionId,
      indexSet
    );
    const held = ethers.BigNumber.from(heldAsset);
    const candidates = [
      { address: PUSD_ADDRESS, symbol: 'pUSD' },
      { address: USDCE_ADDRESS, symbol: 'USDC.e' }
    ];
    for (const { address, symbol } of candidates) {
      const posId: ethers.BigNumber = await ctf.getPositionId(address, collectionId);
      if (posId.eq(held)) {
        Logger.log('info', fnLog, `${logKey} Condition ${conditionId} settles in ${symbol}`);
        return address;
      }
    }
    Logger.log(
      'warn',
      fnLog,
      `${logKey} No collateral matched position ${heldAsset} for ${conditionId} — defaulting to pUSD`
    );
    return PUSD_ADDRESS;
  } catch (error) {
    Logger.log(
      'warn',
      fnLog,
      `${logKey} Collateral resolution failed for ${conditionId}: ${String(error)} — defaulting to pUSD`
    );
    return PUSD_ADDRESS;
  }
}

/**
 * Redeem all winning CTF positions for a user and auto-withdraw proceeds to Scroll.
 *
 * Positions with curPrice >= 0.999 are resolved-and-won. For each we call
 * CTF.redeemPositions() via the gasless Relayer (batched into one tx).
 * neg-risk markets redeem through the NegRiskAdapter instead, using the exact
 * on-chain token balance of the winning outcome.
 *
 * After redemption the collateral (pUSD for V2 markets, USDC.e for legacy
 * neg-risk markets) lands in the deposit wallet, and withdrawSellProceeds fires
 * to bridge whichever token arrived back to Scroll automatically. The sweep also
 * runs when nothing new is redeemable, to pick up proceeds settled on a prior run.
 */
export async function claimWinningPositions(
  user: IUser,
  privateKey: string,
  logKey: string,
  onlyConditionId?: string
): Promise<{ claimed: number; txHash?: string }> {
  const fnLog = `[${LOG_PREFIX}:claimWinningPositions]`;

  if (!user.polymarket_account) throw new Error('No Polymarket account');

  const polygonAddress = user.polymarket_account.polygon_address;

  // Always attempt to sweep any already-settled proceeds back to Scroll, even
  // when there's nothing new to redeem. Redemptions confirmed on a prior run
  // leave the collateral (pUSD or legacy USDC.e) idle in the deposit wallet;
  // without this, those funds would be stranded until the next purchase.
  const sweepProceeds = () =>
    withdrawSellProceeds(user, privateKey, logKey).catch((err) => {
      Logger.log(
        'error',
        fnLog,
        `${logKey} Background withdrawal after claim failed: ${String(err)}`
      );
    });

  const positions = await getPositions(polygonAddress, logKey);
  const winning = positions
    .filter((p) => (p.curPrice ?? 0) >= 0.999)
    .filter((p) => !onlyConditionId || p.conditionId === onlyConditionId);

  if (winning.length === 0) {
    Logger.log(
      'info',
      fnLog,
      `${logKey} No winning positions found — sweeping any settled proceeds`
    );
    sweepProceeds();
    return { claimed: 0 };
  }

  Logger.log('info', fnLog, `${logKey} Found ${winning.length} winning position(s)`);

  const toRedeem = (
    await Promise.all(
      winning.map(async (p) => {
        const outcome = (p.outcome ?? '').toLowerCase();
        let indexSet: number;
        if (outcome === 'yes') {
          indexSet = 1;
        } else if (outcome === 'no') {
          indexSet = 2;
        } else {
          Logger.log(
            'warn',
            fnLog,
            `${logKey} Unknown outcome "${p.outcome}" — skipping conditionId ${p.conditionId}`
          );
          return null;
        }

        // Gate on on-chain resolution: payoutDenominator > 0 means the oracle
        // has finalized the outcome. Without this the CLOB can show 100¢ while
        // redeemPositions() reverts silently, burning gas and recording a phantom claim.
        const resolved = await isCtfMarketResolved(p.conditionId, logKey);
        if (!resolved) {
          Logger.log(
            'warn',
            fnLog,
            `${logKey} Market ${p.conditionId} shows price≥0.999 on CLOB but is NOT yet resolved on-chain — skipping`
          );
          return null;
        }

        // neg-risk markets redeem via the NegRiskAdapter, which needs the exact raw
        // token balance of the winning outcome (not just an index set).
        let negRisk = false;
        try {
          const clobInfo = await getClobMarketInfo(p.conditionId, logKey);
          negRisk = Boolean((clobInfo as { neg_risk?: boolean }).neg_risk);
        } catch {
          // CLOB info unavailable — assume binary CTF and proceed optimistically
        }

        if (negRisk) {
          const rawAmount = await getCtfTokenBalance(polygonAddress, p.asset, logKey);
          if (rawAmount.isZero()) {
            Logger.log(
              'warn',
              fnLog,
              `${logKey} Neg-risk position ${p.conditionId} has zero on-chain balance — skipping`
            );
            return null;
          }
          return {
            conditionId: p.conditionId,
            indexSet,
            negRisk: true,
            amount: rawAmount.toString()
          } as RedeemPosition;
        }

        // Standard binary CTF: also verify on-chain balance before redeeming.
        // The Data API price (>= 0.999) only means the market resolved; it does NOT
        // confirm the deposit wallet still holds the outcome tokens. Without this
        // check, we'd fire a redeemPositions(0) that burns gas, records a phantom
        // claim, and leaves pUSD = $0 — the same position keeps appearing forever.
        const stdBalance = await getCtfTokenBalance(polygonAddress, p.asset, logKey);
        if (stdBalance.isZero()) {
          Logger.log(
            'warn',
            fnLog,
            `${logKey} Standard CTF position ${p.conditionId} has zero on-chain balance — skipping`
          );
          return null;
        }

        // Resolve the market's collateral (pUSD vs legacy USDC.e). Redeeming with the
        // wrong token burns 0 and pays out nothing while the tx still confirms.
        const collateralToken = await resolveCtfCollateral(
          p.conditionId,
          indexSet,
          p.asset,
          logKey
        );

        return { conditionId: p.conditionId, indexSet, collateralToken } as RedeemPosition;
      })
    )
  ).filter((r): r is RedeemPosition => r !== null);

  if (toRedeem.length === 0) {
    // Nothing newly redeemable, but prior-run proceeds may still be idle — sweep.
    sweepProceeds();
    return { claimed: 0 };
  }

  const txHash = await executeRedeemPositions(privateKey, polygonAddress, toRedeem, logKey);

  // Record the claim in transaction history (IN: proceeds land on Polygon).
  // Amount is the USD value of the winning positions being redeemed.
  // Token: legacy neg-risk markets redeem to USDC.e; standard CLOB V2 markets redeem to pUSD.
  // Only sum positions that passed the on-chain balance check (i.e., are in toRedeem).
  const redeemConditionIds = new Set(toRedeem.map((r) => r.conditionId));
  const claimedValue = winning
    .filter((p) => redeemConditionIds.has(p.conditionId))
    .reduce((sum, p) => sum + (p.currentValue ?? 0), 0);
  // Label the history record with the collateral that actually pays out: USDC.e for
  // neg-risk or legacy standard markets, pUSD (undefined → default) otherwise.
  const paysUsdce = toRedeem.some((r) => r.negRisk || r.collateralToken === USDCE_ADDRESS);
  const claimToken = paysUsdce ? USDCE_SYMBOL : undefined;
  await recordClaim({
    userProxy: user.wallets[0]?.wallet_proxy || '',
    amount: claimedValue,
    txHash,
    token: claimToken
  });

  // Auto-withdraw redeemed proceeds back to Scroll (fire-and-forget, same as SELL
  // flow). Link the withdrawal to the claim record above so its bridge leg is
  // embedded inline (one unified "settlement" row) instead of emitting a second
  // standalone polymarket_withdraw row for the same logical claim.
  void withdrawSellProceeds(user, privateKey, logKey, undefined, txHash).catch((err) =>
    Logger.log('error', fnLog, `${logKey} Background withdrawal after claim failed: ${String(err)}`)
  );

  return { claimed: toRedeem.length, txHash };
}

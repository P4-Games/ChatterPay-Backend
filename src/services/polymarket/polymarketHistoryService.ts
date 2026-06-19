/**
 * Polymarket Transaction History Service
 *
 * Single chokepoint for recording every Polymarket activity into the generic
 * transaction history (the `transactions` collection). Centralizing here keeps
 * the service-layer flow (executePurchase / withdrawSellProceeds /
 * claimWinningPositions) and the direct controller endpoints from drifting or
 * double-recording.
 *
 * Conventions:
 *   - The user side is always the user's Scroll proxy wallet (the address the
 *     transaction history filters by — same as the bridge/withdraw records).
 *     Using the Polygon account address here would make these rows invisible in
 *     the user's history. Direction (IN/OUT) is set from the order `side`:
 *       BUY   → proxy → 'polymarket'        (OUT)
 *       SELL  → 'polymarket' → proxy        (IN)
 *       CLAIM → 'polymarket' → proxy        (IN)
 *   - Orders use a stable synthetic trx_hash (`pm-order-<refId>`) so the same
 *     row can evolve in place: submitted → in_progress → completed | failed,
 *     and later filled | partial | cancelled. The real CLOB order id is stored
 *     in `polymarket_order_id` (never in trx_hash).
 *   - Claims use their real on-chain txHash.
 *   - All writes are best-effort / non-throwing (delegated to mongoTransactionService).
 */

import { randomUUID } from 'crypto';

import { updateOrderSlug } from '../mongo/mongoPolymarketService';
import { mongoTransactionService } from '../mongo/mongoTransactionService';
import { getMarketByClobTokenId, getOutcomeForToken } from './polymarketMarketService';

const POLYGON_CHAIN_ID = 137;
const SCROLL_CHAIN_ID = 534352;

/** Collateral token for standard Polymarket CLOB V2 orders (pUSD on Polygon). */
export const PUSD_SYMBOL = 'pUSD';
/** Legacy neg-risk market collateral (bridged USDC on Polygon). */
export const USDCE_SYMBOL = 'USDC.e';

/** Counterparty placeholder used as wallet_from/wallet_to for the Polymarket side. */
export const POLYMARKET_COUNTERPARTY = 'polymarket';

export type OrderSide = 'BUY' | 'SELL';

/** Build the stable synthetic trx_hash for an order lifecycle record. */
export function orderTrxHash(refId: string): string {
  return `pm-order-${refId}`;
}

export interface OrderIntentParams {
  side: OrderSide;
  /** Stable id for the order lifecycle: purchaseId (purchase flow) or a uuid (direct endpoint). */
  refId: string;
  /** The user's Scroll proxy wallet — the address the history filters by (NOT the Polygon account). */
  userProxy: string;
  price: number;
  size: number;
  /** CLOB token id — used to resolve the market name/outcome for the history label. */
  tokenId: string;
  logKey: string;
  purchaseId?: string;
}

/** Generic order note used until the market name is resolved in the background. */
function placeholderNote(side: OrderSide): string {
  return `Polymarket ${side} order`;
}

/**
 * Resolve the market name/outcome and attach it to an already-recorded order in
 * the background. Best-effort: the Gamma lookup is cached but may be cold on the
 * first order for a token, so it is deliberately NOT awaited on the order path —
 * we never make the user wait on (or fail because of) the markets API.
 */
export async function enrichOrderMarket(
  trxHash: string,
  side: OrderSide,
  tokenId: string,
  logKey: string
): Promise<void> {
  try {
    const market = await getMarketByClobTokenId(tokenId, logKey);
    if (!market) return;
    const outcome = getOutcomeForToken(market, tokenId);
    const label = (
      outcome ? `${side}: ${market.question} (${outcome})` : `${side}: ${market.question}`
    ).slice(0, 500);
    await mongoTransactionService.setOrderMarket(
      trxHash,
      label,
      market.slug,
      placeholderNote(side)
    );
  } catch {
    // best-effort — the generic note stays
  }
}

/**
 * Record an order intent (status `submitted`). wallet_from/wallet_to are fixed
 * here from `side` and must never change afterwards (they are part of the unique
 * index). The market name/slug is resolved and attached in the background so the
 * order path never blocks on the markets API. Returns the trx_hash for
 * subsequent lifecycle updates.
 */
export async function recordOrderIntent(p: OrderIntentParams): Promise<string> {
  const trxHash = orderTrxHash(p.refId);
  const isBuy = p.side === 'BUY';

  await mongoTransactionService.upsertTransaction({
    tx: trxHash,
    walletFrom: isBuy ? p.userProxy : POLYMARKET_COUNTERPARTY,
    walletTo: isBuy ? POLYMARKET_COUNTERPARTY : p.userProxy,
    amount: p.price * p.size,
    fee: 0,
    token: PUSD_SYMBOL,
    type: isBuy ? 'polymarket_buy' : 'polymarket_sell',
    status: 'submitted',
    chain_id: POLYGON_CHAIN_ID,
    user_notes: placeholderNote(p.side),
    polymarket_purchase_id: p.purchaseId,
    polymarket_size: p.size
  });

  // Fire-and-forget: enrich with the market name without blocking the order path.
  void enrichOrderMarket(trxHash, p.side, p.tokenId, p.logKey);

  return trxHash;
}

/** Move an order intent to `in_progress` (placement underway). */
export async function markOrderInProgress(trxHash: string): Promise<void> {
  await mongoTransactionService.updateTransactionStatus(trxHash, 'in_progress');
}

/**
 * Mark an order as placed (accepted by the CLOB). Stores the real CLOB order id
 * and rewrites the amount to the effective (possibly auto-reduced) size.
 */
export async function recordOrderPlaced(
  trxHash: string,
  p: { orderId: string; price: number; effectiveSize: number; status?: string }
): Promise<void> {
  await mongoTransactionService.updateTransactionStatus(trxHash, p.status ?? 'completed', {
    amount: p.price * p.effectiveSize,
    polymarket_order_id: p.orderId,
    polymarket_size: p.effectiveSize
  });
}

/** Mark an order attempt as failed, recording the error. */
export async function recordOrderFailed(trxHash: string, error: string): Promise<void> {
  await mongoTransactionService.updateTransactionStatus(trxHash, 'failed', {
    user_notes: `Polymarket order failed: ${error}`.slice(0, 500)
  });
}

/**
 * Mark an order attempt as cancelled (e.g. a SELL on a resolved market that is
 * superseded by a CTF claim). Distinct from `failed` so the user isn't shown a
 * scary error for an action that actually succeeded as a claim.
 */
export async function recordOrderCancelled(trxHash: string, note?: string): Promise<void> {
  await mongoTransactionService.updateTransactionStatus(
    trxHash,
    'cancelled',
    note ? { user_notes: note } : {}
  );
}

/** Record a claim (CTF redemption of winning positions) — proceeds attributed to the user. */
export async function recordClaim(p: {
  userProxy: string;
  amount: number;
  txHash: string;
  /** Stablecoin received: 'pUSD' for standard CLOB V2, 'USDC.e' for legacy neg-risk markets. */
  token?: string;
}): Promise<void> {
  await mongoTransactionService.saveTransaction({
    tx: p.txHash,
    walletFrom: POLYMARKET_COUNTERPARTY,
    walletTo: p.userProxy,
    amount: p.amount,
    fee: 0,
    token: p.token ?? PUSD_SYMBOL,
    type: 'polymarket_claim',
    status: 'completed',
    chain_id: POLYGON_CHAIN_ID,
    user_notes: 'Polymarket winnings claimed'
  });
}

/** Record the Scroll→Polygon bridge that funds a purchase.
 *
 * When `linkedOrderTrxHash` is provided (purchase flow), the bridge data is
 * attached inline to the existing buy/sell order record as `polymarket_bridge_*`
 * fields — **no separate history row is created**. This keeps the user's history
 * clean: one purchase = one row with expandable bridge detail.
 *
 * When `linkedOrderTrxHash` is omitted (manual bridge endpoint), the legacy
 * behaviour is preserved and a standalone `polymarket_bridge` record is inserted.
 */
export async function recordBridge(p: {
  txHash: string;
  walletFrom: string;
  walletTo: string;
  amount: number;
  token: string;
  side: OrderSide;
  /** trx_hash of the buy/sell order record to attach the bridge data to. */
  linkedOrderTrxHash?: string;
}): Promise<void> {
  if (p.linkedOrderTrxHash) {
    // Purchase flow: patch the order record with bridge detail instead of
    // creating a separate polymarket_bridge row.
    await mongoTransactionService.patchTransactionFields(p.linkedOrderTrxHash, {
      polymarket_bridge_tx_hash: p.txHash,
      polymarket_bridge_amount: p.amount,
      polymarket_bridge_token: p.token
    });
    return;
  }

  // Manual bridge endpoint: create a standalone bridge record (legacy behaviour).
  await mongoTransactionService.saveTransaction({
    tx: p.txHash,
    walletFrom: p.walletFrom,
    walletTo: p.walletTo,
    amount: p.amount,
    fee: 0,
    token: p.token,
    type: 'polymarket_bridge',
    status: 'completed',
    chain_id: SCROLL_CHAIN_ID,
    user_notes: `Polymarket ${p.side} bridge`
  });
}

/** Record the Polygon→Scroll withdrawal of proceeds. */
export async function recordWithdraw(p: {
  txHash?: string;
  walletFrom: string;
  walletTo: string;
  amount: number;
  token: string;
  linkedOrderTrxHash?: string;
}): Promise<void> {
  const txHash = p.txHash || `withdraw-${randomUUID()}`;

  if (p.linkedOrderTrxHash) {
    await mongoTransactionService.patchTransactionFields(p.linkedOrderTrxHash, {
      polymarket_bridge_tx_hash: txHash,
      polymarket_bridge_amount: p.amount,
      polymarket_bridge_token: p.token
    });
    return;
  }

  await mongoTransactionService.saveTransaction({
    tx: txHash,
    walletFrom: p.walletFrom,
    walletTo: p.walletTo,
    amount: p.amount,
    fee: 0,
    token: p.token,
    type: 'polymarket_withdraw',
    status: 'completed',
    chain_id: POLYGON_CHAIN_ID,
    user_notes: 'Polymarket withdrawal to Scroll'
  });
}

/**
 * Refine a `polymarket_buy` record after the bridge completes. Updates token to the
 * Scroll-side source token and amount to the actual bridge amount (what the user spent
 * from their Scroll wallet). Non-blocking; called fire-and-forget after recordBridge.
 */
export async function refineBuyToken(
  trxHash: string,
  token: string,
  amount: number
): Promise<void> {
  await mongoTransactionService.patchTransactionFields(trxHash, { token, amount });
}

/**
 * Refine a `polymarket_sell` record after the proceeds reach Scroll. Updates token to
 * the Scroll-side received token and amount to what actually arrived (post-bridge fees).
 * Non-blocking; called fire-and-forget after recordWithdraw in withdrawSellProceeds.
 */
export async function refineSellToken(
  trxHash: string,
  token: string,
  amount: number
): Promise<void> {
  await mongoTransactionService.patchTransactionFields(trxHash, { token, amount });
}

/**
 * Resolve the market slug and attach it to a PolymarketOrderModel document in the
 * background. Symmetric with enrichOrderMarket but targets the orders collection
 * instead of the transactions collection. The Gamma lookup is cached so concurrent
 * calls for the same token are effectively free. Non-throwing.
 */
export async function enrichOrderModelSlug(
  orderId: string,
  tokenId: string,
  logKey: string
): Promise<void> {
  try {
    const market = await getMarketByClobTokenId(tokenId, logKey);
    if (!market?.slug) return;
    await updateOrderSlug(orderId, market.slug);
  } catch {
    // best-effort
  }
}

/** Map a PolymarketOrderModel status to the transaction-history status. */
export function mapClobStatusToTxStatus(clobStatus: string): string {
  switch (clobStatus) {
    case 'filled':
      return 'completed';
    case 'partial':
      return 'partial';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    default:
      return clobStatus;
  }
}

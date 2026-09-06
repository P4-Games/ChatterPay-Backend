import { type Document, model, Schema } from 'mongoose';

export interface ITransaction extends Document {
  trx_hash: string;
  wallet_from: string;
  wallet_to: string;
  type: string;
  date: Date;
  status: string;
  amount: number;
  fee: number;
  token: string;
  chain_id: number;
  user_notes: string;
  /**
   * Network fee the chain actually charged, in the network's own coin.
   *
   * Distinct from `fee`, which is the ChatterPay fee taken in the token being moved. On EVM the two
   * never coexist: the paymaster absorbs the network cost and the user never sees it. On Cardano
   * the sender pays the network directly out of the inputs of their own transaction, so a history
   * that only showed `fee` would hide a cost the user really paid.
   */
  network_fee?: number;
  /** Coin `network_fee` is denominated in, e.g. `ADA`. */
  network_fee_token?: string;
  /**
   * ADA the ledger forced to travel with a token, on a Cardano token transfer.
   *
   * Not a fee and not ours: the recipient keeps it. It is recorded because it is the only figure
   * that explains why sending USDCx also moved ADA — without it the sender's ADA balance drops by
   * something no line of the history accounts for, which is a support ticket every time.
   */
  attached_ada?: number;
  /** CLOB order id for Polymarket order transactions (links to PolymarketOrderModel). */
  polymarket_order_id?: string;
  /** Purchase flow id for Polymarket order transactions (links to PolymarketPurchaseModel). */
  polymarket_purchase_id?: string;
  /** Market slug for Polymarket order transactions (lets the frontend deep-link the market). */
  polymarket_market_slug?: string;
  /** Number of shares bought/sold in a Polymarket order (distinct from amount which is cost in stablecoin). */
  polymarket_size?: number;
  /**
   * Polymarket BUY — bridge sub-step (Scroll → Polygon).
   * Stored inline on the buy record; no separate `polymarket_bridge` row is created
   * for purchases that go through the unified purchase flow.
   */
  polymarket_bridge_tx_hash?: string;
  /** Human-readable amount that left the user's Scroll wallet for the bridge. */
  polymarket_bridge_amount?: number;
  /** Scroll-side stablecoin used for the bridge (e.g. 'USDT', 'USDC'). */
  polymarket_bridge_token?: string;
}

const transactionSchema = new Schema<ITransaction>({
  trx_hash: { type: String, required: true },
  wallet_from: { type: String, required: true },
  wallet_to: { type: String, required: true },
  type: { type: String, required: true },
  date: { type: Date, required: true },
  status: { type: String, required: true },
  amount: { type: Number, required: true },
  fee: { type: Number, required: true },
  token: { type: String, required: true },
  chain_id: { type: Number, required: true },
  user_notes: { type: String, required: false },
  network_fee: { type: Number, required: false },
  network_fee_token: { type: String, required: false },
  attached_ada: { type: Number, required: false },
  polymarket_order_id: { type: String, required: false },
  polymarket_purchase_id: { type: String, required: false },
  polymarket_market_slug: { type: String, required: false },
  polymarket_size: { type: Number, required: false },
  polymarket_bridge_tx_hash: { type: String, required: false },
  polymarket_bridge_amount: { type: Number, required: false },
  polymarket_bridge_token: { type: String, required: false }
});

transactionSchema.index(
  { trx_hash: 1, wallet_from: 1, wallet_to: 1 },
  { name: 'trx_hash_wallet_from_to', unique: true }
);

// Lookup path for async fill updates (syncOpenOrders) — sparse so only order
// transactions that carry a CLOB order id are indexed.
transactionSchema.index({ polymarket_order_id: 1 }, { sparse: true });

const Transaction = model<ITransaction>('Transaction', transactionSchema, 'transactions');

export default Transaction;

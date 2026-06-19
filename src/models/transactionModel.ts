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
  /** CLOB order id for Polymarket order transactions (links to PolymarketOrderModel). */
  polymarket_order_id?: string;
  /** Purchase flow id for Polymarket order transactions (links to PolymarketPurchaseModel). */
  polymarket_purchase_id?: string;
  /** Market slug for Polymarket order transactions (lets the frontend deep-link the market). */
  polymarket_market_slug?: string;
  /** Number of shares bought/sold in a Polymarket order (distinct from amount which is cost in stablecoin). */
  polymarket_size?: number;
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
  polymarket_order_id: { type: String, required: false },
  polymarket_purchase_id: { type: String, required: false },
  polymarket_market_slug: { type: String, required: false },
  polymarket_size: { type: Number, required: false }
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

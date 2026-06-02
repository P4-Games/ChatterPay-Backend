import { type Document, model, Schema } from 'mongoose';

// ============================================================================
// Polymarket Terms
// ============================================================================

export interface IPolymarketTerms extends Document {
  version: number;
  content: string;
  effective_date: Date;
  created_at: Date;
}

const polymarketTermsSchema = new Schema<IPolymarketTerms>({
  version: { type: Number, required: true, unique: true },
  content: { type: String, required: true },
  effective_date: { type: Date, required: true },
  created_at: { type: Date, required: true, default: Date.now }
});

export const PolymarketTermsModel = model<IPolymarketTerms>(
  'PolymarketTerms',
  polymarketTermsSchema,
  'polymarket_terms'
);

// ============================================================================
// Polymarket Order History
// ============================================================================

export type PolymarketOrderStatus = 'pending' | 'filled' | 'partial' | 'cancelled' | 'failed';

export interface IPolymarketOrder extends Document {
  user_phone: string;
  order_id: string;
  market_condition_id: string;
  market_slug: string;
  token_id: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  status: PolymarketOrderStatus;
  created_at: Date;
  updated_at: Date;
}

const polymarketOrderSchema = new Schema<IPolymarketOrder>({
  user_phone: { type: String, required: true, index: true },
  order_id: { type: String, required: true, unique: true },
  market_condition_id: { type: String, required: true },
  market_slug: { type: String, required: false, default: '' },
  token_id: { type: String, required: true },
  side: { type: String, required: true, enum: ['BUY', 'SELL'] },
  price: { type: Number, required: true },
  size: { type: Number, required: true },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'filled', 'partial', 'cancelled', 'failed'],
    default: 'pending'
  },
  created_at: { type: Date, required: true, default: Date.now },
  updated_at: { type: Date, required: true, default: Date.now }
});

// Composite indexes for common query patterns
polymarketOrderSchema.index({ user_phone: 1, status: 1 });
polymarketOrderSchema.index({ token_id: 1 });
polymarketOrderSchema.index({ user_phone: 1, created_at: -1 });

export const PolymarketOrderModel = model<IPolymarketOrder>(
  'PolymarketOrder',
  polymarketOrderSchema,
  'polymarket_orders'
);

// ============================================================================
// Polymarket Purchase (unified purchase flow)
// ============================================================================

export type PurchaseStepName = 'account_creation' | 'bridge' | 'order_placement' | 'withdrawal';
export type PurchaseStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';
export type PurchaseStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface IPurchaseStep {
  name: PurchaseStepName;
  status: PurchaseStepStatus;
  error?: string;
  tx_hash?: string;
  order_id?: string;
  started_at?: Date;
  completed_at?: Date;
}

export interface IPolymarketPurchase extends Document {
  purchase_id: string;
  user_phone: string;
  token_id: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  order_type?: string;
  bridge_amount: string;
  terms_version?: number;
  steps: IPurchaseStep[];
  current_step: PurchaseStepName | 'done';
  status: PurchaseStatus;
  error?: string;
  order_id?: string;
  bridge_tx_hash?: string;
  created_at: Date;
  updated_at: Date;
}

const purchaseStepSchema = new Schema<IPurchaseStep>(
  {
    name: {
      type: String,
      required: true,
      enum: ['account_creation', 'bridge', 'order_placement', 'withdrawal']
    },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'in_progress', 'completed', 'skipped', 'failed'],
      default: 'pending'
    },
    error: { type: String },
    tx_hash: { type: String },
    order_id: { type: String },
    started_at: { type: Date },
    completed_at: { type: Date }
  },
  { _id: false }
);

const polymarketPurchaseSchema = new Schema<IPolymarketPurchase>({
  purchase_id: { type: String, required: true, unique: true },
  user_phone: { type: String, required: true, index: true },
  token_id: { type: String, required: true },
  price: { type: Number, required: true },
  size: { type: Number, required: true },
  side: { type: String, required: true, enum: ['BUY', 'SELL'] },
  order_type: { type: String },
  bridge_amount: { type: String, required: true },
  terms_version: { type: Number },
  steps: { type: [purchaseStepSchema], required: true },
  current_step: { type: String, required: true, default: 'account_creation' },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending'
  },
  error: { type: String },
  order_id: { type: String },
  bridge_tx_hash: { type: String },
  created_at: { type: Date, required: true, default: Date.now },
  updated_at: { type: Date, required: true, default: Date.now }
});

export const PolymarketPurchaseModel = model<IPolymarketPurchase>(
  'PolymarketPurchase',
  polymarketPurchaseSchema,
  'polymarket_purchases'
);

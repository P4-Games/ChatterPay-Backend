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

export const PolymarketOrderModel = model<IPolymarketOrder>(
  'PolymarketOrder',
  polymarketOrderSchema,
  'polymarket_orders'
);

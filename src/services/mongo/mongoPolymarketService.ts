/**
 * Polymarket MongoDB Service
 *
 * CRUD operations for Polymarket-specific collections:
 * - PolymarketTerms: terms & conditions versioning
 * - PolymarketOrder: order history tracking
 */

import { Logger } from '../../helpers/loggerHelper';
import type { IPolymarketOrder, IPolymarketTerms } from '../../models/polymarketModel';
import { PolymarketOrderModel, PolymarketTermsModel } from '../../models/polymarketModel';

const LOG_PREFIX = 'mongoPolymarketService';

// ============================================================================
// Terms
// ============================================================================

/** Get terms by version */
export async function getTermsByVersion(version: number): Promise<IPolymarketTerms | null> {
  return PolymarketTermsModel.findOne({ version });
}

/** Get the latest terms */
export async function getLatestTerms(): Promise<IPolymarketTerms | null> {
  return PolymarketTermsModel.findOne().sort({ version: -1 });
}

/** Create a new terms version */
export async function createTerms(
  version: number,
  content: string,
  effectiveDate: Date
): Promise<IPolymarketTerms> {
  return PolymarketTermsModel.create({
    version,
    content,
    effective_date: effectiveDate,
    created_at: new Date()
  });
}

// ============================================================================
// Orders
// ============================================================================

/** Record a new order */
export async function createOrder(
  data: Omit<IPolymarketOrder, keyof Document | 'created_at' | 'updated_at'>
): Promise<IPolymarketOrder> {
  return PolymarketOrderModel.create({
    ...data,
    created_at: new Date(),
    updated_at: new Date()
  });
}

/** Update order status */
export async function updateOrderStatus(
  orderId: string,
  status: string,
  logKey: string
): Promise<IPolymarketOrder | null> {
  try {
    return await PolymarketOrderModel.findOneAndUpdate(
      { order_id: orderId },
      { $set: { status, updated_at: new Date() } },
      { new: true }
    );
  } catch (error) {
    Logger.log('error', `[${LOG_PREFIX}:updateOrderStatus]`, `${logKey} Failed: ${String(error)}`);
    return null;
  }
}

/** Get orders for a user */
export async function getOrdersByUser(
  userPhone: string,
  limit: number = 20
): Promise<IPolymarketOrder[]> {
  return PolymarketOrderModel.find({ user_phone: userPhone }).sort({ created_at: -1 }).limit(limit);
}

/** Get a specific order by ID */
export async function getOrderById(orderId: string): Promise<IPolymarketOrder | null> {
  return PolymarketOrderModel.findOne({ order_id: orderId });
}

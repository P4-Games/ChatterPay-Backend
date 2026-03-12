/**
 * Polymarket MongoDB Service
 *
 * CRUD operations for Polymarket-specific collections:
 * - PolymarketTerms: terms & conditions versioning
 * - PolymarketOrder: order history tracking
 */

import { Logger } from '../../helpers/loggerHelper';
import type {
  IPolymarketOrder,
  IPolymarketPurchase,
  IPolymarketTerms,
  PurchaseStatus,
  PurchaseStepName,
  PurchaseStepStatus
} from '../../models/polymarketModel';
import {
  PolymarketOrderModel,
  PolymarketPurchaseModel,
  PolymarketTermsModel
} from '../../models/polymarketModel';

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
export async function createOrder(data: {
  user_phone: string;
  order_id: string;
  market_condition_id: string;
  market_slug?: string;
  token_id: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  status: string;
}): Promise<IPolymarketOrder> {
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

// ============================================================================
// Purchases (unified purchase flow)
// ============================================================================

/** Create a new purchase record */
export async function createPurchase(data: {
  purchase_id: string;
  user_phone: string;
  token_id: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  order_type?: string;
  bridge_amount: string;
  terms_version?: number;
}): Promise<IPolymarketPurchase> {
  const now = new Date();
  return PolymarketPurchaseModel.create({
    ...data,
    steps: [
      { name: 'account_creation', status: 'pending' },
      { name: 'bridge', status: 'pending' },
      { name: 'order_placement', status: 'pending' }
    ],
    current_step: 'account_creation',
    status: 'pending',
    created_at: now,
    updated_at: now
  });
}

/** Update a specific step in a purchase */
export async function updatePurchaseStep(
  purchaseId: string,
  stepName: PurchaseStepName,
  update: {
    status: PurchaseStepStatus;
    error?: string;
    tx_hash?: string;
    order_id?: string;
  },
  logKey: string
): Promise<IPolymarketPurchase | null> {
  try {
    const setFields: Record<string, unknown> = {
      'steps.$[elem].status': update.status,
      updated_at: new Date()
    };
    if (update.status === 'in_progress') {
      setFields['steps.$[elem].started_at'] = new Date();
    }
    if (
      update.status === 'completed' ||
      update.status === 'failed' ||
      update.status === 'skipped'
    ) {
      setFields['steps.$[elem].completed_at'] = new Date();
    }
    if (update.error) setFields['steps.$[elem].error'] = update.error;
    if (update.tx_hash) setFields['steps.$[elem].tx_hash'] = update.tx_hash;
    if (update.order_id) setFields['steps.$[elem].order_id'] = update.order_id;

    return await PolymarketPurchaseModel.findOneAndUpdate(
      { purchase_id: purchaseId },
      { $set: setFields },
      { new: true, arrayFilters: [{ 'elem.name': stepName }] }
    );
  } catch (error) {
    Logger.log('error', `[${LOG_PREFIX}:updatePurchaseStep]`, `${logKey} Failed: ${String(error)}`);
    return null;
  }
}

/** Update overall purchase status and current step */
export async function updatePurchaseStatus(
  purchaseId: string,
  status: PurchaseStatus,
  currentStep: PurchaseStepName | 'done',
  extra?: { error?: string; order_id?: string; bridge_tx_hash?: string },
  logKey?: string
): Promise<IPolymarketPurchase | null> {
  try {
    const setFields: Record<string, unknown> = {
      status,
      current_step: currentStep,
      updated_at: new Date()
    };
    if (extra?.error) setFields.error = extra.error;
    if (extra?.order_id) setFields.order_id = extra.order_id;
    if (extra?.bridge_tx_hash) setFields.bridge_tx_hash = extra.bridge_tx_hash;

    return await PolymarketPurchaseModel.findOneAndUpdate(
      { purchase_id: purchaseId },
      { $set: setFields },
      { new: true }
    );
  } catch (error) {
    Logger.log(
      'error',
      `[${LOG_PREFIX}:updatePurchaseStatus]`,
      `${logKey ?? ''} Failed: ${String(error)}`
    );
    return null;
  }
}

/** Get a purchase by its ID */
export async function getPurchaseById(purchaseId: string): Promise<IPolymarketPurchase | null> {
  return PolymarketPurchaseModel.findOne({ purchase_id: purchaseId });
}

/** Get recent purchases for a user */
export async function getPurchasesByUser(
  userPhone: string,
  limit: number = 20
): Promise<IPolymarketPurchase[]> {
  return PolymarketPurchaseModel.find({ user_phone: userPhone })
    .sort({ created_at: -1 })
    .limit(limit);
}

/**
 * Deferred fee collection for Cardano transfers.
 *
 * ChatterPay's fee (e.g. 0.08 USD ≈ 0.46 ADA) is below the ledger's min-ADA (~0.97 ADA), so it
 * cannot be a transaction output on its own — the chain rejects it. Instead the fee accrues per
 * user and is collected as an extra output on a later transfer, once the total clears the minimum.
 *
 * The debt is stored in lovelace, converted at the ADA price of the moment the transfer happened.
 * Storing lovelace rather than USD avoids a second price lookup at collection time and keeps the
 * amount deterministic.
 */

import mongoose from 'mongoose';

import { Logger } from '../../helpers/loggerHelper';
import { getTokenPrices } from '../balanceService';

const COLLECTION = 'cardano_fee_debts';

interface FeeDebtDoc {
  phone: string;
  debtLovelace: number;
  updatedAt: Date;
}

function collection() {
  return mongoose.connection.db!.collection<FeeDebtDoc>(COLLECTION);
}

/**
 * Current debt for a user, in lovelace.
 */
export async function getFeeDebt(phone: string): Promise<bigint> {
  const doc = await collection().findOne({ phone });
  return BigInt(doc?.debtLovelace ?? 0);
}

/**
 * Adds a fee (in USD) to the user's debt, converted to lovelace at the current ADA price.
 *
 * @returns The new total debt in lovelace.
 */
export async function accumulateFee(phone: string, feeUsd: number): Promise<bigint> {
  if (feeUsd <= 0) return getFeeDebt(phone);

  const adaPriceUsd = await getAdaPriceUsd();
  if (adaPriceUsd <= 0) {
    Logger.warn('accumulateFee', `Cannot convert fee: ADA price is ${adaPriceUsd}, skipping`);
    return getFeeDebt(phone);
  }

  const feeAda = feeUsd / adaPriceUsd;
  const feeLovelace = Math.round(feeAda * 1_000_000);

  const result = await collection().findOneAndUpdate(
    { phone },
    {
      $inc: { debtLovelace: feeLovelace },
      $set: { updatedAt: new Date() },
      $setOnInsert: { phone }
    },
    { upsert: true, returnDocument: 'after' }
  );

  const newDebt = BigInt(result?.debtLovelace ?? feeLovelace);
  Logger.log(
    'accumulateFee',
    `${phone}: +${feeLovelace} lovelace (${feeUsd} USD at ${adaPriceUsd} USD/ADA), total ${newDebt}`
  );
  return newDebt;
}

/**
 * Resets the debt to zero after a successful collection.
 */
export async function clearFeeDebt(phone: string): Promise<void> {
  await collection().updateOne({ phone }, { $set: { debtLovelace: 0, updatedAt: new Date() } });
}

/**
 * ADA price in USD from the existing price service.
 */
async function getAdaPriceUsd(): Promise<number> {
  try {
    const prices = await getTokenPrices(['ADA']);
    return prices.get('ADA') ?? 0;
  } catch (error) {
    Logger.error('getAdaPriceUsd', String(error));
    return 0;
  }
}

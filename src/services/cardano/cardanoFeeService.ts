/**
 * ChatterPay's fee on a Cardano transfer, priced in whatever is moving.
 *
 * The fee is configured in USD and charged in the asset being sent — lovelace on an ADA transfer,
 * the token's own base units on a token transfer. That is what EVM does, where the contract takes
 * its cut out of the token before forwarding the rest, and matching it is what makes `amount − fee`
 * mean the same thing on both chains.
 *
 * **There is no debt here, and that is the point.** This used to accrue: a fee of USD 0.08 is worth
 * roughly 0.4 ADA, an output may not hold less than ~0.97 ADA, so the fee could not be an output of
 * its own and was accumulated until it grew past that floor — which meant two transfers charged
 * nothing and the third charged triple. The fee no longer needs an output: it rides in the
 * sponsor's change, which exists in every sponsored transfer and is far above the floor. So it is
 * charged in full, every time, and nothing has to be remembered between transfers.
 */

import { Logger } from '../../helpers/loggerHelper';
import { getTokenPrices } from '../balanceService';

/**
 * What ChatterPay's fee is worth in the asset being moved.
 *
 * @param feeUsd - The configured fee, in USD. Zero or less means nothing is charged.
 * @param symbol - Ticker of the asset moving, e.g. `ADA` or `USDCx`.
 * @param decimals - Decimals that ticker carries, for the conversion to base units.
 * @returns The fee in the asset's base units. **Zero when the price is unknown**: charging a fee
 *   computed from a price nobody could quote would take an arbitrary amount out of somebody's
 *   transfer, and forgoing a few cents is the cheaper mistake.
 */
export async function chatterPayFeeUnits(
  feeUsd: number,
  symbol: string,
  decimals: number
): Promise<bigint> {
  if (feeUsd <= 0) return 0n;

  const priceUsd = await priceOf(symbol);
  if (priceUsd <= 0) {
    Logger.warn(
      'chatterPayFeeUnits',
      `No usable price for ${symbol} (${priceUsd}); charging no fee on this transfer`
    );
    return 0n;
  }

  const units = BigInt(Math.round((feeUsd / priceUsd) * 10 ** decimals));
  Logger.log(
    'chatterPayFeeUnits',
    `${feeUsd} USD is ${units} base units of ${symbol} at ${priceUsd} USD`
  );
  return units > 0n ? units : 0n;
}

/**
 * The USD price of a ticker, or zero when it cannot be had.
 *
 * A failure here is not an incident: it makes the transfer free, which is a decision this module
 * has already taken, so it is logged and swallowed rather than propagated into a transfer that was
 * otherwise going to succeed.
 */
async function priceOf(symbol: string): Promise<number> {
  try {
    const prices = await getTokenPrices([symbol]);
    return prices.get(symbol.toUpperCase()) ?? prices.get(symbol) ?? 0;
  } catch (error) {
    Logger.error('chatterPayFeeUnits', `Price lookup for ${symbol} failed: ${String(error)}`);
    return 0;
  }
}

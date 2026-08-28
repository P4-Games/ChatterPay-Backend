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
import type { CardanoFeeConfig } from '../../types/cardanoType';
import { getTokenPrices } from '../balanceService';

/** Lovelace in one ADA. */
const LOVELACE_PER_ADA = 1_000_000;

/** The ticker ADA is priced under. */
const ADA_SYMBOL = 'ADA';

/** Decimals ADA carries, which is what makes a fee in ADA a fee in lovelace. */
const ADA_DECIMALS = 6;

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
 * What ChatterPay's fee is worth in the asset being moved, in whichever scheme is running.
 *
 * The two schemes differ in what the fee is *denominated* in, not in what it is charged in: it
 * always comes out of the asset the user is sending. Scheme 1 denominates in USD, which is what EVM
 * does and what keeps a Cardano transfer priced like every other one. Scheme 2 denominates in ADA,
 * because under it the fee has to cover what ChatterPay puts in — the network fee and the min-ADA
 * of the token output — and both of those are ADA. A figure in USD drifts away from them the moment
 * ADA moves; a figure in ADA does not.
 *
 * @param config - The resolved fee configuration, which carries the scheme and both figures.
 * @param symbol - Ticker of the asset moving, e.g. `ADA` or `USDCx`.
 * @param decimals - Decimals that ticker carries, for the conversion to base units.
 * @param fundsNewOutput - Whether this transfer makes ChatterPay fund a brand new min-ADA for the
 *   destination, which happens when the recipient does not hold this token yet and there is nothing
 *   to recycle. It costs roughly 1.16 ADA that never comes back, so it is charged at its own rate.
 *   Ignored under scheme 1, where that ADA is the sender's to begin with.
 * @returns The fee in the asset's base units, zero when nothing is charged or no price can be had.
 */
export async function chatterPayFeeFor(
  config: CardanoFeeConfig,
  symbol: string,
  decimals: number,
  fundsNewOutput = false,
  isAda = symbol.toUpperCase() === ADA_SYMBOL
): Promise<bigint> {
  if (config.scheme !== 2) return chatterPayFeeUnits(config.transferFeeUsd, symbol, decimals);
  const feeAda = fundsNewOutput ? config.transferFeeAdaNewOutput : config.transferFeeAda;
  return chatterPayFeeAdaUnits(feeAda, symbol, decimals, isAda);
}

/**
 * What a fee denominated in ADA is worth in the asset being moved.
 *
 * Sending ADA needs no price at all — a fee of 0.5 ADA is 500000 lovelace and that is the end of it,
 * which is worth having because it is the one path that then cannot be made free by a pricing
 * outage. Sending a token needs both sides quoted, ADA and the token, and the fee is the amount of
 * token worth the same as that much ADA right now.
 *
 * @param feeAda - The configured fee, in ADA. Zero or less means nothing is charged.
 * @param symbol - Ticker of the asset moving.
 * @param decimals - Decimals that ticker carries.
 * @param isAda - Whether what is moving is ADA itself. Defaults to reading the ticker, which is a
 *   guess: the ticker comes from the token catalogue, and a deployment whose row is named `tADA`
 *   would fall through to a price lookup that answers nothing and make every ADA transfer free.
 *   Callers that know the answer — and the transfer path does, from the token's own address — pass
 *   it rather than let the string decide.
 * @returns The fee in the asset's base units. **Zero when either price is unknown**, for the same
 *   reason the USD path forgoes it: a fee computed from a price nobody could quote would take an
 *   arbitrary amount out of somebody's transfer.
 */
export async function chatterPayFeeAdaUnits(
  feeAda: number,
  symbol: string,
  decimals: number,
  isAda = symbol.toUpperCase() === ADA_SYMBOL
): Promise<bigint> {
  if (feeAda <= 0) return 0n;

  const lovelace = BigInt(Math.round(feeAda * LOVELACE_PER_ADA));
  if (isAda) {
    Logger.log('chatterPayFeeAdaUnits', `${feeAda} ADA is ${lovelace} lovelace, no price needed`);
    return lovelace > 0n ? lovelace : 0n;
  }

  const [adaUsd, assetUsd] = await Promise.all([priceOf(ADA_SYMBOL), priceOf(symbol)]);
  if (adaUsd <= 0 || assetUsd <= 0) {
    Logger.warn(
      'chatterPayFeeAdaUnits',
      `No usable price for ADA (${adaUsd}) or ${symbol} (${assetUsd}); charging no fee on this transfer`
    );
    return 0n;
  }

  const units = BigInt(Math.round(((feeAda * adaUsd) / assetUsd) * 10 ** decimals));
  Logger.log(
    'chatterPayFeeAdaUnits',
    `${feeAda} ADA is ${units} base units of ${symbol} at ADA ${adaUsd} and ${symbol} ${assetUsd} USD`
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

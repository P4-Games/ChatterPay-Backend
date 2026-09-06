/**
 * ADA amounts, converted without ever going through a float.
 *
 * ADA has six decimals and lovelace is the integer unit the protocol actually uses. Parsing "2.5"
 * with `parseFloat` and multiplying by 1e6 is accurate for most inputs and silently wrong for some
 * — `0.07 * 1e6` is `70000.00000000001` in IEEE 754 — and a lovelace off is a transaction that does
 * not balance. So the conversion is string arithmetic: split on the point, pad, concatenate.
 */

/** Decimals ADA carries. A property of Cardano, not of this deployment. */
export const ADA_DECIMALS = 6;

const LOVELACE_PER_ADA = 1_000_000n;

/**
 * Converts a human-entered ADA amount to lovelace.
 *
 * @param amount - Amount in ADA, as typed: digits with an optional single decimal point.
 * @returns The amount in lovelace.
 * @throws Error `CARDANO_INVALID_AMOUNT` for anything that is not a plain positive decimal, and
 *   `CARDANO_AMOUNT_TOO_PRECISE` for more than six decimals — truncating there would move a
 *   different amount than the user asked for.
 */
export function adaToLovelace(amount: string): bigint {
  return toBaseUnits(amount, ADA_DECIMALS, 'ADA');
}

/**
 * Converts a human-entered amount to an asset's base unit.
 *
 * Native assets do not all carry six decimals the way ADA does — the figure comes from the token's
 * own metadata — so the conversion takes it as a parameter rather than assuming.
 *
 * @param amount - Amount as typed: digits with an optional single decimal point.
 * @param decimals - Decimals the asset carries. `0` is legitimate and common for NFTs and for
 *   tokens that are simply indivisible.
 * @param label - Asset name, used only to make the error readable.
 * @returns The amount in base units.
 * @throws Error `CARDANO_INVALID_AMOUNT` for anything that is not a plain positive decimal, and
 *   `CARDANO_AMOUNT_TOO_PRECISE` when the input has more decimals than the asset can represent —
 *   truncating would move a different amount than the user asked for.
 */
export function toBaseUnits(amount: string, decimals: number, label = 'the asset'): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`CARDANO_INVALID_AMOUNT: '${amount}'`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(
      `CARDANO_AMOUNT_TOO_PRECISE: ${label} has ${decimals} decimals, got ${fraction.length}`
    );
  }
  const scale = 10n ** BigInt(decimals);
  const base = BigInt(whole) * scale + (decimals > 0 ? BigInt(fraction.padEnd(decimals, '0')) : 0n);
  if (base <= 0n) throw new Error(`CARDANO_INVALID_AMOUNT: '${amount}'`);
  return base;
}

/**
 * Renders a base-unit quantity as a decimal string.
 *
 * @param base - Quantity in base units.
 * @param decimals - Decimals the asset carries.
 * @returns The amount, always with `decimals` places so two values compare as strings.
 */
export function fromBaseUnits(base: bigint, decimals: number): string {
  if (decimals <= 0) return base.toString();
  const negative = base < 0n;
  const absolute = negative ? -base : base;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Converts lovelace to a plain ADA string.
 *
 * @param lovelace - Amount in lovelace.
 * @returns The amount in ADA, always with six decimals so two values are comparable as strings.
 */
export function lovelaceToAda(lovelace: bigint): string {
  const negative = lovelace < 0n;
  const absolute = negative ? -lovelace : lovelace;
  const whole = absolute / LOVELACE_PER_ADA;
  const fraction = (absolute % LOVELACE_PER_ADA).toString().padStart(ADA_DECIMALS, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Lovelace as a number of ADA, for the fields that store amounts numerically.
 *
 * Lossy by construction and used only where the schema already is: `transactions.amount` and
 * `transactions.network_fee` are `Number`. Six decimals of ADA sit far inside the exact-integer
 * range of a double, so the round trip is safe for any amount this product moves.
 *
 * @param lovelace - Amount in lovelace.
 * @returns The amount in ADA.
 */
export function lovelaceToAdaNumber(lovelace: bigint): number {
  return Number(lovelace) / Number(LOVELACE_PER_ADA);
}

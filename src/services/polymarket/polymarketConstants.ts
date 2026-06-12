/**
 * Polymarket Contract Addresses (Polygon Mainnet)
 * @see https://docs.polymarket.com/resources/contract-addresses
 *
 * Single source of truth — all Polymarket services import from here.
 *
 * CLOB V2 migration (April 28, 2026):
 * - Collateral changed from USDC.e to pUSD (Polymarket USD, 1:1 USDC-backed)
 * - New CTF Exchange and Neg Risk CTF Exchange contracts (new EIP-712 domain)
 * - CTF (ERC-1155) and Neg Risk Adapter addresses unchanged
 */

/** pUSD (Polymarket USD) on Polygon — collateral since CLOB V2 (April 2026). Backed 1:1 by USDC. */
export const PUSD_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';

/** CTF Exchange — main order matching/settlement contract (V2 address) */
export const CTF_EXCHANGE_ADDRESS = '0xE111180000d2663C0091e4f400237545B87B996B';

/** Neg Risk CTF Exchange — for negative risk (multi-outcome) markets (V2 address) */
export const NEG_RISK_CTF_EXCHANGE_ADDRESS = '0xe2222d279d744050d28e00520010520000310F59';

/** Conditional Token Framework — ERC-1155 conditional tokens (unchanged in V2) */
export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/** Neg Risk Adapter (unchanged in V2) */
export const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

/** 2% buffer applied to bridged amounts to cover LiFi/bridge fees and slippage */
export const BRIDGE_FEE_BUFFER = 1.02;

/**
 * Minimum bridge amount in USD (human-readable).
 * LiFi cross-chain routes reject amounts below ~$1. If the deficit is smaller,
 * skip the bridge and let the order placement use the existing Safe balance.
 */
export const MIN_BRIDGE_AMOUNT_USD = 1.0;

/**
 * Minimum BUY order value in USD (price × size), enforced at API entry.
 * Polymarket's CLOB requires $1.00 minimum for marketable (FOK) BUY orders.
 * $1.50 gives headroom so bridge fees/slippage can't push the deliverable
 * amount below the CLOB's $1.00 floor after bridging.
 */
export const MIN_BUY_ORDER_USD = 1.5;

/** Interval between on-chain balance checks after a bridge completes */
export const BRIDGE_BALANCE_POLL_INTERVAL_MS = 5000;

/**
 * Max time to wait for bridged funds to be reflected on-chain (Polygon).
 * LiFi may report DONE before the RPC reflects the balance, or its status
 * API may lag the actual transfer entirely.
 */
export const BRIDGE_BALANCE_POLL_TIMEOUT_MS = 180000;

/**
 * Fraction of available balance used for order size calculation.
 * Reserves 3% headroom for the CLOB taker fee (2%) + rounding to avoid
 * "not enough balance / allowance" rejections from the CLOB.
 */
export const CLOB_FEE_RESERVE = 0.97;

/** Slippage tolerance for Fill-or-Kill market order fallbacks (20%) */
export const FOK_SLIPPAGE_TOLERANCE = 0.2;

/** Polymarket minimum allowed price (exclusive lower bound) */
export const POLYMARKET_MIN_PRICE = 0.001;

/** Polymarket maximum allowed price (exclusive upper bound) */
export const POLYMARKET_MAX_PRICE = 0.999;

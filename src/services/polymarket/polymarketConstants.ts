/**
 * Polymarket Contract Addresses (Polygon Mainnet)
 * @see https://docs.polymarket.com/resources/contract-addresses
 *
 * Single source of truth — all Polymarket services import from here.
 */

/** USDC.e (Bridged USDC) on Polygon — used as collateral */
export const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/** CTF Exchange — the main order matching/settlement contract */
export const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

/** Neg Risk CTF Exchange — for negative risk (multi-outcome) markets */
export const NEG_RISK_CTF_EXCHANGE_ADDRESS = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

/** Conditional Token Framework — ERC1155 conditional tokens */
export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/** Neg Risk Adapter */
export const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

/** 2% buffer applied to bridged amounts to cover LiFi/bridge fees and slippage */
export const BRIDGE_FEE_BUFFER = 1.02;

/** Slippage tolerance for Fill-or-Kill market order fallbacks (20%) */
export const FOK_SLIPPAGE_TOLERANCE = 0.2;

/** Polymarket minimum allowed price (exclusive lower bound) */
export const POLYMARKET_MIN_PRICE = 0.001;

/** Polymarket maximum allowed price (exclusive upper bound) */
export const POLYMARKET_MAX_PRICE = 0.999;

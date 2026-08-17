/**
 * Cardano configuration and the guard that decides whether the family runs at all.
 *
 * Kept out of `constants.ts` because it is not a flat list of values: whether Cardano is enabled is
 * a *conclusion* drawn from several settings, and the one thing this module must never do is report
 * the family as available when half of it is missing. A deployment with the flag on and no provider
 * URL is off, not partly on — a transfer that gets as far as building and then cannot submit has
 * already cost the user an operation lock and a notification.
 *
 * @see CARDANO_INTEGRATION_PLAN.md §7
 */

import type { CardanoNetwork } from '../types/cardanoType';

/**
 * Internal chain ids for networks that have no EIP-155 chain id.
 *
 * `9e11 + network magic`. The namespace is deliberate: EIP-155 ids are below 1e9, and the synthetic
 * ids Li.Fi uses for non-EVM chains are far above (Bitcoin 2e13, Solana 1.15e15), so nothing
 * collides. Deriving them from the network magic keeps them meaningful rather than arbitrary.
 *
 * **These are frozen once data is written.** A wallet, a transaction or a token row carrying one of
 * these numbers is a row nobody can reinterpret later.
 */
export const CARDANO_PREPROD_CHAIN_ID = 900000000001;
export const CARDANO_MAINNET_CHAIN_ID = 900764824073;

/**
 * Prefix that marks the `tokens.address` of ADA itself.
 *
 * ADA is the chain's own coin: it has no minting policy and no contract, but `tokens.address` is a
 * unique index, so the row needs *something* there. Everything else on the Cardano catalogue holds
 * a real asset unit (`policyId + assetName`), and this prefix is what separates the two.
 */
export const ADA_ADDRESS_PREFIX = 'cardano:';

/** Default provider roots per network. Koios needs no API key, which keeps a secret out of the
 *  bootstrap path of a testnet deployment. */
const DEFAULT_PROVIDER_URL: Readonly<Record<CardanoNetwork, string>> = {
  testnet: 'https://preprod.koios.rest/api/v1',
  mainnet: 'https://api.koios.rest/api/v1'
};

/** Block explorer roots per network. The transaction path differs from every EVM explorer: it is
 *  `/transaction/<id>`, not `/tx/<hash>`. */
const EXPLORER_URL: Readonly<Record<CardanoNetwork, string>> = {
  testnet: 'https://preprod.cardanoscan.io/transaction/',
  mainnet: 'https://cardanoscan.io/transaction/'
};

/**
 * Slots a transaction stays valid for, counted from the tip.
 *
 * A slot is one second, so this is fifteen minutes: long enough that a provider retry or a slow
 * signature still lands, short enough that an expired transaction stops being a thing that might
 * yet appear. Cardano has no replace-by-fee and no nonce, so the TTL *is* the mechanism that makes
 * a stuck transaction resolvable — past it, the inputs are provably free again.
 */
const DEFAULT_TTL_SLOTS = 900;

/**
 * Blocks an output needs before this deployment will spend from it.
 *
 * Not "enough for finality": Cardano's settlement guarantee is probabilistic and full finality is
 * thousands of blocks away, which no product waits for. Three blocks is the declared answer to the
 * rollback question — below it the funds are not seen yet and the next read sees them; above it the
 * ledger has been credited and a rollback would need manual repair.
 */
const DEFAULT_DEPOSIT_CONFIRMATIONS = 3;

/** Everything the Cardano subsystem needs to run, resolved once. */
export interface CardanoConfig {
  /** Whether the family is fully configured and may be used. */
  enabled: boolean;
  /** The network this deployment operates on. Decides the header byte of every address it issues. */
  network: CardanoNetwork;
  /** Internal chain id of that network. */
  chainId: number;
  /** Provider root URL. */
  providerUrl: string;
  /** Per-call ceiling for provider requests, in milliseconds. */
  providerTimeoutMs: number;
  /** Slots of validity given to a transaction, from the tip. */
  ttlSlots: number;
  /** Confirmations required before an output is spendable. */
  depositConfirmations: number;
  /** Explorer base URL; the transaction id is appended directly. */
  explorerUrl: string;
  /** Why the family is off, when it is. Empty when enabled. */
  disabledReason: string;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Spellings of each network this deployment accepts, all compared case-insensitively. */
const NETWORK_ALIASES: Readonly<Record<string, CardanoNetwork>> = {
  mainnet: 'mainnet',
  preprod: 'testnet',
  testnet: 'testnet'
};

/**
 * Reads `CARDANO_NETWORK`.
 *
 * Case and surrounding whitespace are irrelevant: `Mainnet`, `MAINNET` and ` mainnet ` all mean
 * mainnet. Requiring an exact lowercase match would turn a capital letter in a Cloud Build
 * substitution into a deployment that issues **testnet addresses on mainnet** — well-formed, and
 * unspendable.
 *
 * A value that is set but unrecognised is a different case, and it is refused rather than defaulted.
 * `mainet` is not a request for testnet, it is a typo, and answering it with a silent testnet is the
 * same failure the case-insensitivity above exists to prevent.
 *
 * @returns The network, or `null` when the variable holds something this deployment cannot read.
 *   Absent or empty falls back to testnet: that is "not configured", and testnet is the safe default
 *   for it.
 */
function networkFromEnv(): CardanoNetwork | null {
  const raw = (process.env.CARDANO_NETWORK ?? '').trim();
  if (raw === '') return 'testnet';
  return NETWORK_ALIASES[raw.toLowerCase()] ?? null;
}

/**
 * Resolves the Cardano configuration from the environment.
 *
 * Read as a function rather than frozen at import so tests can drive it without reloading modules.
 *
 * @returns The configuration, with `enabled` false and `disabledReason` set whenever anything the
 *   family needs is missing.
 */
export function getCardanoConfig(): CardanoConfig {
  const readNetwork = networkFromEnv();
  // Unreadable network: everything below still resolves, against testnet, so the shape of the
  // returned config is the usual one -- but `disabledReason` further down keeps the family off, so
  // none of it is ever used.
  const network: CardanoNetwork = readNetwork ?? 'testnet';
  const chainId = intFromEnv(
    'CARDANO_CHAIN_ID',
    network === 'mainnet' ? CARDANO_MAINNET_CHAIN_ID : CARDANO_PREPROD_CHAIN_ID
  );
  const providerUrl = (process.env.CARDANO_PROVIDER_URL || DEFAULT_PROVIDER_URL[network]).replace(
    /\/+$/,
    ''
  );

  const flagOn = (process.env.CARDANO_ENABLED || 'false').toLowerCase() === 'true';
  // The salt is what every address derives from. Without it the family would still produce
  // well-formed addresses -- ones that anybody who knows the phone number could spend from.
  const hasSalt = Boolean(process.env.SEED_INTERNAL_SALT);

  const disabledReason = !flagOn
    ? 'CARDANO_ENABLED is not true'
    : readNetwork === null
      ? `CARDANO_NETWORK is not a network this deployment knows: '${process.env.CARDANO_NETWORK}' ` +
        `(expected one of ${Object.keys(NETWORK_ALIASES).join(', ')}, in any case)`
      : !providerUrl
        ? 'CARDANO_PROVIDER_URL is empty'
        : !hasSalt
          ? 'SEED_INTERNAL_SALT is not configured'
          : '';

  return {
    enabled: disabledReason === '',
    network,
    chainId,
    providerUrl,
    providerTimeoutMs: intFromEnv('CARDANO_PROVIDER_TIMEOUT_MS', 20_000),
    ttlSlots: intFromEnv('CARDANO_TTL_SLOTS', DEFAULT_TTL_SLOTS),
    depositConfirmations: intFromEnv(
      'CARDANO_DEPOSIT_CONFIRMATIONS',
      DEFAULT_DEPOSIT_CONFIRMATIONS
    ),
    explorerUrl: process.env.CARDANO_EXPLORER_URL || EXPLORER_URL[network],
    disabledReason
  };
}

/**
 * Whether a chain id belongs to the Cardano family.
 *
 * @param chainId - Chain id to test.
 * @returns `true` for either Cardano network.
 */
export function isCardanoChainId(chainId: number): boolean {
  return chainId === CARDANO_PREPROD_CHAIN_ID || chainId === CARDANO_MAINNET_CHAIN_ID;
}

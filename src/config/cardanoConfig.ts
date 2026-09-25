/**
 * Cardano configuration and the guard that decides whether the family runs at all.
 *
 * Kept out of `constants.ts` because it is not a flat list of values: whether Cardano is enabled is
 * a *conclusion* drawn from several settings, and the one thing this module must never do is report
 * the family as available when half of it is missing. A deployment with the flag on and no provider
 * URL is off, not partly on — a transfer that gets as far as building and then cannot submit has
 * already cost the user an operation lock and a notification.
 *
 * The settings themselves are read by `constants.ts`, the only module that touches the environment,
 * and shaped by `envHelper`. What is left here is the reasoning: the defaults, why each one is the
 * number it is, and the order in which a missing piece is reported.
 */

import { readCardanoEnv } from '../helpers/envHelper';
import type {
  CardanoConfig,
  CardanoDisabledReason,
  CardanoNetwork,
  CardanoProviderKind
} from '../types/cardanoType';
import { cardanoDerivationDisabledReason } from './cardanoDerivationState';

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

/** Default provider roots per network. Koios is the default because its public tier answers
 *  without a credential, which keeps a secret out of the bootstrap path of a testnet deployment. */
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

/** Per-call ceiling for provider requests, in milliseconds. */
const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;

/** Spellings of each network this deployment accepts, all compared case-insensitively. */
const NETWORK_ALIASES: Readonly<Record<string, CardanoNetwork>> = {
  mainnet: 'mainnet',
  preprod: 'testnet',
  testnet: 'testnet'
};

/**
 * Resolves the configured network spelling.
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
 * @param raw - Network as configured, already trimmed.
 * @returns The network, or `null` when the value is something this deployment cannot read. Empty
 *   falls back to testnet: that is "not configured", and testnet is the safe default for it.
 */
function resolveNetwork(raw: string): CardanoNetwork | null {
  if (raw === '') return 'testnet';
  return NETWORK_ALIASES[raw.toLowerCase()] ?? null;
}

/**
 * Reads which provider a root URL names.
 *
 * Off the URL rather than out of a setting of its own, so that swapping providers is one line of
 * configuration instead of two that can contradict each other — a key paired with the wrong root
 * is 403 on every call, and there would be nothing in the config to say which half was wrong.
 *
 * The host is what decides, not the whole string: matching anywhere would read a Koios root that
 * happens to carry `blockfrost` in a path or a query as the wrong dialect.
 *
 * @param url - Provider root, already stripped of trailing slashes.
 * @returns The dialect to speak. Anything this deployment does not recognise is treated as Koios,
 *   which is what the defaults are and what an unconfigured deployment gets.
 */
function resolveProviderKind(url: string): CardanoProviderKind {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'koios';
  }
  return host === 'blockfrost.io' || host.endsWith('.blockfrost.io') ? 'blockfrost' : 'koios';
}

/**
 * The chain id a network is identified by.
 *
 * @param network - The resolved network.
 * @returns Its frozen internal id.
 */
function chainIdOf(network: CardanoNetwork): number {
  return network === 'mainnet' ? CARDANO_MAINNET_CHAIN_ID : CARDANO_PREPROD_CHAIN_ID;
}

/**
 * Resolves the Cardano configuration from the environment.
 *
 * Read as a function rather than frozen at import so tests can drive it without reloading modules.
 *
 * @param withDerivationState - Whether the startup derivation verdict takes part in the answer.
 *   Only the check itself passes `false`, because it has to know which network and chain id to
 *   derive against before there is a verdict to consult.
 * @returns The configuration, with `enabled` false and `disabledReason` set whenever anything the
 *   family needs is missing.
 */
function resolveCardanoConfig(withDerivationState: boolean): CardanoConfig {
  const env = readCardanoEnv();
  const readNetwork = resolveNetwork(env.network);
  // Unreadable network: everything below still resolves, against testnet, so the shape of the
  // returned config is the usual one -- but `disabledReason` further down keeps the family off, so
  // none of it is ever used.
  const network: CardanoNetwork = readNetwork ?? 'testnet';
  // The network's own constant, always -- never the configured value, even when one was set. A
  // configured id is checked against this and the family goes off when they disagree, so the only
  // number that ever leaves here is one of the two frozen ids. That is what keeps a typo, or the
  // chain id of an EVM network, out of the catalogue queries and the wallet rows that are written
  // with it.
  const chainId = chainIdOf(network);
  // Stripped after the fallback rather than before it, so a configured value of nothing but
  // slashes reads as a value that resolved to nothing -- which is a misconfiguration to report,
  // not an absent setting to paper over with the default.
  const providerUrl = (env.providerUrl || DEFAULT_PROVIDER_URL[network]).replace(/\/+$/, '');
  const providerKind = resolveProviderKind(providerUrl);
  // Koios answers without one, on a smaller quota; Blockfrost answers nothing at all. Missing here
  // means the family stays off rather than starting and failing every call with a 403 — which
  // reads to the user as a chain that is down.
  const providerKeyMissing = providerKind === 'blockfrost' && !env.providerApiKey;

  // Both chain id reasons are read after the network, because which id is the right one is a
  // question the network answers. A value that is present and unusable is refused rather than
  // defaulted, for the same reason an unrecognised network spelling is: the id is a derivation
  // input, and answering a typo with the default issues addresses under an identity nobody chose.
  const chainIdInvalid = env.chainId === 'invalid';
  const chainIdMismatch = typeof env.chainId === 'number' && env.chainId !== chainId;

  // The two before last are what the derivation is made of. Without either, this deployment would
  // issue well-formed addresses that are not the ones it issued yesterday — and nothing downstream
  // can tell the difference — so the family stays off instead. The last one is the same question
  // asked of the values themselves, once, at startup.
  const disabledReason: CardanoDisabledReason = !env.enabled
    ? 'flag_off'
    : readNetwork === null
      ? 'network_unknown'
      : chainIdInvalid
        ? 'chain_id_invalid'
        : chainIdMismatch
          ? 'chain_id_mismatch'
          : !providerUrl
            ? 'provider_missing'
            : providerKeyMissing
              ? 'provider_key_missing'
              : !env.hasSecret
                ? 'secret_missing'
                : !env.labelsReadable
                  ? 'labels_unreadable'
                  : withDerivationState
                    ? cardanoDerivationDisabledReason()
                    : '';

  return {
    enabled: disabledReason === '',
    network,
    chainId,
    providerUrl,
    providerKind,
    providerApiKey: env.providerApiKey,
    providerTimeoutMs: env.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
    ttlSlots: env.ttlSlots ?? DEFAULT_TTL_SLOTS,
    depositConfirmations: env.depositConfirmations ?? DEFAULT_DEPOSIT_CONFIRMATIONS,
    explorerUrl: env.explorerUrl || EXPLORER_URL[network],
    disabledReason
  };
}

/**
 * The Cardano configuration every caller reads.
 *
 * @returns The configuration, off while anything the family needs is missing and while its
 *   derivation has not been shown to be the one this deployment issued before.
 */
export function getCardanoConfig(): CardanoConfig {
  return resolveCardanoConfig(true);
}

/**
 * The same configuration, before the derivation verdict is applied.
 *
 * Exists for one caller: the startup check, which has to derive an address to produce the verdict
 * and therefore cannot wait for it. Everything else reads {@link getCardanoConfig} — reading this
 * one from a request path would be a way to act on a derivation nobody verified.
 *
 * @returns The configuration with every reason except the derivation ones resolved.
 */
export function getCardanoConfigForDerivationCheck(): CardanoConfig {
  return resolveCardanoConfig(false);
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

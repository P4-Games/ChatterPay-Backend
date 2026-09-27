/**
 * Cardano configuration and the guard that decides whether the family runs at all.
 *
 * Kept out of `constants.ts` because it is not a flat list of values: whether Cardano is enabled is
 * a *conclusion* drawn from several settings, and the one thing this module must never do is report
 * the family as available when half of it is missing. A deployment with the flag on and no provider
 * URL is off, not partly on — a transfer that gets as far as building and then cannot submit has
 * already cost the user an operation lock and a notification.
 *
 * The settings come from two places, and each one has exactly one. The network, its chain id, its
 * provider root, its TTL, its confirmation count and its explorer come from the network's own
 * `blockchains` document, read at startup by `cardanoNetworkSettings`; there is no environment form
 * of any of them and no default to fall back on. Everything else — the flag, the provider
 * credential and timeout, the signing material — is read by `constants.ts` and shaped by
 * `envHelper`. What is left here is the reasoning: the one remaining default, and the order in
 * which a missing piece is reported.
 */

import { readCardanoEnv } from '../helpers/envHelper';
import type {
  CardanoConfig,
  CardanoDisabledReason,
  CardanoProviderKind
} from '../types/cardanoType';
import { cardanoDerivationDisabledReason } from './cardanoDerivationState';
import {
  CARDANO_MAINNET_CHAIN_ID,
  CARDANO_PREPROD_CHAIN_ID,
  getCardanoNetworkSettingsState
} from './cardanoNetworkSettings';

// Re-exported so the many modules that identify a Cardano network keep one import to reach for.
// They are frozen identifiers, not settings: `cardanoNetworkSettings` checks the stored chain id
// against them and never substitutes one for it.
export { CARDANO_MAINNET_CHAIN_ID, CARDANO_PREPROD_CHAIN_ID };

/**
 * Prefix that marks the `tokens.address` of ADA itself.
 *
 * ADA is the chain's own coin: it has no minting policy and no contract, but `tokens.address` is a
 * unique index, so the row needs *something* there. Everything else on the Cardano catalogue holds
 * a real asset unit (`policyId + assetName`), and this prefix is what separates the two.
 */
export const ADA_ADDRESS_PREFIX = 'cardano:';

/** Per-call ceiling for provider requests, in milliseconds. */
const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * The chain id a configuration reports while it has no network.
 *
 * Not one of the two Cardano ids, and not a number any row carries: a catalogue query or a wallet
 * lookup made with it finds nothing instead of finding another network's rows. Every path that
 * matters is already behind `enabled`, and this is what the ones that are not fall through to.
 */
const NO_CHAIN_ID = 0;

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
 *   which is the dialect the public roots speak.
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
 * Resolves the Cardano configuration.
 *
 * Read as a function rather than frozen at import so tests can drive it without reloading modules,
 * and so the startup read of the network document is visible to callers that were constructed
 * before it happened.
 *
 * @param withDerivationState - Whether the startup derivation verdict takes part in the answer.
 *   Only the check itself passes `false`, because it has to know which network and chain id to
 *   derive against before there is a verdict to consult.
 * @returns The configuration, with `enabled` false and `disabledReason` set whenever anything the
 *   family needs is missing.
 */
function resolveCardanoConfig(withDerivationState: boolean): CardanoConfig {
  const env = readCardanoEnv();
  const state = getCardanoNetworkSettingsState();
  const settings = state.status === 'loaded' ? state.settings : null;

  // Why the network document is no use, if it is not. `unloaded` is its own reason rather than a
  // missing document: a process that fell over before the startup read, or that never ran it, has
  // verified nothing, and reporting that as "no document" would send an operator to the database.
  const settingsReason: CardanoDisabledReason =
    state.status === 'loaded' ? '' : state.status === 'failed' ? state.reason : 'settings_unloaded';

  const providerUrl = settings?.providerUrl ?? '';
  const providerKind = resolveProviderKind(providerUrl);
  // Koios answers without one, on a smaller quota; Blockfrost answers nothing at all. Missing here
  // means the family stays off rather than starting and failing every call with a 403 — which
  // reads to the user as a chain that is down.
  const providerKeyMissing = providerKind === 'blockfrost' && !env.providerApiKey;

  // The network document is read right after the flag, because every value a Cardano path needs
  // comes from it: without one there is no network, no chain id and nothing to check a credential
  // against. The two after it are what the derivation is made of — without either, this deployment
  // would issue well-formed addresses that are not the ones it issued yesterday, and nothing
  // downstream can tell the difference. The last one is the same question asked of the values
  // themselves, once, at startup.
  const disabledReason: CardanoDisabledReason = !env.enabled
    ? 'flag_off'
    : settingsReason !== ''
      ? settingsReason
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
    // Every field below is the stored one or an inert stand-in, never a guess at what the network
    // probably is. `testnet` is the only spelling the type allows for the stand-in, and it is never
    // acted on: `enabled` is false alongside it and the chain id is one no row carries.
    network: settings?.network ?? 'testnet',
    chainId: settings?.chainId ?? NO_CHAIN_ID,
    providerUrl,
    providerKind,
    providerApiKey: env.providerApiKey,
    providerTimeoutMs: env.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
    ttlSlots: settings?.ttlSlots ?? 0,
    depositConfirmations: settings?.depositConfirmations ?? 0,
    explorerUrl: settings?.explorerUrl ?? '',
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
 * It is no shortcut past the network document: a configuration with no settings loaded comes back
 * off here too, so the check never derives against a chain id nobody stored.
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

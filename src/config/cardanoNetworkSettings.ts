/**
 * The six operational settings of a Cardano network, as this process currently holds them.
 *
 * They come from the network's own `blockchains` document and from nowhere else. There is no
 * environment fallback and no hardcoded Preprod: a deployment that cannot read a usable document
 * runs with Cardano off rather than with values nobody chose. The alternative — a default that
 * looks right — issues addresses, builds transactions and writes rows under an identity that was
 * never configured, and nothing downstream can tell the difference.
 *
 * What stays in the environment is what is not a per-network setting: the family flag, the provider
 * credential and timeout, the signing material and the derivation references.
 *
 * This module holds the published state and the identifiers a network is recognised by, and
 * nothing else. Reading the document is `cardanoNetworkLoader`, which needs Mongoose and the
 * environment to do it — and this one must stay free of both, because it is reached from the
 * configuration and from test fixtures that run while `constants` is still being mocked. The same
 * split, for the same reason, as `cardanoDerivationState` and the check that fills it.
 *
 * The starting state is `unloaded`, which reads as *no network* everywhere it is consulted. That is
 * the safety property: a process that fell over before the startup read, or that never ran it,
 * keeps Cardano off rather than inheriting the network it would have found.
 */

import type { CardanoDisabledReason, CardanoNetwork } from '../types/cardanoType';

/**
 * Internal chain ids for networks that have no EIP-155 chain id.
 *
 * `9e11 + network magic`. The namespace is deliberate: EIP-155 ids are below 1e9, and the synthetic
 * ids Li.Fi uses for non-EVM chains are far above (Bitcoin 2e13, Solana 1.15e15), so nothing
 * collides. Deriving them from the network magic keeps them meaningful rather than arbitrary.
 *
 * **These are frozen once data is written.** A wallet, a transaction or a token row carrying one of
 * these numbers is a row nobody can reinterpret later.
 *
 * They identify a network; they never supply a value. The chain id this deployment operates with is
 * the one stored on the document, and these are what that stored value is checked against.
 */
export const CARDANO_PREPROD_CHAIN_ID = 900000000001;
export const CARDANO_MAINNET_CHAIN_ID = 900764824073;

/** Spellings of each network a document may carry, all compared case-insensitively. */
const NETWORK_ALIASES: Readonly<Record<string, CardanoNetwork>> = {
  mainnet: 'mainnet',
  preprod: 'testnet',
  testnet: 'testnet'
};

/** The six settings, validated. Every field is usable or the whole thing does not exist. */
export interface CardanoNetworkSettings {
  /** The network this deployment operates on. Decides the header byte of every address it issues. */
  network: CardanoNetwork;
  /** Internal chain id of that network, as stored and checked against the frozen constant. */
  chainId: number;
  /** Provider root URL, trailing slashes stripped. */
  providerUrl: string;
  /** Slots of validity given to a transaction, counted from the tip. */
  ttlSlots: number;
  /** Confirmations required before an output is spendable. */
  depositConfirmations: number;
  /** Explorer base URL. The transaction id is appended directly, so its trailing slash is kept. */
  explorerUrl: string;
}

/**
 * What is known about this deployment's network settings.
 *
 * - `unloaded` — the startup read has not happened. Never an answer, and never read as one.
 * - `loaded` — a single document was selected and every field it needs is usable.
 * - `failed` — the read or the validation refused, with the reason it refused.
 */
export type CardanoNetworkSettingsState =
  | { status: 'unloaded' }
  | { status: 'loaded'; settings: CardanoNetworkSettings }
  | { status: 'failed'; reason: CardanoDisabledReason };

/** The published settings, until the startup read replaces them. */
let state: CardanoNetworkSettingsState = { status: 'unloaded' };

/**
 * Resolves a network spelling.
 *
 * Case and surrounding whitespace are irrelevant: `Mainnet`, `MAINNET` and ` mainnet ` all mean
 * mainnet. A value that is set but unrecognised is refused rather than defaulted — `mainet` is not
 * a request for testnet, it is a typo, and answering it with a silent testnet issues testnet
 * addresses on mainnet: well-formed, and unspendable.
 *
 * @param raw - Network as stored.
 * @returns The network, or `null` when the value is one this deployment cannot read.
 */
export function resolveCardanoNetwork(raw: string): CardanoNetwork | null {
  return NETWORK_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/**
 * The chain id a network is identified by.
 *
 * @param network - The resolved network.
 * @returns Its frozen internal id.
 */
export function cardanoChainIdOf(network: CardanoNetwork): number {
  return network === 'mainnet' ? CARDANO_MAINNET_CHAIN_ID : CARDANO_PREPROD_CHAIN_ID;
}

/**
 * The settings every synchronous reader consults.
 *
 * @returns The current state.
 */
export function getCardanoNetworkSettingsState(): CardanoNetworkSettingsState {
  return state;
}

/**
 * Publishes a state.
 *
 * Called by the startup read, and by nothing on a request path: a caller must not be able to
 * configure a network by asking for one.
 *
 * @param next - The state to publish.
 */
export function recordCardanoNetworkSettings(next: CardanoNetworkSettingsState): void {
  state = next;
}

/**
 * Puts the settings back to unloaded.
 *
 * For fixtures and tests. Production code publishes once per process.
 */
export function resetCardanoNetworkSettings(): void {
  state = { status: 'unloaded' };
}

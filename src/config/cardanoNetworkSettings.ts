/**
 * The six operational settings of a Cardano network, read from the network's own document.
 *
 * `blockchains` is the only source for them. There is no environment fallback and no hardcoded
 * Preprod: a deployment that cannot read a usable document runs with Cardano off rather than with
 * values nobody chose. The alternative — a default that looks right — issues addresses, builds
 * transactions and writes rows under an identity that was never configured, and nothing downstream
 * can tell the difference.
 *
 * What stays in the environment is what is not a per-network setting: the family flag, the provider
 * credential and timeout, the signing material and the derivation references.
 *
 * The document is read once, at startup, and published here for the synchronous readers. A change
 * to any of these six fields takes effect on the next restart, not on the next request: they decide
 * the address prefix, the key derivation and the transaction validity window, and a value that can
 * change under a half-built transaction is a value two parts of one operation can disagree about.
 */

import { Logger } from '../helpers/loggerHelper';
import Blockchain, { type IBlockchain } from '../models/blockchainModel';
import type { CardanoDisabledReason, CardanoNetwork } from '../types/cardanoType';
import { $B } from './constants';

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

/**
 * Which `blockchains.environment` value each deployment selects its network by.
 *
 * The map is exhaustive on purpose: a deployment whose name is not listed selects nothing and runs
 * with Cardano off. Reading an unknown name as a test environment is how a production process ends
 * up operating a Preprod network, which is a deployment issuing addresses under an identity nobody
 * chose and reporting success.
 */
const DEPLOYMENT_ENVIRONMENTS: Readonly<Record<string, string>> = {
  localhost: 'TEST',
  development: 'TEST',
  testing: 'TEST',
  production: 'PRODUCTION'
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
 * The `environment` value this deployment selects its Cardano document by.
 *
 * @returns The value, or `null` when the deployment name maps to none.
 */
export function cardanoDocumentEnvironment(): string | null {
  return DEPLOYMENT_ENVIRONMENTS[$B.trim().toLowerCase()] ?? null;
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

/**
 * Reads a provider root URL.
 *
 * Trailing slashes are stripped so a path is never built with a double one, and stripped *after*
 * the emptiness test so a value of nothing but slashes reads as a value that resolved to nothing —
 * a misconfiguration to report, not an absent setting.
 *
 * @param raw - The value as stored.
 * @returns The root, or `null` when it is absent or not an http(s) URL.
 */
function readProviderUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw.trim().replace(/\/+$/, '');
  if (stripped === '') return null;
  try {
    const { protocol } = new URL(stripped);
    return protocol === 'http:' || protocol === 'https:' ? stripped : null;
  } catch {
    return null;
  }
}

/**
 * Reads an explorer base URL.
 *
 * Trailing slashes are kept, unlike the provider root: the transaction id is appended directly to
 * this string, so stripping the slash off `/transaction/` produces a link to nothing.
 *
 * @param raw - The value as stored.
 * @returns The base URL, or `null` when it is absent or not an http(s) URL.
 */
function readExplorerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === 'http:' || protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a stored count is usable.
 *
 * @param raw - The value as stored.
 * @returns Whether it is a whole number above zero.
 */
function isPositiveInteger(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0;
}

/**
 * Checks one document's fields.
 *
 * The order is the order a reader can act on: the network first, because it decides which chain id
 * is the right one, then the chain id, then the values a transfer is built and reported from.
 *
 * @param document - The selected network document.
 * @returns The settings, or the reason they are unusable.
 */
function validate(document: IBlockchain): CardanoNetworkSettingsState {
  const network = resolveCardanoNetwork(document.network ?? '');
  if (network === null) return { status: 'failed', reason: 'network_unknown' };

  const { chainId } = document;
  if (!isPositiveInteger(chainId)) return { status: 'failed', reason: 'chain_id_invalid' };
  // Compared against the frozen constant, never replaced by it: the value that leaves here is the
  // stored one, and a document naming the other network's id is refused rather than corrected.
  if (chainId !== cardanoChainIdOf(network)) {
    return { status: 'failed', reason: 'chain_id_mismatch' };
  }

  const providerUrl = readProviderUrl(document.providerUrl);
  if (providerUrl === null) return { status: 'failed', reason: 'provider_missing' };

  const { ttlSlots, depositConfirmations } = document;
  if (!isPositiveInteger(ttlSlots)) return { status: 'failed', reason: 'ttl_invalid' };
  if (!isPositiveInteger(depositConfirmations)) {
    return { status: 'failed', reason: 'deposit_confirmations_invalid' };
  }

  const explorerUrl = readExplorerUrl(document.explorer);
  if (explorerUrl === null) return { status: 'failed', reason: 'explorer_invalid' };

  return {
    status: 'loaded',
    settings: { network, chainId, providerUrl, ttlSlots, depositConfirmations, explorerUrl }
  };
}

/**
 * Selects this deployment's Cardano document and checks it.
 *
 * The selection is by family and by the environment the deployment maps to, and it demands exactly
 * one match. Neither half is optional: a query on the family alone picks whichever document the
 * database happens to return first, which on a database holding both networks is how a testnet
 * deployment starts operating mainnet.
 *
 * @returns The state to publish.
 */
async function readCardanoNetworkSettings(): Promise<CardanoNetworkSettingsState> {
  const environment = cardanoDocumentEnvironment();
  if (environment === null) return { status: 'failed', reason: 'deployment_unknown' };

  let documents: IBlockchain[];
  try {
    documents = await Blockchain.find({ family: 'cardano' });
  } catch (error) {
    Logger.error('cardanoNetworkSettings', 'Could not read the Cardano networks', error);
    return { status: 'failed', reason: 'settings_unreadable' };
  }

  const selected = documents.filter(
    (document) => (document.environment ?? '').trim().toUpperCase() === environment
  );
  if (selected.length === 0) return { status: 'failed', reason: 'settings_missing' };
  if (selected.length > 1) return { status: 'failed', reason: 'settings_ambiguous' };

  return validate(selected[0]);
}

/**
 * Reads the network settings at startup and publishes them.
 *
 * Never throws and never exits: an unusable Cardano document is a reason to keep Cardano off, not a
 * reason to leave the port closed. EVM transfers, the bot webhooks and the health check come up
 * exactly as they did.
 *
 * @returns The state it published, so a caller can log or assert on it.
 */
export async function loadCardanoNetworkSettings(): Promise<CardanoNetworkSettingsState> {
  let next: CardanoNetworkSettingsState;
  try {
    next = await readCardanoNetworkSettings();
  } catch (error) {
    Logger.error('cardanoNetworkSettings', 'Could not resolve the Cardano network', error);
    next = { status: 'failed', reason: 'settings_unreadable' };
  }

  recordCardanoNetworkSettings(next);

  if (next.status === 'loaded') {
    Logger.log(
      'cardanoNetworkSettings',
      `Cardano ${next.settings.network} (${next.settings.chainId}) selected for ${$B}`
    );
  } else {
    // A code, never the values behind it: this line describes the deployment's configuration and
    // ends up wherever logs are shipped.
    Logger.error(
      'cardanoNetworkSettings',
      `No usable Cardano network for ${$B}: ${next.status === 'failed' ? next.reason : 'unloaded'}. ` +
        'Cardano stays off; everything else runs.'
    );
  }

  return next;
}

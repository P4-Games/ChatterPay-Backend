/**
 * The startup read that decides which Cardano network this deployment operates, and on what values.
 *
 * Separate from `cardanoNetworkSettings`, which holds the answer, because this half needs Mongoose
 * and the environment and that half must not: the published state is reached from the configuration
 * and from test fixtures that run while `constants` is still being mocked, and a module that
 * touches both ends deadlocks the loader that would resolve it.
 *
 * The document is read once and published for the synchronous readers. A change to any of these six
 * fields takes effect on the next restart, not on the next request: they decide the address prefix,
 * the key derivation and the transaction validity window, and a value that can change under a
 * half-built transaction is a value two parts of one operation can disagree about.
 */

import { Logger } from '../helpers/loggerHelper';
import Blockchain, { type IBlockchain } from '../models/blockchainModel';
import {
  type CardanoNetworkSettingsState,
  cardanoChainIdOf,
  recordCardanoNetworkSettings,
  resolveCardanoNetwork
} from './cardanoNetworkSettings';
import { $B } from './constants';

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

/**
 * The `environment` value this deployment selects its Cardano document by.
 *
 * @returns The value, or `null` when the deployment name maps to none.
 */
export function cardanoDocumentEnvironment(): string | null {
  return DEPLOYMENT_ENVIRONMENTS[$B.trim().toLowerCase()] ?? null;
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
    Logger.error('cardanoNetworkLoader', 'Could not read the Cardano networks', error);
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
    Logger.error('cardanoNetworkLoader', 'Could not resolve the Cardano network', error);
    next = { status: 'failed', reason: 'settings_unreadable' };
  }

  recordCardanoNetworkSettings(next);

  if (next.status === 'loaded') {
    Logger.log(
      'cardanoNetworkLoader',
      `Cardano ${next.settings.network} (${next.settings.chainId}) selected for ${$B}`
    );
  } else {
    // A code, never the values behind it: this line describes the deployment's configuration and
    // ends up wherever logs are shipped.
    Logger.error(
      'cardanoNetworkLoader',
      `No usable Cardano network for ${$B}: ${next.status === 'failed' ? next.reason : 'unloaded'}. ` +
        'Cardano stays off; everything else runs.'
    );
  }

  return next;
}

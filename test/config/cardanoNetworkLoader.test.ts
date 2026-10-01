import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadCardanoNetworkSettings } from '../../src/config/cardanoNetworkLoader';
import {
  CARDANO_MAINNET_CHAIN_ID,
  CARDANO_PREPROD_CHAIN_ID,
  getCardanoNetworkSettingsState,
  resetCardanoNetworkSettings
} from '../../src/config/cardanoNetworkSettings';
import Blockchain, { type IBlockchain } from '../../src/models/blockchainModel';

/**
 * Where the six operational settings of a Cardano network come from, and what happens when the
 * document that holds them cannot be used.
 *
 * Two things are being pinned. The first is the selection: which document a deployment operates is
 * decided by the family and by the environment the deployment maps to, and a database that answers
 * none or several of those is a database this deployment does not act on. The second is the
 * validation: each field is checked on its own and a bad one switches Cardano off, because the
 * alternative — a default that looks right — issues addresses, builds transactions and writes rows
 * under an identity nobody chose.
 */

/**
 * Which deployment this process is, for the case being run.
 *
 * Hoisted, because the mock factory below runs before anything else in this file. Read through a
 * getter so a case can change it without reloading the module.
 */
const state = vi.hoisted(() => ({ deployment: 'development' }));

vi.mock('../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/constants')>();
  return Object.defineProperties(
    { ...actual },
    { $B: { get: () => state.deployment, enumerable: true } }
  );
});

/** The Preprod document as it is stored, which is the one local and Develop operate. */
function preprodDoc(patch: Partial<IBlockchain> = {}): Partial<IBlockchain> {
  return {
    name: 'Cardano Preprod',
    family: 'cardano',
    chainId: CARDANO_PREPROD_CHAIN_ID,
    environment: 'TEST',
    explorer: 'https://preprod.cardanoscan.io/transaction/',
    network: 'preprod',
    providerUrl: 'https://preprod.koios.rest/api/v1',
    ttlSlots: 900,
    depositConfirmations: 3,
    limits: { transfer: { L1: { D: 14 }, L2: { D: 100 } } },
    ...patch
  } as Partial<IBlockchain>;
}

/**
 * Stores a document without going through the schema's required fields.
 *
 * Some cases need a value the schema would refuse — a network nobody can read, a TTL of zero — and
 * the point of those cases is that the *reader* refuses them. A row written before a validator
 * existed, or written by hand, reaches this code exactly this way.
 *
 * @param patch - What this case changes about the stored Preprod document.
 */
async function store(patch: Partial<IBlockchain> = {}): Promise<void> {
  await Blockchain.collection.insertOne(preprodDoc(patch) as never);
}

/**
 * Runs the startup read.
 *
 * @returns The state it published.
 */
async function load() {
  await loadCardanoNetworkSettings();
  return getCardanoNetworkSettingsState();
}

beforeEach(() => {
  state.deployment = 'development';
  resetCardanoNetworkSettings();
});

describe('cardanoNetworkSettings - the starting state', () => {
  it('is unloaded, never a network', () => {
    // A process that fell over before the startup read, or that never ran it, has no network. The
    // one thing this must not be is a Preprod nobody configured.
    expect(getCardanoNetworkSettingsState()).toEqual({ status: 'unloaded' });
  });
});

describe('cardanoNetworkSettings - selecting the document', () => {
  it('reads the stored Preprod network for a test deployment', async () => {
    await store();
    expect(await load()).toEqual({
      status: 'loaded',
      settings: {
        network: 'testnet',
        chainId: CARDANO_PREPROD_CHAIN_ID,
        providerUrl: 'https://preprod.koios.rest/api/v1',
        ttlSlots: 900,
        depositConfirmations: 3,
        explorerUrl: 'https://preprod.cardanoscan.io/transaction/'
      }
    });
  });

  it.each([
    'localhost',
    'development',
    'testing'
  ])('selects the TEST document from %s', async (deployment) => {
    state.deployment = deployment;
    await store();
    expect(await load()).toMatchObject({ status: 'loaded' });
  });

  it('selects nothing for a deployment that maps to no environment', async () => {
    // Reading an unknown deployment name as a test environment is how a process nobody accounted
    // for ends up operating whichever network happens to be marked TEST.
    state.deployment = 'staging';
    await store();
    expect(await load()).toEqual({ status: 'failed', reason: 'deployment_unknown' });
  });

  it('refuses the mainnet document when the deployment is a test one', async () => {
    // The failure the environment half of the selection exists for: with the family alone, this is
    // the document a testnet deployment would come up operating.
    await store({
      name: 'Cardano Mainnet',
      environment: 'PRODUCTION',
      network: 'mainnet',
      chainId: CARDANO_MAINNET_CHAIN_ID,
      providerUrl: 'https://api.koios.rest/api/v1',
      explorer: 'https://cardanoscan.io/transaction/'
    });
    expect(await load()).toEqual({ status: 'failed', reason: 'settings_missing' });
  });

  it('keeps the right document when both networks are stored', async () => {
    await store();
    await store({
      name: 'Cardano Mainnet',
      environment: 'PRODUCTION',
      network: 'mainnet',
      chainId: CARDANO_MAINNET_CHAIN_ID,
      providerUrl: 'https://api.koios.rest/api/v1',
      explorer: 'https://cardanoscan.io/transaction/'
    });
    expect(await load()).toMatchObject({
      status: 'loaded',
      settings: { network: 'testnet', chainId: CARDANO_PREPROD_CHAIN_ID }
    });
  });

  it('refuses two documents for one deployment rather than picking the first', async () => {
    // Which of them is the network is a question nobody answered, and answering it by insertion
    // order means a restart can move the deployment to the other one without a change anywhere.
    await store();
    await store({ name: 'Cardano Preprod (copy)' });
    expect(await load()).toEqual({ status: 'failed', reason: 'settings_ambiguous' });
  });

  it('reports no document at all rather than coming up on a default', async () => {
    expect(await load()).toEqual({ status: 'failed', reason: 'settings_missing' });
  });

  it('ignores the case and padding of the stored environment', async () => {
    await store({ environment: ' test ' });
    expect(await load()).toMatchObject({ status: 'loaded' });
  });

  it('never looks at an EVM network', async () => {
    await Blockchain.collection.insertOne({
      name: 'Scroll Sepolia',
      family: 'evm',
      chainId: 534351,
      environment: 'TEST'
    } as never);
    expect(await load()).toEqual({ status: 'failed', reason: 'settings_missing' });
  });
});

describe('cardanoNetworkSettings - the network', () => {
  it.each([
    'preprod',
    'Preprod',
    'PREPROD',
    'testnet',
    'TestNet',
    ' testnet '
  ])('reads %j as testnet', async (network) => {
    await store({ network });
    expect(await load()).toMatchObject({ status: 'loaded', settings: { network: 'testnet' } });
  });

  it.each(['mainnet', 'Mainnet', 'MAINNET'])('reads %j as mainnet', async (network) => {
    state.deployment = 'production';
    await store({
      environment: 'PRODUCTION',
      network,
      chainId: CARDANO_MAINNET_CHAIN_ID,
      explorer: 'https://cardanoscan.io/transaction/'
    });
    expect(await load()).toMatchObject({ status: 'loaded', settings: { network: 'mainnet' } });
  });

  it.each([
    'mainet',
    'main net',
    'prod',
    'preview',
    'cardano',
    ''
  ])('refuses %j instead of quietly using testnet', async (network) => {
    await store({ network });
    expect(await load()).toEqual({ status: 'failed', reason: 'network_unknown' });
  });
});

describe('cardanoNetworkSettings - the chain id', () => {
  it('reports the network first, because the network decides which id is the right one', async () => {
    await store({ network: 'mainet', chainId: 0 });
    expect(await load()).toEqual({ status: 'failed', reason: 'network_unknown' });
  });

  it.each([
    0,
    -900000000001,
    1.5,
    Number.MAX_SAFE_INTEGER + 2
  ])('refuses %s as a chain id', async (chainId) => {
    await store({ chainId });
    expect(await load()).toEqual({ status: 'failed', reason: 'chain_id_invalid' });
  });

  it('refuses the other network id rather than deriving under an identity nobody chose', async () => {
    // The network decides the address prefix and the chain id goes into the key derivation, so
    // this is a deployment issuing mainnet addresses under preprod keys.
    await store({ chainId: CARDANO_MAINNET_CHAIN_ID });
    expect(await load()).toEqual({ status: 'failed', reason: 'chain_id_mismatch' });
  });

  it('refuses the chain id of an EVM network', async () => {
    // Scroll Sepolia, the deployment's own default chain. Accepting it would point the Cardano
    // token catalogue and every wallet row at another network's rows.
    await store({ chainId: 534351 });
    expect(await load()).toEqual({ status: 'failed', reason: 'chain_id_mismatch' });
  });

  it('answers with the stored id, not with the constant it was checked against', async () => {
    await store();
    const loaded = await load();
    expect(loaded).toMatchObject({ status: 'loaded' });
    // The same number either way here, which is the point: the constant proved the stored value
    // right, and a document that disagreed would have been refused rather than corrected.
    expect(loaded.status === 'loaded' && loaded.settings.chainId).toBe(CARDANO_PREPROD_CHAIN_ID);
  });
});

describe('cardanoNetworkSettings - the provider root', () => {
  it('strips trailing slashes, so a path is never built with a double one', async () => {
    await store({ providerUrl: 'https://example.test/api/v1///' });
    expect(await load()).toMatchObject({
      status: 'loaded',
      settings: { providerUrl: 'https://example.test/api/v1' }
    });
  });

  it.each([
    '',
    '   ',
    '///',
    'not a url at all',
    'ftp://example.test'
  ])('refuses %j rather than falling back to a default root', async (providerUrl) => {
    await store({ providerUrl });
    expect(await load()).toEqual({ status: 'failed', reason: 'provider_missing' });
  });
});

describe('cardanoNetworkSettings - the transaction settings', () => {
  it.each([0, -1, 1.5])('refuses %s slots of validity', async (ttlSlots) => {
    await store({ ttlSlots });
    expect(await load()).toEqual({ status: 'failed', reason: 'ttl_invalid' });
  });

  it.each([0, -1, 2.5])('refuses %s confirmations', async (depositConfirmations) => {
    await store({ depositConfirmations });
    expect(await load()).toEqual({
      status: 'failed',
      reason: 'deposit_confirmations_invalid'
    });
  });

  it('takes the stored values rather than any default', async () => {
    await store({ ttlSlots: 120, depositConfirmations: 1 });
    expect(await load()).toMatchObject({
      status: 'loaded',
      settings: { ttlSlots: 120, depositConfirmations: 1 }
    });
  });
});

describe('cardanoNetworkSettings - the explorer', () => {
  it('keeps the trailing slash, because the transaction id is appended directly', async () => {
    // Stripping it the way the provider root is stripped produces a link to nothing.
    await store();
    expect(await load()).toMatchObject({
      status: 'loaded',
      settings: { explorerUrl: 'https://preprod.cardanoscan.io/transaction/' }
    });
  });

  it.each([
    '',
    '   ',
    'cardanoscan.io/transaction/'
  ])('refuses %j rather than building links from it', async (explorer) => {
    await store({ explorer });
    expect(await load()).toEqual({ status: 'failed', reason: 'explorer_invalid' });
  });
});

describe('cardanoNetworkSettings - what a refusal says', () => {
  it('never names a setting, because the reason reaches the caller', async () => {
    for (const patch of [
      { network: 'mainet' },
      { chainId: 534351 },
      { providerUrl: '' },
      { ttlSlots: 0 },
      { depositConfirmations: 0 },
      { explorer: '' }
    ]) {
      await Blockchain.collection.deleteMany({});
      resetCardanoNetworkSettings();
      await store(patch);
      const result = await load();
      expect(result.status, JSON.stringify(patch)).toBe('failed');
      expect(result.status === 'failed' && result.reason).not.toMatch(/CARDANO_|_INTERNAL_/);
    }
  });
});

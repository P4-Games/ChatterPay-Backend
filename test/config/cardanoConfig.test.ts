import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CARDANO_MAINNET_CHAIN_ID,
  CARDANO_PREPROD_CHAIN_ID,
  getCardanoConfig,
  isCardanoChainId
} from '../../src/config/cardanoConfig';

/**
 * Everything `getCardanoConfig` reads, so each test starts from a known blank.
 *
 * Read as a list rather than snapshotting the whole environment: the point is to be explicit about
 * which variables this function depends on, and a snapshot would hide a new one being added.
 */
const VARIABLES = [
  'CARDANO_ENABLED',
  'CARDANO_NETWORK',
  'CARDANO_CHAIN_ID',
  'CARDANO_PROVIDER_URL',
  'CARDANO_PROVIDER_TIMEOUT_MS',
  'CARDANO_TTL_SLOTS',
  'CARDANO_DEPOSIT_CONFIRMATIONS',
  'CARDANO_EXPLORER_URL',
  'SEED_INTERNAL_SALT'
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  VARIABLES.forEach((name) => {
    saved[name] = process.env[name];
    delete process.env[name];
  });
  // The two things a usable configuration needs beyond the network, so that each test below is
  // about the network and nothing else.
  process.env.CARDANO_ENABLED = 'true';
  process.env.SEED_INTERNAL_SALT = 'test-salt';
});

afterEach(() => {
  VARIABLES.forEach((name) => {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  });
});

describe('getCardanoConfig - CARDANO_NETWORK', () => {
  it('reads mainnet whatever the case', () => {
    // A capital letter in a Cloud Build substitution must not become a deployment that issues
    // testnet addresses on mainnet. They are well-formed and unspendable, and nothing downstream
    // notices.
    for (const value of ['mainnet', 'Mainnet', 'MAINNET', 'MainNet', '  mainnet  ']) {
      process.env.CARDANO_NETWORK = value;
      const config = getCardanoConfig();
      expect(config.network, value).toBe('mainnet');
      expect(config.enabled, value).toBe(true);
      expect(config.chainId, value).toBe(CARDANO_MAINNET_CHAIN_ID);
      expect(config.explorerUrl, value).toBe('https://cardanoscan.io/transaction/');
      expect(config.providerUrl, value).toBe('https://api.koios.rest/api/v1');
    }
  });

  it('reads the testnet spellings whatever the case', () => {
    for (const value of ['preprod', 'Preprod', 'PREPROD', 'testnet', 'TestNet', ' preprod ']) {
      process.env.CARDANO_NETWORK = value;
      const config = getCardanoConfig();
      expect(config.network, value).toBe('testnet');
      expect(config.enabled, value).toBe(true);
      expect(config.chainId, value).toBe(CARDANO_PREPROD_CHAIN_ID);
      expect(config.explorerUrl, value).toBe('https://preprod.cardanoscan.io/transaction/');
    }
  });

  it('falls back to testnet when the variable is absent or empty', () => {
    // "Not configured" is a different thing from "configured wrong", and testnet is the safe
    // default for it.
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env.CARDANO_NETWORK;
      else process.env.CARDANO_NETWORK = value;
      const config = getCardanoConfig();
      expect(config.network, String(value)).toBe('testnet');
      expect(config.enabled, String(value)).toBe(true);
    }
  });

  it('refuses a value it cannot read instead of quietly using testnet', () => {
    // `mainet` is not a request for testnet, it is a typo. Answering it with a silent testnet is
    // exactly the failure the case-insensitivity above exists to prevent.
    for (const value of ['mainet', 'main net', 'prod', 'preview', 'cardano']) {
      process.env.CARDANO_NETWORK = value;
      const config = getCardanoConfig();
      expect(config.enabled, value).toBe(false);
      expect(config.disabledReason, value).toContain('CARDANO_NETWORK');
      expect(config.disabledReason, value).toContain(value);
    }
  });
});

describe('getCardanoConfig - the disabled reasons, in order', () => {
  it('reports the flag first, because nothing else matters when it is off', () => {
    process.env.CARDANO_ENABLED = 'false';
    process.env.CARDANO_NETWORK = 'nonsense';
    const config = getCardanoConfig();
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe('CARDANO_ENABLED is not true');
  });

  it('stays off without the salt, even with everything else in place', () => {
    // Deriving from an empty salt would produce well-formed addresses anybody who knows the phone
    // number can spend from.
    delete process.env.SEED_INTERNAL_SALT;
    process.env.CARDANO_NETWORK = 'mainnet';
    const config = getCardanoConfig();
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe('SEED_INTERNAL_SALT is not configured');
  });

  it('reads the flag case-insensitively too', () => {
    for (const value of ['true', 'TRUE', 'True']) {
      process.env.CARDANO_ENABLED = value;
      expect(getCardanoConfig().enabled, value).toBe(true);
    }
    for (const value of ['false', 'yes', '1', '']) {
      process.env.CARDANO_ENABLED = value;
      expect(getCardanoConfig().enabled, value).toBe(false);
    }
  });
});

describe('getCardanoConfig - numeric settings', () => {
  it('uses the declared defaults when unset', () => {
    process.env.CARDANO_NETWORK = 'preprod';
    const config = getCardanoConfig();
    expect(config.providerTimeoutMs).toBe(20_000);
    expect(config.ttlSlots).toBe(900);
    expect(config.depositConfirmations).toBe(3);
  });

  it('ignores a value that is not a usable positive integer', () => {
    process.env.CARDANO_NETWORK = 'preprod';
    for (const value of ['0', '-5', 'abc', '']) {
      process.env.CARDANO_TTL_SLOTS = value;
      expect(getCardanoConfig().ttlSlots, value).toBe(900);
    }
  });

  it('takes an explicit chain id over the default for the network', () => {
    process.env.CARDANO_NETWORK = 'mainnet';
    process.env.CARDANO_CHAIN_ID = '900000000001';
    expect(getCardanoConfig().chainId).toBe(CARDANO_PREPROD_CHAIN_ID);
  });
});

describe('getCardanoConfig - providerUrl', () => {
  it('strips trailing slashes, so a path is never built with a double one', () => {
    process.env.CARDANO_NETWORK = 'preprod';
    process.env.CARDANO_PROVIDER_URL = 'https://example.test/api/v1///';
    expect(getCardanoConfig().providerUrl).toBe('https://example.test/api/v1');
  });
});

describe('isCardanoChainId', () => {
  it('recognises both Cardano networks and nothing else', () => {
    expect(isCardanoChainId(CARDANO_PREPROD_CHAIN_ID)).toBe(true);
    expect(isCardanoChainId(CARDANO_MAINNET_CHAIN_ID)).toBe(true);
    // Scroll Sepolia, Arbitrum Sepolia, Ethereum: the ids that must never route to Cardano.
    for (const chainId of [534351, 421614, 1, 0]) {
      expect(isCardanoChainId(chainId), String(chainId)).toBe(false);
    }
  });
});

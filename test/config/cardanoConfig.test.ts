import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CARDANO_MAINNET_CHAIN_ID,
  CARDANO_PREPROD_CHAIN_ID,
  getCardanoConfig,
  isCardanoChainId
} from '../../src/config/cardanoConfig';
import { resetCardanoEnv, setCardanoEnv } from '../support/cardanoEnv';

vi.mock('../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

beforeEach(() => {
  // Every test starts from a blank configuration with the family switched on, so that each one is
  // about the setting it names and nothing else.
  resetCardanoEnv();
  setCardanoEnv({ enabled: true });
});

describe('getCardanoConfig - the network', () => {
  it('reads mainnet whatever the case', () => {
    // A capital letter in a Cloud Build substitution must not become a deployment that issues
    // testnet addresses on mainnet. They are well-formed and unspendable, and nothing downstream
    // notices.
    for (const value of ['mainnet', 'Mainnet', 'MAINNET', 'MainNet']) {
      setCardanoEnv({ network: value });
      const config = getCardanoConfig();
      expect(config.network, value).toBe('mainnet');
      expect(config.enabled, value).toBe(true);
      expect(config.chainId, value).toBe(CARDANO_MAINNET_CHAIN_ID);
      expect(config.explorerUrl, value).toBe('https://cardanoscan.io/transaction/');
      expect(config.providerUrl, value).toBe('https://api.koios.rest/api/v1');
    }
  });

  it('reads the testnet spellings whatever the case', () => {
    for (const value of ['preprod', 'Preprod', 'PREPROD', 'testnet', 'TestNet']) {
      setCardanoEnv({ network: value });
      const config = getCardanoConfig();
      expect(config.network, value).toBe('testnet');
      expect(config.enabled, value).toBe(true);
      expect(config.chainId, value).toBe(CARDANO_PREPROD_CHAIN_ID);
      expect(config.explorerUrl, value).toBe('https://preprod.cardanoscan.io/transaction/');
    }
  });

  it('falls back to testnet when nothing was configured', () => {
    // "Not configured" is a different thing from "configured wrong", and testnet is the safe
    // default for it.
    setCardanoEnv({ network: '' });
    const config = getCardanoConfig();
    expect(config.network).toBe('testnet');
    expect(config.enabled).toBe(true);
  });

  it('refuses a value it cannot read instead of quietly using testnet', () => {
    // `mainet` is not a request for testnet, it is a typo. Answering it with a silent testnet is
    // exactly the failure the case-insensitivity above exists to prevent.
    for (const value of ['mainet', 'main net', 'prod', 'preview', 'cardano']) {
      setCardanoEnv({ network: value });
      const config = getCardanoConfig();
      expect(config.enabled, value).toBe(false);
      expect(config.disabledReason, value).toBe('network_unknown');
    }
  });
});

describe('getCardanoConfig - the disabled reasons, in order', () => {
  it('reports the flag first, because nothing else matters when it is off', () => {
    setCardanoEnv({ enabled: false, network: 'nonsense' });
    const config = getCardanoConfig();
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe('flag_off');
  });

  it('stays off without the master secret, even with everything else in place', () => {
    // Deriving without it would produce well-formed addresses that are not this deployment's.
    setCardanoEnv({ hasSecret: false });
    setCardanoEnv({ network: 'mainnet' });
    const config = getCardanoConfig();
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe('secret_missing');
  });

  it('stays off when a derivation label cannot be read', () => {
    // An unreadable label is not a different address: two of them resolving to nothing collapse
    // the payment and staking credentials of an address into one key.
    setCardanoEnv({ labelsReadable: false });
    setCardanoEnv({ network: 'mainnet' });
    const config = getCardanoConfig();
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe('labels_unreadable');
  });

  it('never names the setting behind a reason, because the reason reaches the caller', () => {
    // The answer a user sees must not describe this deployment's configuration. Each state is
    // built on its own: the chain short-circuits, so one case only ever reaches one code.
    const states: Array<[string, () => void]> = [
      ['flag_off', () => setCardanoEnv({ enabled: false })],
      ['network_unknown', () => setCardanoEnv({ network: 'mainet' })],
      ['provider_missing', () => setCardanoEnv({ providerUrl: '///' })],
      ['secret_missing', () => setCardanoEnv({ hasSecret: false })],
      ['labels_unreadable', () => setCardanoEnv({ labelsReadable: false })]
    ];

    for (const [expected, arrange] of states) {
      resetCardanoEnv();
      setCardanoEnv({ enabled: true });
      arrange();
      const { disabledReason, enabled } = getCardanoConfig();
      expect(enabled, expected).toBe(false);
      expect(disabledReason, expected).toBe(expected);
      expect(disabledReason, expected).not.toMatch(/CARDANO_|_INTERNAL_/);
    }
  });

  it('is on only when the flag is on', () => {
    setCardanoEnv({ enabled: true });
    expect(getCardanoConfig().enabled).toBe(true);
    setCardanoEnv({ enabled: false });
    expect(getCardanoConfig().enabled).toBe(false);
  });
});

describe('getCardanoConfig - numeric settings', () => {
  it('uses the declared defaults when unset', () => {
    setCardanoEnv({ network: 'preprod' });
    const config = getCardanoConfig();
    expect(config.providerTimeoutMs).toBe(20_000);
    expect(config.ttlSlots).toBe(900);
    expect(config.depositConfirmations).toBe(3);
  });

  it('takes a configured value over the default', () => {
    setCardanoEnv({ network: 'preprod', ttlSlots: 120, depositConfirmations: 1 });
    const config = getCardanoConfig();
    expect(config.ttlSlots).toBe(120);
    expect(config.depositConfirmations).toBe(1);
  });

  it('takes an explicit chain id over the default for the network', () => {
    setCardanoEnv({ network: 'mainnet', chainId: CARDANO_PREPROD_CHAIN_ID });
    expect(getCardanoConfig().chainId).toBe(CARDANO_PREPROD_CHAIN_ID);
  });
});

describe('getCardanoConfig - providerUrl', () => {
  it('strips trailing slashes, so a path is never built with a double one', () => {
    setCardanoEnv({ network: 'preprod', providerUrl: 'https://example.test/api/v1///' });
    expect(getCardanoConfig().providerUrl).toBe('https://example.test/api/v1');
  });

  it('reports a configured root that resolves to nothing rather than using the default', () => {
    setCardanoEnv({ network: 'preprod', providerUrl: '///' });
    const config = getCardanoConfig();
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe('provider_missing');
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

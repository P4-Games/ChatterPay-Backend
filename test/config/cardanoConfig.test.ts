import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CARDANO_MAINNET_CHAIN_ID,
  CARDANO_PREPROD_CHAIN_ID,
  getCardanoConfig,
  isCardanoChainId
} from '../../src/config/cardanoConfig';
import { recordCardanoDerivationState } from '../../src/config/cardanoDerivationState';
import { resetCardanoNetworkSettings } from '../../src/config/cardanoNetworkSettings';
import type { CardanoDisabledReason } from '../../src/types/cardanoType';
import {
  failCardanoNetwork,
  markCardanoDerivationVerified,
  preprodNetworkSettings,
  resetCardanoEnv,
  setCardanoEnv,
  setCardanoNetwork
} from '../support/cardanoEnv';

vi.mock('../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

beforeEach(() => {
  // Every test starts from a blank configuration with the family switched on and the stored Preprod
  // network published, so that each one is about the setting it names and nothing else.
  resetCardanoEnv();
  setCardanoEnv({ enabled: true });
  setCardanoNetwork();
  // The startup check is what produces this, and no test here runs it. Stated so that each
  // test is about the setting it names; the verdict has a describe of its own below.
  markCardanoDerivationVerified();
});

describe('getCardanoConfig - where the network settings come from', () => {
  it('reports what the network document holds, field for field', () => {
    expect(getCardanoConfig()).toMatchObject({
      enabled: true,
      network: 'testnet',
      chainId: CARDANO_PREPROD_CHAIN_ID,
      providerUrl: 'https://preprod.koios.rest/api/v1',
      ttlSlots: 900,
      depositConfirmations: 3,
      explorerUrl: 'https://preprod.cardanoscan.io/transaction/'
    });
  });

  it('takes the stored values whatever they are, with no default underneath', () => {
    setCardanoNetwork({
      network: 'mainnet',
      chainId: CARDANO_MAINNET_CHAIN_ID,
      providerUrl: 'https://api.koios.rest/api/v1',
      ttlSlots: 120,
      depositConfirmations: 1,
      explorerUrl: 'https://cardanoscan.io/transaction/'
    });
    expect(getCardanoConfig()).toMatchObject({
      enabled: true,
      network: 'mainnet',
      chainId: CARDANO_MAINNET_CHAIN_ID,
      providerUrl: 'https://api.koios.rest/api/v1',
      ttlSlots: 120,
      depositConfirmations: 1,
      explorerUrl: 'https://cardanoscan.io/transaction/'
    });
  });
});

describe('getCardanoConfig - without a network document', () => {
  it('is off before the startup read has happened, rather than on Preprod', () => {
    // A process that fell over before the read, or that never ran it, has no network. Coming up on
    // a plausible default is how a deployment issues addresses nobody configured.
    resetCardanoNetworkSettings();
    expect(getCardanoConfig()).toMatchObject({
      enabled: false,
      disabledReason: 'settings_unloaded'
    });
  });

  it('carries no network, no chain id and no URLs while it is off', () => {
    resetCardanoNetworkSettings();
    const config = getCardanoConfig();
    expect(isCardanoChainId(config.chainId)).toBe(false);
    expect(config.providerUrl).toBe('');
    expect(config.explorerUrl).toBe('');
    expect(config.ttlSlots).toBe(0);
    expect(config.depositConfirmations).toBe(0);
  });

  it.each([
    'deployment_unknown',
    'settings_unreadable',
    'settings_missing',
    'settings_ambiguous',
    'network_unknown',
    'chain_id_invalid',
    'chain_id_mismatch',
    'provider_missing',
    'ttl_invalid',
    'deposit_confirmations_invalid',
    'explorer_invalid'
  ] as const)('reports %s exactly as the read concluded it', (reason: CardanoDisabledReason) => {
    failCardanoNetwork(reason);
    expect(getCardanoConfig()).toMatchObject({ enabled: false, disabledReason: reason });
  });

  it('never names a setting in those reasons either', () => {
    for (const reason of ['settings_missing', 'chain_id_mismatch', 'explorer_invalid'] as const) {
      failCardanoNetwork(reason);
      expect(getCardanoConfig().disabledReason).not.toMatch(/CARDANO_|_INTERNAL_/);
    }
  });
});

describe('getCardanoConfig - the disabled reasons, in order', () => {
  it('reports the flag first, because nothing else matters when it is off', () => {
    setCardanoEnv({ enabled: false });
    failCardanoNetwork('settings_missing');
    const config = getCardanoConfig();
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe('flag_off');
  });

  it('reports the network document before anything it would be used for', () => {
    // A deployment with no network has no provider root either, and reporting the credential would
    // send an operator to a secret when what is missing is a document.
    failCardanoNetwork('settings_missing');
    setCardanoEnv({ hasSecret: false });
    expect(getCardanoConfig().disabledReason).toBe('settings_missing');
  });

  it('stays off without the master secret, even with everything else in place', () => {
    // Deriving without it would produce well-formed addresses that are not this deployment's.
    setCardanoEnv({ hasSecret: false });
    const config = getCardanoConfig();
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe('secret_missing');
  });

  it('stays off when a derivation label cannot be read', () => {
    // An unreadable label is not a different address: two of them resolving to nothing collapse
    // the payment and staking credentials of an address into one key.
    setCardanoEnv({ labelsReadable: false });
    const config = getCardanoConfig();
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe('labels_unreadable');
  });

  it('never names the setting behind a reason, because the reason reaches the caller', () => {
    // The answer a user sees must not describe this deployment's configuration. Each state is
    // built on its own: the chain short-circuits, so one case only ever reaches one code.
    const states: Array<[string, () => void]> = [
      ['flag_off', () => setCardanoEnv({ enabled: false })],
      ['settings_missing', () => failCardanoNetwork('settings_missing')],
      ['network_unknown', () => failCardanoNetwork('network_unknown')],
      ['provider_missing', () => failCardanoNetwork('provider_missing')],
      [
        'provider_key_missing',
        () => {
          setCardanoNetwork({ providerUrl: 'https://cardano-preprod.blockfrost.io/api/v0' });
          setCardanoEnv({ providerApiKey: '' });
        }
      ],
      ['secret_missing', () => setCardanoEnv({ hasSecret: false })],
      ['labels_unreadable', () => setCardanoEnv({ labelsReadable: false })]
    ];

    for (const [expected, arrange] of states) {
      resetCardanoEnv();
      setCardanoEnv({ enabled: true });
      setCardanoNetwork();
      markCardanoDerivationVerified();
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
  it('uses the declared default for the provider timeout, which is not a network setting', () => {
    expect(getCardanoConfig().providerTimeoutMs).toBe(20_000);
  });

  it('takes a configured timeout over the default', () => {
    setCardanoEnv({ providerTimeoutMs: 5_000 });
    expect(getCardanoConfig().providerTimeoutMs).toBe(5_000);
  });
});

describe('getCardanoConfig - the chain id', () => {
  it('answers the id the network document holds', () => {
    expect(getCardanoConfig().chainId).toBe(CARDANO_PREPROD_CHAIN_ID);
    setCardanoNetwork({ network: 'mainnet', chainId: CARDANO_MAINNET_CHAIN_ID });
    expect(getCardanoConfig().chainId).toBe(CARDANO_MAINNET_CHAIN_ID);
  });

  it('answers a chain id no row carries while the family is off', () => {
    // The property the callers depend on: `Token.find({ chain_id })` and every wallet row take this
    // number, and a refused configuration must not hand them one that finds another network's rows.
    for (const reason of ['settings_missing', 'chain_id_mismatch', 'network_unknown'] as const) {
      failCardanoNetwork(reason);
      expect(isCardanoChainId(getCardanoConfig().chainId), reason).toBe(false);
    }
  });
});

describe('getCardanoConfig - the derivation verdict', () => {
  it('is off until the startup check has run', () => {
    // Pending is not ok. A process that fell over before the check, or never called it, has
    // verified nothing, and a configuration reporting the family on would be saying it had.
    recordCardanoDerivationState({ status: 'pending' });
    expect(getCardanoConfig()).toMatchObject({
      enabled: false,
      disabledReason: 'derivation_unverified'
    });
  });

  it('is off while there is nothing to compare this deployment against', () => {
    recordCardanoDerivationState({ status: 'unrecorded', scope: 'user' });
    expect(getCardanoConfig()).toMatchObject({
      enabled: false,
      disabledReason: 'derivation_unrecorded'
    });
  });

  it('is off when the sponsor derivation is the one nobody recorded', () => {
    // Same reason, different key. The sponsor signs and spends, so an unverified sponsor is not a
    // lesser state than an unverified user derivation.
    recordCardanoDerivationState({ status: 'unrecorded', scope: 'sponsor' });
    expect(getCardanoConfig().disabledReason).toBe('derivation_unrecorded');
  });

  it('is off when a derivation no longer matches what was recorded', () => {
    recordCardanoDerivationState({ status: 'changed', scope: 'sponsor' });
    expect(getCardanoConfig()).toMatchObject({
      enabled: false,
      disabledReason: 'derivation_changed'
    });
  });

  it('is read last, so a configuration fault is reported as itself', () => {
    // A deployment with no secret has a problem the operator can act on. Reporting it as a
    // derivation verdict would send them looking at the wrong setting.
    recordCardanoDerivationState({ status: 'changed', scope: 'user' });
    setCardanoEnv({ hasSecret: false });
    expect(getCardanoConfig().disabledReason).toBe('secret_missing');
  });

  it('is read after the network document, which the check needs before it can derive', () => {
    recordCardanoDerivationState({ status: 'changed', scope: 'user' });
    failCardanoNetwork('settings_missing');
    expect(getCardanoConfig().disabledReason).toBe('settings_missing');
  });

  it('never names a setting in its reasons either', () => {
    for (const state of [
      { status: 'pending' } as const,
      { status: 'unrecorded', scope: 'user' } as const,
      { status: 'changed', scope: 'sponsor' } as const
    ]) {
      recordCardanoDerivationState(state);
      expect(getCardanoConfig().disabledReason).not.toMatch(/CARDANO_|_INTERNAL_|addr/);
    }
  });
});

describe('getCardanoConfig - providerUrl', () => {
  it('carries the stored root through unchanged, because the document already stripped it', () => {
    setCardanoNetwork({ providerUrl: 'https://example.test/api/v1' });
    expect(getCardanoConfig().providerUrl).toBe('https://example.test/api/v1');
  });

  it('is empty while there is no network document, and never a default root', () => {
    failCardanoNetwork('provider_missing');
    expect(getCardanoConfig().providerUrl).toBe('');
  });
});

describe('getCardanoConfig - the provider kind', () => {
  it('reads Blockfrost off the host, whatever the path and the case', () => {
    for (const providerUrl of [
      'https://cardano-preprod.blockfrost.io/api/v0',
      'https://cardano-mainnet.blockfrost.io/api/v0',
      'https://BLOCKFROST.IO/api/v0'
    ]) {
      setCardanoNetwork({ providerUrl });
      setCardanoEnv({ providerApiKey: 'preprodkey' });
      expect(getCardanoConfig().providerKind, providerUrl).toBe('blockfrost');
    }
  });

  it('reads everything else as Koios, the public roots included', () => {
    for (const providerUrl of [
      'https://preprod.koios.rest/api/v1',
      // The host decides, not the string: a path or a query naming the other provider must not
      // switch the dialect, because the client that results would misread every answer.
      'https://preprod.koios.rest/api/v1/blockfrost.io'
    ]) {
      setCardanoNetwork({ providerUrl });
      expect(getCardanoConfig().providerKind, providerUrl).toBe('koios');
    }
  });

  it('carries the credential through to the config, for either provider', () => {
    setCardanoEnv({ providerApiKey: 'koios-bearer-token' });
    expect(getCardanoConfig().providerApiKey).toBe('koios-bearer-token');
  });

  it('stays on for a Koios root with no credential, because the public tier answers without one', () => {
    setCardanoEnv({ providerApiKey: '' });
    const config = getCardanoConfig();
    expect(config.enabled).toBe(true);
    expect(config.providerApiKey).toBe('');
  });

  it('goes off for a Blockfrost root with no credential, rather than 403 on every call', () => {
    // Starting would look like a chain that is down: every read and every submit fails, and the
    // user sees an outage instead of a deployment that was never finished being configured.
    setCardanoNetwork({ providerUrl: 'https://cardano-preprod.blockfrost.io/api/v0' });
    setCardanoEnv({ providerApiKey: '' });
    const config = getCardanoConfig();
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe('provider_key_missing');
    expect(config.disabledReason).not.toMatch(/CARDANO_|_INTERNAL_/);
  });

  it('does not send a Blockfrost credential to a Koios root', () => {
    // The pairing the provider kind exists to keep straight: the credential follows the stored
    // root, so a document moved to Koios is read as Koios whatever the environment still holds.
    setCardanoNetwork(preprodNetworkSettings());
    setCardanoEnv({ providerApiKey: 'preprodBlockfrostProjectId' });
    expect(getCardanoConfig().providerKind).toBe('koios');
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

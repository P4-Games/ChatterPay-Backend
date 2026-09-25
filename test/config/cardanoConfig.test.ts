import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CARDANO_MAINNET_CHAIN_ID,
  CARDANO_PREPROD_CHAIN_ID,
  getCardanoConfig,
  isCardanoChainId
} from '../../src/config/cardanoConfig';
import { recordCardanoDerivationState } from '../../src/config/cardanoDerivationState';
import {
  markCardanoDerivationVerified,
  resetCardanoEnv,
  setCardanoEnv
} from '../support/cardanoEnv';

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
  // The startup check is what produces this, and no test here runs it. Stated so that each
  // test is about the setting it names; the verdict has a describe of its own below.
  markCardanoDerivationVerified();
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
      [
        'provider_key_missing',
        () =>
          setCardanoEnv({
            providerUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
            providerApiKey: ''
          })
      ],
      ['secret_missing', () => setCardanoEnv({ hasSecret: false })],
      ['labels_unreadable', () => setCardanoEnv({ labelsReadable: false })]
    ];

    for (const [expected, arrange] of states) {
      resetCardanoEnv();
      setCardanoEnv({ enabled: true });
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

  it('accepts a chain id that states what the network already says', () => {
    setCardanoEnv({ network: 'mainnet', chainId: CARDANO_MAINNET_CHAIN_ID });
    expect(getCardanoConfig().chainId).toBe(CARDANO_MAINNET_CHAIN_ID);
    setCardanoEnv({ network: 'preprod', chainId: CARDANO_PREPROD_CHAIN_ID });
    expect(getCardanoConfig().chainId).toBe(CARDANO_PREPROD_CHAIN_ID);
  });
});

describe('getCardanoConfig - the chain id', () => {
  it('uses the network constant when nothing was configured', () => {
    // Omitting it is not a misconfiguration: the network already says which id it is.
    setCardanoEnv({ network: 'preprod', chainId: null });
    expect(getCardanoConfig()).toMatchObject({
      enabled: true,
      chainId: CARDANO_PREPROD_CHAIN_ID
    });
    setCardanoEnv({ network: 'mainnet', chainId: null });
    expect(getCardanoConfig()).toMatchObject({
      enabled: true,
      chainId: CARDANO_MAINNET_CHAIN_ID
    });
  });

  it('answers the same id for every spelling of a network', () => {
    for (const value of ['preprod', 'testnet', 'TestNet']) {
      setCardanoEnv({ network: value, chainId: CARDANO_PREPROD_CHAIN_ID });
      expect(getCardanoConfig().chainId, value).toBe(CARDANO_PREPROD_CHAIN_ID);
    }
  });

  it('refuses the other network id rather than deriving under an identity nobody chose', () => {
    // The combination that used to be accepted. The network decides the address prefix and the
    // chain id goes into the key derivation, so this is a deployment issuing mainnet addresses
    // under preprod keys and writing every row with the wrong network's id.
    setCardanoEnv({ network: 'mainnet', chainId: CARDANO_PREPROD_CHAIN_ID });
    expect(getCardanoConfig()).toMatchObject({
      enabled: false,
      disabledReason: 'chain_id_mismatch'
    });

    setCardanoEnv({ network: 'preprod', chainId: CARDANO_MAINNET_CHAIN_ID });
    expect(getCardanoConfig()).toMatchObject({
      enabled: false,
      disabledReason: 'chain_id_mismatch'
    });
  });

  it('refuses the chain id of an EVM network', () => {
    // Scroll Sepolia, the deployment's own default chain. Accepting it would point the Cardano
    // token catalogue and every wallet row at another network's rows.
    setCardanoEnv({ network: 'preprod', chainId: 534351 });
    expect(getCardanoConfig()).toMatchObject({
      enabled: false,
      disabledReason: 'chain_id_mismatch'
    });
  });

  it('refuses a value that is present and unusable instead of defaulting', () => {
    // What the reader answers for `abc`, `900000000001abc`, `0`, a negative, a decimal and
    // anything past the safe integer range. Each of those is a typo, and the one outcome a typo
    // must never have is the default.
    setCardanoEnv({ network: 'preprod', chainId: 'invalid' });
    expect(getCardanoConfig()).toMatchObject({
      enabled: false,
      disabledReason: 'chain_id_invalid'
    });
  });

  it('never answers with a chain id that is not one of the two, whatever was configured', () => {
    // The property the callers depend on: `Token.find({ chain_id })` and every wallet row take
    // this number, and a refused configuration must not hand them a third value to use.
    for (const chainId of ['invalid' as const, 534351, CARDANO_MAINNET_CHAIN_ID]) {
      setCardanoEnv({ network: 'preprod', chainId });
      expect(isCardanoChainId(getCardanoConfig().chainId), String(chainId)).toBe(true);
    }
  });

  it('reports the network first, because the network decides which id is the right one', () => {
    setCardanoEnv({ network: 'mainet', chainId: 'invalid' });
    expect(getCardanoConfig().disabledReason).toBe('network_unknown');
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

describe('getCardanoConfig - the provider kind', () => {
  it('reads Blockfrost off the host, whatever the path and the case', () => {
    for (const url of [
      'https://cardano-preprod.blockfrost.io/api/v0',
      'https://cardano-mainnet.blockfrost.io/api/v0/',
      'https://BLOCKFROST.IO/api/v0'
    ]) {
      setCardanoEnv({ network: 'preprod', providerUrl: url, providerApiKey: 'preprodkey' });
      expect(getCardanoConfig().providerKind, url).toBe('blockfrost');
    }
  });

  it('reads everything else as Koios, the default roots included', () => {
    for (const url of [
      '',
      'https://preprod.koios.rest/api/v1',
      // The host decides, not the string: a path or a query naming the other provider must not
      // switch the dialect, because the client that results would misread every answer.
      'https://preprod.koios.rest/api/v1/blockfrost.io',
      'not a url at all'
    ]) {
      setCardanoEnv({ network: 'preprod', providerUrl: url });
      expect(getCardanoConfig().providerKind, url || '(unset)').toBe('koios');
    }
  });

  it('carries the credential through to the config, for either provider', () => {
    setCardanoEnv({ network: 'preprod', providerApiKey: 'koios-bearer-token' });
    expect(getCardanoConfig().providerApiKey).toBe('koios-bearer-token');
  });

  it('stays on for a Koios root with no credential, because the public tier answers without one', () => {
    setCardanoEnv({ network: 'preprod', providerApiKey: '' });
    const config = getCardanoConfig();
    expect(config.enabled).toBe(true);
    expect(config.providerApiKey).toBe('');
  });

  it('goes off for a Blockfrost root with no credential, rather than 403 on every call', () => {
    // Starting would look like a chain that is down: every read and every submit fails, and the
    // user sees an outage instead of a deployment that was never finished being configured.
    setCardanoEnv({
      network: 'preprod',
      providerUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
      providerApiKey: ''
    });
    const config = getCardanoConfig();
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe('provider_key_missing');
    expect(config.disabledReason).not.toMatch(/CARDANO_|_INTERNAL_/);
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

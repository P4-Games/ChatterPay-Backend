import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../src/config/cardanoConfig';
import { isCardanoTransferRequest } from '../../src/controllers/cardanoTransactionController';
import type { IToken } from '../../src/models/tokenModel';
import { enableCardanoPreprod } from '../support/cardanoEnv';

vi.mock('../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

vi.mock('../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/constants')>();
  const { cardanoConstantsMock } = await import('../support/cardanoEnv');
  return cardanoConstantsMock(actual);
});

/** Chain id of the EVM network this instance operates on, as `.env` configures it. */
const EVM_CHAIN_ID = 534351;

const token = (symbol: string, chain_id: number): IToken => ({ symbol, chain_id }) as IToken;

/**
 * The catalogue as it looks once ADA and the native stablecoins are registered alongside the EVM
 * tokens — which is the situation the guard has to get right.
 */
const CATALOGUE: IToken[] = [
  token('USDT', EVM_CHAIN_ID),
  token('USDC', EVM_CHAIN_ID),
  token('WETH', EVM_CHAIN_ID),
  token('SCR', EVM_CHAIN_ID),
  token('ADA', CARDANO_PREPROD_CHAIN_ID),
  token('USDM', CARDANO_PREPROD_CHAIN_ID),
  token('USDA', CARDANO_PREPROD_CHAIN_ID),
  token('USDCx', CARDANO_PREPROD_CHAIN_ID)
];

/**
 * The dispatch guard sitting at the top of `makeTransaction`.
 *
 * These tests matter more for what they *reject* than for what they accept: a guard that is too
 * eager would divert an ordinary USDT transfer into the Cardano path, and the failure would show up
 * as a working EVM feature that suddenly stopped, not as a Cardano bug.
 */
beforeEach(() => {
  enableCardanoPreprod();
});

describe('isCardanoTransferRequest - routes to Cardano', () => {
  it('when the bot names the network', () => {
    for (const network of ['cardano', 'Cardano', ' cardano-preprod ']) {
      expect(
        isCardanoTransferRequest({ network, token: 'ADA' }, CATALOGUE, EVM_CHAIN_ID),
        network
      ).toBe(true);
    }
  });

  it('when the dashboard sends the chain id', () => {
    expect(
      isCardanoTransferRequest(
        { chain_id: String(CARDANO_PREPROD_CHAIN_ID) },
        CATALOGUE,
        EVM_CHAIN_ID
      )
    ).toBe(true);
  });

  it('when the ticker is one registered on Cardano', () => {
    // Resolved against the catalogue, not a hardcoded list: registering a stablecoin is a database
    // row, not a code change.
    for (const symbol of ['ADA', 'ada', ' ADA ', 'USDM', 'USDA', 'USDCx', 'usdcx']) {
      expect(isCardanoTransferRequest({ token: symbol }, CATALOGUE, EVM_CHAIN_ID), symbol).toBe(
        true
      );
    }
  });

  it('when the ticker is registered on Cardano and the EVM chain id is not supplied', () => {
    expect(isCardanoTransferRequest({ token: 'USDM' }, CATALOGUE)).toBe(true);
  });
});

describe('isCardanoTransferRequest - leaves EVM alone', () => {
  it('for ordinary same-chain transfers', () => {
    for (const symbol of ['USDT', 'USDC', 'WETH', 'SCR']) {
      expect(isCardanoTransferRequest({ token: symbol }, CATALOGUE, EVM_CHAIN_ID), symbol).toBe(
        false
      );
    }
  });

  it('for cross-chain transfers to other networks', () => {
    for (const network of ['arb', 'sol', 'btc', 'ethereum']) {
      expect(
        isCardanoTransferRequest({ token: 'USDC', network }, CATALOGUE, EVM_CHAIN_ID),
        network
      ).toBe(false);
    }
  });

  it('for EVM chain ids, including the ones this product runs on', () => {
    for (const chain_id of ['534351', '421614', '1', '137', '20000000000001']) {
      expect(
        isCardanoTransferRequest({ chain_id, token: 'USDC' }, CATALOGUE, EVM_CHAIN_ID),
        chain_id
      ).toBe(false);
    }
  });

  it('for a body with nothing that names a chain', () => {
    expect(isCardanoTransferRequest({}, CATALOGUE, EVM_CHAIN_ID)).toBe(false);
    expect(isCardanoTransferRequest({ token: '' }, CATALOGUE, EVM_CHAIN_ID)).toBe(false);
  });

  it('for a ticker nobody registered', () => {
    // No substring matching: `ADAX` and `CADA` are not ADA, and diverting them would send a
    // transfer to a chain that has never heard of them.
    for (const symbol of ['ADAX', 'CADA', 'DOGE']) {
      expect(isCardanoTransferRequest({ token: symbol }, CATALOGUE, EVM_CHAIN_ID), symbol).toBe(
        false
      );
    }
  });

  it('keeps a ticker listed on both families on EVM', () => {
    // The regression this guard exists to prevent: listing a token called USDC on Cardano must not
    // silently reroute the USDC transfers that work today. The caller can still be explicit.
    const bothFamilies = [...CATALOGUE, token('USDC', CARDANO_PREPROD_CHAIN_ID)];
    expect(isCardanoTransferRequest({ token: 'USDC' }, bothFamilies, EVM_CHAIN_ID)).toBe(false);
    expect(
      isCardanoTransferRequest({ token: 'USDC', network: 'cardano' }, bothFamilies, EVM_CHAIN_ID)
    ).toBe(true);
  });
});

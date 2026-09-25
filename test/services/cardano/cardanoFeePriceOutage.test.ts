import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getCardanoFeeConfig } from '../../../src/config/cardanoFeeConfig';
import { chatterPayFeeFor } from '../../../src/services/cardano/cardanoFeeService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import { executeCardanoTransfer } from '../../../src/services/cardano/cardanoTransferService';
import { FakeCardanoProvider } from '../../helpers/fakeCardanoProvider';
import { resetCardanoUtxoClaims } from '../../support/cardanoClaims';
import { resetCardanoEnv, setCardanoFeeEnv } from '../../support/cardanoEnv';

/**
 * What happens to a sponsored transfer when the fee cannot be priced.
 *
 * Under scheme 2 the fee is denominated in ADA and charged in whatever is moving, so a token
 * transfer needs both sides quoted. It used to answer zero when either quote was missing, with the
 * reasoning the USD scheme has: forgoing a few cents is cheaper than charging from a price nobody
 * could confirm. Under scheme 2 that reasoning does not hold. The fee is what covers the min-ADA of
 * the destination's new output and the network fee, both of which ChatterPay has already committed
 * to by the time the fee is worked out — so a transfer priced at zero is a transfer ChatterPay pays
 * for, in full, every time the price feed is down.
 */

/** Whatever the price feed answers for this case. */
const prices = vi.hoisted(() => ({ map: new Map<string, number>() }));

vi.mock('../../../src/services/balanceService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/balanceService')>();
  return { ...actual, getTokenPrices: async () => new Map(prices.map) };
});

vi.mock('../../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  const { cardanoConstantsMock } = await import('../../support/cardanoEnv');
  return cardanoConstantsMock(actual);
});

const CHAIN_ID = 900000000001;
const SENDER_PHONE = '5491100000001';
const RECIPIENT_PHONE = '5491100000002';

const USDCX = {
  policyId: '31dde3db98ad05feb688d4dbb146b3b6054e1246cbcef98c79b0bf66',
  assetName: Buffer.from('USDCx').toString('hex')
};

/** The scheme this is about: sponsored, priced in ADA, with the dearer figure for a new output. */
function schemeTwoCharging(): void {
  setCardanoFeeEnv({
    sponsorFees: true,
    sponsorWalletId: 'sponsor',
    feeScheme: 2,
    transferFeeAda: 0.45,
    transferFeeAdaNewOutput: 1.6
  });
}

beforeEach(() => {
  resetCardanoEnv();
  prices.map = new Map([
    ['ADA', 0.4],
    ['USDCX', 1]
  ]);
});

describe('pricing the fee for a sponsored token transfer', () => {
  it('charges what the configuration says while both sides are quoted', () => {
    schemeTwoCharging();

    // 1.6 ADA at 0.40 USD, in a token worth 1 USD, with six decimals.
    return expect(chatterPayFeeFor(getCardanoFeeConfig(), 'USDCx', 6, true)).resolves.toEqual({
      ok: true,
      units: 640_000n
    });
  });

  it('refuses when the price feed is down', async () => {
    schemeTwoCharging();
    prices.map = new Map();

    await expect(chatterPayFeeFor(getCardanoFeeConfig(), 'USDCx', 6, true)).resolves.toEqual({
      ok: false,
      reason: 'price_unavailable'
    });
  });

  it('refuses when only the ADA side is missing', async () => {
    // The fee is denominated in ADA, so this half is not optional even though the user is moving
    // something else.
    schemeTwoCharging();
    prices.map = new Map([['USDCX', 1]]);

    await expect(chatterPayFeeFor(getCardanoFeeConfig(), 'USDCx', 6, true)).resolves.toMatchObject({
      ok: false
    });
  });

  it('refuses when only the token side is missing', async () => {
    schemeTwoCharging();
    prices.map = new Map([['ADA', 0.4]]);

    await expect(chatterPayFeeFor(getCardanoFeeConfig(), 'USDCx', 6, true)).resolves.toMatchObject({
      ok: false
    });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY]
  ])('treats a %s quote as no quote at all', async (_label, value) => {
    schemeTwoCharging();
    prices.map = new Map([
      ['ADA', 0.4],
      ['USDCX', value]
    ]);

    await expect(chatterPayFeeFor(getCardanoFeeConfig(), 'USDCx', 6, true)).resolves.toMatchObject({
      ok: false
    });
  });
});

describe('what still does not depend on a price', () => {
  it('charges nothing, and asks nothing, when the fee is configured as zero', () => {
    // A deployment that decided to charge nothing is not a deployment with a broken price feed,
    // and must not be refused as if it were.
    setCardanoFeeEnv({
      sponsorFees: true,
      sponsorWalletId: 'sponsor',
      feeScheme: 2,
      transferFeeAda: 0,
      transferFeeAdaNewOutput: 0
    });
    prices.map = new Map();

    return expect(chatterPayFeeFor(getCardanoFeeConfig(), 'USDCx', 6, true)).resolves.toEqual({
      ok: true,
      units: 0n
    });
  });

  it('prices an ADA transfer with no feed at all', async () => {
    // The one path an outage cannot touch: 0.45 ADA is 450000 lovelace and that is the whole sum.
    schemeTwoCharging();
    prices.map = new Map();

    await expect(chatterPayFeeFor(getCardanoFeeConfig(), 'ADA', 6, false, true)).resolves.toEqual({
      ok: true,
      units: 450_000n
    });
  });

  it('keeps scheme 1 forgoing the fee, as it always has', async () => {
    // Deliberately not changed. The USD figure is a few cents and the sender funds their own
    // min-ADA under this scheme, so an outage costs ChatterPay the fee and nothing more.
    setCardanoFeeEnv({
      sponsorFees: true,
      sponsorWalletId: 'sponsor',
      feeScheme: 1,
      transferFeeUsd: 0.08
    });
    prices.map = new Map();

    await expect(chatterPayFeeFor(getCardanoFeeConfig(), 'USDCx', 6)).resolves.toEqual({
      ok: true,
      units: 0n
    });
  });
});

describe('the transfer that cannot be priced', () => {
  it('is refused without signing anything or spending the sponsor', async () => {
    resetCardanoUtxoClaims();
    schemeTwoCharging();
    prices.map = new Map();

    const provider = new FakeCardanoProvider();
    const sender = cardanoSignerService.getAccount(SENDER_PHONE, 'testnet', CHAIN_ID);
    const recipient = cardanoSignerService.getAccount(RECIPIENT_PHONE, 'testnet', CHAIN_ID);
    const sponsor = cardanoSignerService.getSponsorAccount('sponsor', 'testnet', CHAIN_ID);
    provider.fundWithAssets(sender.address, 5_000_000n, [{ ...USDCX, quantity: 10_000_000n }]);
    provider.fund(sponsor.address, 50_000_000n);

    const result = await executeCardanoTransfer({
      fromPhoneNumber: SENDER_PHONE,
      toAddress: recipient.address,
      amountLovelace: 0n,
      asset: { ...USDCX, quantity: 2_000_000n },
      tokenSymbol: 'USDCx',
      tokenDecimals: 6,
      isAda: false,
      provider,
      network: 'testnet',
      chainId: CHAIN_ID,
      ttlSlots: 900,
      depositConfirmations: 3,
      explorerUrl: 'https://preprod.cardanoscan.io/transaction/',
      logKey: '[test:cardano]'
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_FEE_PRICE_UNAVAILABLE');
    // What the refusal is for: nothing reached the chain, so nothing was paid for.
    expect(provider.submissions).toHaveLength(0);
    expect(provider.submitted.size).toBe(0);
    expect(result.transactionHash).toBe('');
  });
});

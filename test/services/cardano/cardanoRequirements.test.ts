import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getCardanoFeeConfig } from '../../../src/config/cardanoFeeConfig';
import { decodeCardanoAddress } from '../../../src/services/cardano/cardanoAddressService';
import {
  adaTransferRequirement,
  tokenTransferRequirement
} from '../../../src/services/cardano/cardanoRequirementsService';
import type { CardanoProtocolParameters, CardanoUtxo } from '../../../src/types/cardanoType';
import { resetCardanoEnv, setCardanoFeeEnv } from '../../support/cardanoEnv';

vi.mock('../../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

/**
 * The three fee models, exercised through what they actually change: how much a wallet has to hold
 * before it can move anything.
 *
 * The figures are the ones measured against Preprod's real parameters. They are asserted as
 * numbers rather than recomputed from the same formula the code uses, because a test that derives
 * its expectation the same way the implementation does agrees with any bug the implementation has.
 */

const PREPROD: CardanoProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155381,
  coinsPerUtxoByte: 4310n,
  maxTxSize: 16384
};

/** A base address — the shape this deployment issues. */
const ADDRESS = decodeCardanoAddress(
  'addr_test1qzasn8g8wgz5elr7a2jwcpvy9jdpzddy4vc5xtqpkrl53xwv9u9kpmjufmdhhnzxgyrc05uf2wwdmadkfuqpyvztj8dqw6fdax'
)!.payload;

/** min-ADA of an output paying a base address, measured. */
const MIN_ADA = 969_750n;

const USDCX = {
  policyId: '648823ffdad1610b4162f4dbc87bd47f6f9cf45d772ddef661eff198',
  assetName: '55534443'
};

function utxo(
  lovelace: bigint,
  assets: { policyId: string; assetName: string; quantity: bigint }[] = []
): CardanoUtxo {
  return {
    txHash: 'aa'.repeat(32),
    outputIndex: 0,
    lovelace,
    holdsOtherAssets: assets.length > 0,
    assets
  };
}

beforeEach(() => {
  resetCardanoEnv();
});

/** Option A: nobody sponsors, nothing is charged. */
function optionA(): void {
  setCardanoFeeEnv({ sponsorFees: false, transferFeeUsd: 0 });
}

/** Option B: the user pays the network, ChatterPay charges its fee. */
function optionB(): void {
  setCardanoFeeEnv({ sponsorFees: false, transferFeeUsd: 0.08 });
}

/** Option C: ChatterPay covers the network fee and charges its own. */
function optionC(): void {
  setCardanoFeeEnv({
    sponsorFees: true,
    sponsorWalletId: 'chatterpay-sponsor',
    transferFeeUsd: 0.08
  });
}

describe('getCardanoFeeConfig - the three options', () => {
  it('reads A: no sponsor, no fee', () => {
    optionA();
    const config = getCardanoFeeConfig();
    expect(config.sponsorNetworkFee).toBe(false);
    expect(config.transferFeeUsd).toBe(0);
  });

  it('reads B: no sponsor, fee charged', () => {
    optionB();
    const config = getCardanoFeeConfig();
    expect(config.sponsorNetworkFee).toBe(false);
    expect(config.transferFeeUsd).toBe(0.08);
  });

  it('reads C: sponsor on, fee charged', () => {
    optionC();
    const config = getCardanoFeeConfig();
    expect(config.transferFeeUsd).toBe(0.08);
    expect(config.sponsorNetworkFee).toBe(true);
    expect(config.disabledReason).toBe('');
  });

  it('refuses to sponsor without a wallet to sponsor from', () => {
    // Half-configured is off, the same posture the family flag takes: a transfer that gets as far
    // as building and then has no input to cover the fee has already cost the user a lock.
    setCardanoFeeEnv({ sponsorFees: true });
    const config = getCardanoFeeConfig();
    expect(config.sponsorNetworkFee).toBe(false);
    expect(config.disabledReason).toBe('sponsor_wallet_missing');
  });

  it('ignores a fee that is not a usable amount', () => {
    // Nothing usable read from the environment means the fee is not configured, and an
    // unconfigured fee is no fee.
    setCardanoFeeEnv({ transferFeeUsd: null });
    expect(getCardanoFeeConfig().transferFeeUsd).toBe(0);
  });
});

describe('adaTransferRequirement - minimum to move ADA', () => {
  it('refuses an amount below the ledger floor, in every option', () => {
    for (const option of [optionA, optionB, optionC]) {
      option();
      const result = adaTransferRequirement(500_000n, [utxo(10_000_000n)], ADDRESS, PREPROD);
      expect(result.ok).toBe(false);
      expect(result.requiredLovelace).toBe(MIN_ADA);
      // The user has to be able to tell this apart from "you are broke".
      expect(result.message).toContain('network limit');
    }
  });

  it('A and B need the amount plus the network fee', () => {
    for (const option of [optionA, optionB]) {
      option();
      // 1 ADA cannot cover the floor plus the fee.
      expect(adaTransferRequirement(MIN_ADA, [utxo(1_000_000n)], ADDRESS, PREPROD).ok).toBe(false);
      // 1.2 covers it, but sending exactly the floor would leave ~0.03 of change -- below the
      // floor, so the network would eat it. Emptying the wallet is the way out, and it works.
      expect(adaTransferRequirement(MIN_ADA, [utxo(1_200_000n)], ADDRESS, PREPROD).ok).toBe(false);
      expect(adaTransferRequirement(1_000_000n, [utxo(1_200_000n)], ADDRESS, PREPROD).ok).toBe(
        true
      );
    }
  });

  it('C needs only the amount, because ChatterPay covers the fee', () => {
    // The same wallet that cannot pay unsponsored pays fine sponsored: that difference *is* C.
    expect(adaTransferRequirement(MIN_ADA, [utxo(MIN_ADA)], ADDRESS, PREPROD, true).ok).toBe(true);
    expect(adaTransferRequirement(MIN_ADA, [utxo(MIN_ADA)], ADDRESS, PREPROD, false).ok).toBe(
      false
    );
  });

  it('rejects the dust window and says what can be sent instead', () => {
    optionA();
    // 3.49 held, sending 2.4 would leave ~0.92 of change: below the floor, so the network would
    // absorb it as fee and the user would lose it without the transfer failing.
    const result = adaTransferRequirement(2_400_000n, [utxo(3_494_785n)], ADDRESS, PREPROD);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('is lost');
    // Both escapes are offered: keep change, or empty the wallet.
    expect(result.message).toMatch(/up to 2\.3/);
    expect(result.message).toMatch(/3\.29/);
  });

  it('allows emptying the wallet, which is the edge of that window', () => {
    optionA();
    expect(adaTransferRequirement(3_294_785n, [utxo(3_494_785n)], ADDRESS, PREPROD).ok).toBe(true);
  });

  it('allows keeping change above the floor', () => {
    optionA();
    expect(adaTransferRequirement(2_000_000n, [utxo(3_494_785n)], ADDRESS, PREPROD).ok).toBe(true);
  });
});

describe('tokenTransferRequirement - a token never travels alone', () => {
  const held = [utxo(2_000_000n, [{ ...USDCX, quantity: 10_000_000n }])];

  it('A and B need ADA even though the user is sending a token', () => {
    for (const option of [optionA, optionB]) {
      option();
      const result = tokenTransferRequirement(
        { ...USDCX, quantity: 10_000_000n },
        [utxo(500_000n, [{ ...USDCX, quantity: 10_000_000n }])],
        ADDRESS,
        PREPROD
      );
      expect(result.ok, 'a wallet with tokens and no ADA cannot send').toBe(false);
      expect(result.message).toContain('also takes ADA');
    }
  });

  it('charges the floor twice when the sender keeps part of the token', () => {
    optionA();
    const whole = tokenTransferRequirement(
      { ...USDCX, quantity: 10_000_000n },
      held,
      ADDRESS,
      PREPROD
    );
    const part = tokenTransferRequirement(
      { ...USDCX, quantity: 5_000_000n },
      held,
      ADDRESS,
      PREPROD
    );
    // The change output carries the remainder, so it needs min-ADA of its own.
    expect(part.requiredLovelace).toBeGreaterThan(whole.requiredLovelace);
    expect(part.requiredLovelace - whole.requiredLovelace).toBeGreaterThan(1_000_000n);
    expect(part.message).toContain('change that keeps the rest of the token');
  });

  it('C still needs the ADA the token drags along', () => {
    // This used to report `0` on the grounds that C sponsors the fee. But the ADA attached to a
    // token output is not a fee: it leaves the sender and stays with the recipient. Reporting zero
    // told a wallet holding tokens and no ADA that it could send, and the builder then refused it
    // after the lock was taken, the notification sent and the optimistic answer returned.
    const result = tokenTransferRequirement(
      { ...USDCX, quantity: 5_000_000n },
      [utxo(0n, [{ ...USDCX, quantity: 10_000_000n }])],
      ADDRESS,
      PREPROD,
      true
    );
    expect(result.ok, 'a wallet with tokens and no ADA cannot send, sponsored or not').toBe(false);
    expect(result.requiredLovelace).toBeGreaterThan(1_000_000n);
    expect(result.message).toContain('ChatterPay covers the network cost');
  });

  it('C asks for less than A: the difference is exactly the network fee', () => {
    const utxos = [utxo(50_000_000n, [{ ...USDCX, quantity: 10_000_000n }])];
    const sponsored = tokenTransferRequirement(
      { ...USDCX, quantity: 10_000_000n },
      utxos,
      ADDRESS,
      PREPROD,
      true
    );
    const unsponsored = tokenTransferRequirement(
      { ...USDCX, quantity: 10_000_000n },
      utxos,
      ADDRESS,
      PREPROD,
      false
    );
    expect(sponsored.requiredLovelace).toBeGreaterThan(0n);
    expect(unsponsored.requiredLovelace - sponsored.requiredLovelace).toBe(200_000n);
  });
});

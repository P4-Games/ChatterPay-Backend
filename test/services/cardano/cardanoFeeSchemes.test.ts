/**
 * The two fee schemes, exercised side by side.
 *
 * Every test here runs against **both** schemes, or asserts the difference between them, and none
 * of them reads the environment of the machine running it: the scheme arrives on the plan as a
 * capability, and the config resolver is driven through the same mock the rest of the suite uses.
 * That is deliberate. Two schemes alive at once is only safe if CI exercises the one that is
 * switched off, and a suite that ran whichever scheme the deployment happens to be configured for
 * would be exercising one and rotting the other.
 *
 * The token is the real Preprod USDCx — policy and a five-character name — because its serialized
 * length is what sets min-ADA, and a four-character stand-in produces figures that look right and
 * are not the ones the chain charges.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { chargesTransferFee, getCardanoFeeConfig } from '../../../src/config/cardanoFeeConfig';
import { decodeCardanoAddress } from '../../../src/services/cardano/cardanoAddressService';
import { chatterPayFeeFor } from '../../../src/services/cardano/cardanoFeeService';
import {
  adaTransferRequirement,
  tokenTransferRequirement
} from '../../../src/services/cardano/cardanoRequirementsService';
import {
  buildCardanoTransfer,
  minimumAdaFor
} from '../../../src/services/cardano/cardanoTxService';
import type {
  CardanoProtocolParameters,
  CardanoTransferPlan,
  CardanoUtxo
} from '../../../src/types/cardanoType';
import { resetCardanoEnv, setCardanoFeeEnv } from '../../support/cardanoEnv';

vi.mock('../../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

/** Preprod protocol parameters, as `/epoch_params` reports them. */
const PREPROD: CardanoProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155381,
  coinsPerUtxoByte: 4310n,
  maxTxSize: 16384
};

const SENDER = decodeCardanoAddress(
  'addr_test1qzasn8g8wgz5elr7a2jwcpvy9jdpzddy4vc5xtqpkrl53xwv9u9kpmjufmdhhnzxgyrc05uf2wwdmadkfuqpyvztj8dqw6fdax'
)!.payload;
const RECIPIENT = decodeCardanoAddress(
  'addr_test1qrhdandhv2ngazdseql7v5fkg5utnu629anv9zt25x8vrszjyp6j235fkwlenwn0nakgta56g02ddcupr6dpc3yym4ls3tvxqu'
)!.payload;
const SPONSOR = decodeCardanoAddress(
  'addr_test1qz4fjrrr2wlhl45jvmz4wx7egvszs9wqysm02kem54aavg6dmsc3qkjtlaarm4t09033uvxx7jhlm7wkut7k22ksac5s4tdxtz'
)!.payload;

/** The USDCx minted on Preprod: 28-byte policy, five-character name. */
const USDCX = {
  policyId: '31dde3db98ad05feb688d4dbb146b3b6054e1246cbcef98c79b0bf66',
  assetName: Buffer.from('USDCx').toString('hex')
};

const TTL = 132_185_000;
const SENDER_HASH = 'aa'.repeat(32);
const SPONSOR_HASH = 'dd'.repeat(32);

/** What the ledger charges for an output carrying this much USDCx, to this recipient. */
const ATTACHED = minimumAdaFor(RECIPIENT, [{ ...USDCX, quantity: 2_000_000n }], 4310n);
/** What it charges for a plain ADA output back to the sender: the floor change has to clear. */
const ADA_FLOOR = minimumAdaFor(SENDER, [], 4310n);

function adaUtxo(lovelace: bigint, index = 0, hash = SENDER_HASH): CardanoUtxo {
  return { txHash: hash, outputIndex: index, lovelace, holdsOtherAssets: false, assets: [] };
}

function tokenUtxo(lovelace: bigint, quantity: bigint, index = 0): CardanoUtxo {
  return {
    txHash: SENDER_HASH,
    outputIndex: index,
    lovelace,
    holdsOtherAssets: true,
    assets: [{ ...USDCX, quantity }]
  };
}

function sponsoring(utxos: CardanoUtxo[] = [adaUtxo(500_000_000n, 0, SPONSOR_HASH)]) {
  return { utxos, changeAddress: SPONSOR };
}

/** ADA the sender put in minus what came back: what the transfer actually took from them. */
function costToSender(built: { inputs: readonly CardanoUtxo[]; change: bigint }): bigint {
  const contributed = built.inputs
    .filter((utxo) => utxo.txHash === SENDER_HASH)
    .reduce((sum, utxo) => sum + utxo.lovelace, 0n);
  return contributed - built.change;
}

/** ADA the sponsor put in minus what came back: what sponsoring cost it. */
function costToSponsor(built: {
  inputs: readonly CardanoUtxo[];
  fee: bigint;
  change: bigint;
  sentLovelace: bigint;
}): bigint {
  const contributed = built.inputs
    .filter((utxo) => utxo.txHash === SPONSOR_HASH)
    .reduce((sum, utxo) => sum + utxo.lovelace, 0n);
  const senderIn = built.inputs
    .filter((utxo) => utxo.txHash === SENDER_HASH)
    .reduce((sum, utxo) => sum + utxo.lovelace, 0n);
  const sponsorChange = senderIn + contributed - built.sentLovelace - built.fee - built.change;
  return contributed - sponsorChange;
}

/** A token plan, with the capabilities the given scheme turns on. */
function tokenPlan(
  utxos: CardanoUtxo[],
  scheme: 1 | 2,
  extra: Partial<CardanoTransferPlan> = {}
): CardanoTransferPlan {
  return {
    utxos,
    destinationAddress: RECIPIENT,
    changeAddress: SENDER,
    amount: 0n,
    asset: { ...USDCX, quantity: 2_000_000n },
    sponsor: sponsoring(),
    sponsorMinAda: scheme === 2,
    routeDustToSponsor: scheme === 2,
    ttlSlot: TTL,
    parameters: PREPROD,
    witnessCount: 2,
    ...extra
  };
}

/** An ADA plan, same shape. */
function adaPlan(
  utxos: CardanoUtxo[],
  scheme: 1 | 2,
  extra: Partial<CardanoTransferPlan> = {}
): CardanoTransferPlan {
  return {
    utxos,
    destinationAddress: RECIPIENT,
    changeAddress: SENDER,
    amount: 10_000_000n,
    sponsor: sponsoring(),
    sponsorMinAda: scheme === 2,
    routeDustToSponsor: scheme === 2,
    ttlSlot: TTL,
    parameters: PREPROD,
    witnessCount: 2,
    ...extra
  };
}

const SCHEMES = [1, 2] as const;

beforeEach(() => {
  resetCardanoEnv();
});

describe('getCardanoFeeConfig - which scheme a deployment resolves to', () => {
  it('defaults to scheme 2 when nothing asks for one', () => {
    setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: 'sponsor', transferFeeAda: 0.45 });
    const config = getCardanoFeeConfig();
    expect(config.scheme).toBe(2);
    expect(config.sponsorMinAda).toBe(true);
  });

  it('takes an exact 1 to go back to scheme 1', () => {
    setCardanoFeeEnv({
      sponsorFees: true,
      sponsorWalletId: 'sponsor',
      feeScheme: 1,
      transferFeeUsd: 0.08
    });
    const config = getCardanoFeeConfig();
    expect(config.scheme).toBe(1);
    expect(config.sponsorMinAda).toBe(false);
    expect(config.routeDustToSponsor).toBe(false);
  });

  it('resolves scheme 2 and has the sponsor supply the token min-ADA', () => {
    setCardanoFeeEnv({
      sponsorFees: true,
      sponsorWalletId: 'sponsor',
      feeScheme: 2,
      transferFeeAda: 0.5
    });
    const config = getCardanoFeeConfig();
    expect(config.scheme).toBe(2);
    expect(config.sponsorMinAda).toBe(true);
  });

  it("keeps routing off until it is asked for, because it moves the user's money", () => {
    setCardanoFeeEnv({
      sponsorFees: true,
      sponsorWalletId: 'sponsor',
      feeScheme: 2,
      transferFeeAda: 0.5
    });
    // The routed lovelace leaves the sender's address and sits in ChatterPay's. Until something
    // credits it back, turning this on would convert an honest refusal into a silent charge.
    expect(getCardanoFeeConfig().routeDustToSponsor).toBe(false);

    setCardanoFeeEnv({ routeDustToSponsor: true });
    expect(getCardanoFeeConfig().routeDustToSponsor).toBe(true);
  });

  it('refuses to route under scheme 1 even when asked', () => {
    setCardanoFeeEnv({
      sponsorFees: true,
      sponsorWalletId: 'sponsor',
      feeScheme: 1,
      transferFeeUsd: 0.08,
      routeDustToSponsor: true
    });
    expect(getCardanoFeeConfig().routeDustToSponsor).toBe(false);
  });

  it('reports scheme 2 capabilities off without a sponsor to exercise them', () => {
    setCardanoFeeEnv({ sponsorFees: false, feeScheme: 2, transferFeeAda: 0.5 });
    const config = getCardanoFeeConfig();
    // The scheme is still what was asked for; what it needs a sponsor for is what goes quiet.
    expect(config.scheme).toBe(2);
    expect(config.sponsorMinAda).toBe(false);
  });

  it('decides whether it charges from the figure its own scheme is denominated in', () => {
    // Both figures are always exposed, so reading them proves nothing. What the scheme decides is
    // which of them answers "is anything charged at all".
    setCardanoFeeEnv({
      sponsorFees: true,
      sponsorWalletId: 'sponsor',
      feeScheme: 1,
      transferFeeUsd: 0.08,
      transferFeeAda: 0
    });
    expect(chargesTransferFee(getCardanoFeeConfig())).toBe(true);

    setCardanoFeeEnv({ feeScheme: 2 });
    expect(chargesTransferFee(getCardanoFeeConfig())).toBe(false);

    setCardanoFeeEnv({ transferFeeAda: 0.45 });
    expect(chargesTransferFee(getCardanoFeeConfig())).toBe(true);
  });

  it('still charges when only the new-output fee is configured', () => {
    // Reading the ordinary figure alone would answer "no" here and hand out the expensive transfers
    // — the ones that cost ChatterPay a whole min-ADA — for free.
    setCardanoFeeEnv({
      sponsorFees: true,
      sponsorWalletId: 'sponsor',
      feeScheme: 2,
      transferFeeAda: 0,
      transferFeeAdaNewOutput: 1.6
    });
    expect(chargesTransferFee(getCardanoFeeConfig())).toBe(true);
  });

  it('falls back to the ordinary fee when the new-output one is not configured', () => {
    setCardanoFeeEnv({
      sponsorFees: true,
      sponsorWalletId: 'sponsor',
      feeScheme: 2,
      transferFeeAda: 0.45,
      transferFeeAdaNewOutput: null
    });
    // Not to zero: a deployment that configured one figure meant to charge something.
    expect(getCardanoFeeConfig().transferFeeAdaNewOutput).toBe(0.45);

    setCardanoFeeEnv({ transferFeeAdaNewOutput: 1.6 });
    expect(getCardanoFeeConfig().transferFeeAdaNewOutput).toBe(1.6);
  });

  it('prices an ADA transfer without needing any quote at all', async () => {
    // The one path a pricing outage cannot make free: a fee of 0.45 ADA on an ADA transfer is
    // 450000 lovelace and there is nothing to look up.
    setCardanoFeeEnv({
      sponsorFees: true,
      sponsorWalletId: 'sponsor',
      feeScheme: 2,
      transferFeeAda: 0.45,
      transferFeeAdaNewOutput: 1.6
    });
    const config = getCardanoFeeConfig();
    expect(await chatterPayFeeFor(config, 'ADA', 6)).toBe(450_000n);
    // And the dearer figure when this transfer funds a new output for the destination.
    expect(await chatterPayFeeFor(config, 'ADA', 6, true)).toBe(1_600_000n);
  });

  it('charges nothing under scheme 1 no matter what the ADA figures say', async () => {
    setCardanoFeeEnv({
      sponsorFees: true,
      sponsorWalletId: 'sponsor',
      feeScheme: 1,
      transferFeeUsd: 0,
      transferFeeAda: 0.45,
      transferFeeAdaNewOutput: 1.6
    });
    const config = getCardanoFeeConfig();
    expect(chargesTransferFee(config)).toBe(false);
    expect(await chatterPayFeeFor(config, 'ADA', 6, true)).toBe(0n);
  });

  it('keeps recycling behind its own switch, off even under scheme 2', () => {
    setCardanoFeeEnv({
      sponsorFees: true,
      sponsorWalletId: 'sponsor',
      feeScheme: 2,
      transferFeeAda: 0.5
    });
    expect(getCardanoFeeConfig().recycleDestinationUtxo).toBe(false);

    setCardanoFeeEnv({ recycleDestinationUtxo: true });
    expect(getCardanoFeeConfig().recycleDestinationUtxo).toBe(true);
  });

  it('refuses to recycle under scheme 1 even when asked', () => {
    setCardanoFeeEnv({
      sponsorFees: true,
      sponsorWalletId: 'sponsor',
      feeScheme: 1,
      transferFeeUsd: 0.08,
      recycleDestinationUtxo: true
    });
    expect(getCardanoFeeConfig().recycleDestinationUtxo).toBe(false);
  });

  it('treats an unreadable scheme as the default rather than guessing', () => {
    // The right way round now that scheme 2 is the default: a typo should not quietly restore the
    // behaviour where sending a token drains the sender's ADA. Going back is deliberate.
    setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: 'sponsor', feeScheme: null });
    expect(getCardanoFeeConfig().scheme).toBe(2);

    setCardanoFeeEnv({ feeScheme: 3 });
    expect(getCardanoFeeConfig().scheme).toBe(2);

    setCardanoFeeEnv({ feeScheme: 0 });
    expect(getCardanoFeeConfig().scheme).toBe(2);
  });
});

describe('both schemes - what every transfer still has to be true of', () => {
  for (const scheme of SCHEMES) {
    it(`scheme ${scheme}: an ADA transfer balances and pays the destination`, () => {
      const built = buildCardanoTransfer(adaPlan([adaUtxo(50_000_000n)], scheme));
      expect(built.sentLovelace).toBe(10_000_000n);
      expect(built.change).toBe(50_000_000n - 10_000_000n);
      expect(built.fee).toBeGreaterThan(0n);
    });

    it(`scheme ${scheme}: a token transfer sends the whole token quantity`, () => {
      const built = buildCardanoTransfer(tokenPlan([tokenUtxo(ATTACHED, 2_000_000n)], scheme));
      expect(built.changeAssets).toEqual([]);
      expect(built.sentLovelace).toBe(ATTACHED);
    });

    it(`scheme ${scheme}: the network fee comes from the sponsor, never the sender`, () => {
      const built = buildCardanoTransfer(adaPlan([adaUtxo(50_000_000n)], scheme));
      // The sender is out exactly the amount: the fee was somebody else's to pay.
      expect(costToSender(built)).toBe(10_000_000n);
    });
  }
});

describe('the difference between the schemes - who supplies the token min-ADA', () => {
  it('scheme 1: the sender supplies it, and their ADA balance falls by it', () => {
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(ATTACHED, 2_000_000n)], 1, { sponsor: sponsoring() })
    );
    expect(costToSender(built)).toBe(ATTACHED);
    expect(built.sponsorSuppliedLovelace).toBe(0n);
  });

  it('scheme 2: the sponsor supplies it, and the sender pays no ADA at all', () => {
    const built = buildCardanoTransfer(tokenPlan([tokenUtxo(ATTACHED, 2_000_000n)], 2));
    expect(costToSender(built)).toBe(0n);
    expect(built.sponsorSuppliedLovelace).toBe(ATTACHED);
    // The destination still receives the same output: what changed is where the ADA came from.
    expect(built.sentLovelace).toBe(ATTACHED);
  });

  it('scheme 2: the sponsor is out the min-ADA on top of the network fee', () => {
    const built = buildCardanoTransfer(tokenPlan([tokenUtxo(ATTACHED, 2_000_000n)], 2));
    expect(costToSponsor(built)).toBe(ATTACHED + built.fee);
  });

  it('scheme 2 lets a wallet with the token and zero spare ADA send part of it', () => {
    // One output holding the token and exactly its floor. Under scheme 1 this cannot send a part:
    // the destination needs a floor and so does the change that keeps the rest.
    const utxos = [tokenUtxo(ATTACHED, 10_000_000n)];
    expect(() =>
      buildCardanoTransfer(tokenPlan(utxos, 1, { asset: { ...USDCX, quantity: 2_000_000n } }))
    ).toThrow(/CARDANO_INSUFFICIENT_FUNDS/);

    const built = buildCardanoTransfer(
      tokenPlan(utxos, 2, { asset: { ...USDCX, quantity: 2_000_000n } })
    );
    expect(built.changeAssets).toEqual([{ ...USDCX, quantity: 8_000_000n }]);
    expect(costToSender(built)).toBe(0n);
  });
});

describe('the difference between the schemes - change below the ledger floor', () => {
  /** A balance that leaves change inside the dust window: below the floor, above zero. */
  const DUSTY = 10_000_000n + ADA_FLOOR - 1n;

  it('scheme 1: refuses, because the remainder cannot be an output and would burn', () => {
    expect(() => buildCardanoTransfer(adaPlan([adaUtxo(DUSTY)], 1))).toThrow(
      /CARDANO_CHANGE_WOULD_BE_BURNED/
    );
  });

  it('scheme 2: routes the remainder to the sponsor and reports what is owed back', () => {
    const built = buildCardanoTransfer(adaPlan([adaUtxo(DUSTY)], 2));
    expect(built.change).toBe(0n);
    expect(built.routedToSponsor).toBe(DUSTY - 10_000_000n);
    // The sender is out their whole balance on chain, and owed the routed part off-chain.
    expect(costToSender(built)).toBe(DUSTY);
  });

  it('scheme 2: prefers another input of the sender over routing their money away', () => {
    // Two outputs. Widening the selection keeps the remainder in the sender's own wallet, which
    // beats routing it, so nothing should be routed at all.
    const built = buildCardanoTransfer(adaPlan([adaUtxo(DUSTY), adaUtxo(20_000_000n, 1)], 2));
    expect(built.routedToSponsor).toBe(0n);
    expect(built.change).toBeGreaterThanOrEqual(ADA_FLOOR);
  });

  it('routes nothing when the remainder carries tokens, in either scheme', () => {
    // A change output holding the sender's residual token can never be routed: it would hand
    // ChatterPay the token. The transfer has to refuse instead.
    //
    // Sending the ADA floor exactly is what puts this in the window: the amount clears the
    // destination's floor, and what stays behind — ATTACHED less that — does not clear the higher
    // floor its token imposes on the change.
    const utxos = [tokenUtxo(ATTACHED, 10_000_000n)];
    expect(ATTACHED - ADA_FLOOR).toBeLessThan(ADA_FLOOR);
    for (const scheme of SCHEMES) {
      expect(() => buildCardanoTransfer(adaPlan(utxos, scheme, { amount: ADA_FLOOR }))).toThrow(
        /CARDANO_CHANGE_WOULD_BE_BURNED|CARDANO_INSUFFICIENT_FUNDS/
      );
    }
  });

  it('scheme 2: routed change never leaves through the fee', () => {
    const built = buildCardanoTransfer(adaPlan([adaUtxo(DUSTY)], 2));
    const sponsorIn = built.inputs
      .filter((utxo) => utxo.txHash === SPONSOR_HASH)
      .reduce((sum, utxo) => sum + utxo.lovelace, 0n);
    const senderIn = built.inputs
      .filter((utxo) => utxo.txHash === SENDER_HASH)
      .reduce((sum, utxo) => sum + utxo.lovelace, 0n);
    const sponsorChange = senderIn + sponsorIn - built.sentLovelace - built.fee - built.change;
    // The routed lovelace is inside the sponsor's change output, not inside the fee.
    expect(sponsorChange).toBeGreaterThanOrEqual(built.routedToSponsor);
  });
});

describe('what the wallet is told it needs, per scheme', () => {
  it('scheme 1: a token transfer needs the attached ADA, and says so', () => {
    const requirement = tokenTransferRequirement(
      { ...USDCX, quantity: 2_000_000n },
      [tokenUtxo(0n, 10_000_000n)],
      SENDER,
      PREPROD,
      true,
      false
    );
    expect(requirement.ok).toBe(false);
    expect(requirement.requiredLovelace).toBeGreaterThan(0n);
  });

  it('scheme 2: sending the whole token needs no ADA of the sender at all', () => {
    const requirement = tokenTransferRequirement(
      { ...USDCX, quantity: 10_000_000n },
      [tokenUtxo(0n, 10_000_000n)],
      SENDER,
      PREPROD,
      true,
      true
    );
    expect(requirement.ok).toBe(true);
    expect(requirement.requiredLovelace).toBe(0n);
  });

  it('scheme 2: sending part of it still needs the floor of the change that keeps the rest', () => {
    // Answering a flat zero here was wrong. The sponsor supplies the destination's floor, but the
    // sender's own change carries the residual token and is priced against *their* address, which
    // is not the address the ADA in their UTxO was priced against. Where a wallet falls between
    // the two, this said yes and the builder then refused — after the lock, after the user had
    // been told the transfer was under way.
    const requirement = tokenTransferRequirement(
      { ...USDCX, quantity: 2_000_000n },
      [tokenUtxo(0n, 10_000_000n)],
      SENDER,
      PREPROD,
      true,
      true
    );
    expect(requirement.ok).toBe(false);
    expect(requirement.requiredLovelace).toBeGreaterThan(0n);
    expect(requirement.refusal?.reason).toBe('token_change_needs_ada');
  });

  it('scheme 1: the dust window is a refusal, with the figures to act on', () => {
    const requirement = adaTransferRequirement(
      10_000_000n,
      [adaUtxo(10_000_000n + ADA_FLOOR - 1n)],
      SENDER,
      PREPROD,
      true,
      0n,
      false
    );
    expect(requirement.ok).toBe(false);
    expect(requirement.refusal?.reason).toBe('change_below_floor');
  });

  it('scheme 2: the dust window is not a refusal, because it gets routed', () => {
    const requirement = adaTransferRequirement(
      10_000_000n,
      [adaUtxo(10_000_000n + ADA_FLOOR - 1n)],
      SENDER,
      PREPROD,
      true,
      0n,
      true
    );
    expect(requirement.ok).toBe(true);
  });

  it('both schemes still refuse an amount under the ledger floor', () => {
    for (const routes of [false, true]) {
      const requirement = adaTransferRequirement(
        ADA_FLOOR - 1n,
        [adaUtxo(50_000_000n)],
        SENDER,
        PREPROD,
        true,
        0n,
        routes
      );
      expect(requirement.ok).toBe(false);
      expect(requirement.refusal?.reason).toBe('amount_below_minimum');
    }
  });
});

describe('recycling the destination output', () => {
  /** What the destination already holds: the token, and the floor that came with it. */
  const existing: CardanoUtxo = {
    txHash: 'cc'.repeat(32),
    outputIndex: 0,
    lovelace: ATTACHED,
    holdsOtherAssets: true,
    assets: [{ ...USDCX, quantity: 5_000_000n }]
  };

  it('costs the sponsor nothing, because the floor was already funded', () => {
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(ATTACHED, 2_000_000n)], 2, {
        recycleUtxos: [existing],
        witnessCount: 3
      })
    );
    // The destination's own ADA pays for the destination's new output.
    expect(built.sponsorSuppliedLovelace).toBe(0n);
    expect(costToSender(built)).toBe(0n);
  });

  it('hands the destination one output holding both quantities', () => {
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(ATTACHED, 2_000_000n)], 2, {
        recycleUtxos: [existing],
        witnessCount: 3
      })
    );
    // Their old output is spent, so it has to be among the inputs.
    expect(built.inputs.map((utxo) => utxo.txHash)).toContain(existing.txHash);
    // And what leaves for them still clears the floor of the merged output.
    expect(built.sentLovelace).toBeGreaterThanOrEqual(ATTACHED);
  });

  it('never gives the destination back less ADA than it came with', () => {
    const fat = { ...existing, lovelace: 5_000_000n };
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(ATTACHED, 2_000_000n)], 2, {
        recycleUtxos: [fat],
        witnessCount: 3
      })
    );
    expect(built.sentLovelace).toBe(5_000_000n);
    expect(built.sponsorSuppliedLovelace).toBe(0n);
  });

  it('declines outputs carrying anything beyond the token being sent', () => {
    const mixed: CardanoUtxo = {
      ...existing,
      assets: [
        { ...USDCX, quantity: 5_000_000n },
        { policyId: 'ff'.repeat(28), assetName: Buffer.from('OTRO').toString('hex'), quantity: 1n }
      ]
    };
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(ATTACHED, 2_000_000n)], 2, {
        recycleUtxos: [mixed],
        witnessCount: 3
      })
    );
    // Left alone: the sponsor funds a fresh output rather than moving somebody's other token.
    expect(built.inputs.map((utxo) => utxo.txHash)).not.toContain(mixed.txHash);
    expect(built.sponsorSuppliedLovelace).toBe(ATTACHED);
  });

  it('is what the expensive fee exists to price, and it no longer applies', () => {
    const withoutRecycling = buildCardanoTransfer(tokenPlan([tokenUtxo(ATTACHED, 2_000_000n)], 2));
    const withRecycling = buildCardanoTransfer(
      tokenPlan([tokenUtxo(ATTACHED, 2_000_000n)], 2, {
        recycleUtxos: [existing],
        witnessCount: 3
      })
    );
    expect(withoutRecycling.sponsorSuppliedLovelace).toBe(ATTACHED);
    expect(withRecycling.sponsorSuppliedLovelace).toBe(0n);
  });
});

describe('the guards that keep the sender whole', () => {
  it('routes on the token path too, not only on the ADA one', () => {
    // A token transfer whose sender keeps no residual: their leftover ADA is plain, so it can be
    // routed exactly like the ADA path's.
    const dusty = ATTACHED + ADA_FLOOR - 1n;
    expect(() => buildCardanoTransfer(tokenPlan([tokenUtxo(dusty, 2_000_000n)], 1))).toThrow(
      /CARDANO_INSUFFICIENT_FUNDS/
    );

    const built = buildCardanoTransfer(tokenPlan([tokenUtxo(dusty, 2_000_000n)], 2));
    // Scheme 2 has the sponsor fund the attached ADA, so the whole of the sender's lovelace is
    // their own change — and what cannot stand as an output rides home with the sponsor.
    expect(built.change + built.routedToSponsor).toBe(dusty);
  });

  it("refuses rather than burning the sender's routed change", () => {
    // A sponsor with barely enough for the fee cannot also hold the routed remainder as an output.
    // Dropping it into the fee would be the sender paying to be refused politely.
    const dusty = 10_000_000n + ADA_FLOOR - 1n;
    expect(() =>
      buildCardanoTransfer(
        adaPlan([adaUtxo(dusty)], 2, { sponsor: sponsoring([adaUtxo(300_000n, 0, SPONSOR_HASH)]) })
      )
    ).toThrow(/CARDANO_ROUTED_CHANGE_WOULD_BE_BURNED|CARDANO_INSUFFICIENT_FUNDS/);
  });

  it('never lets the sponsor donate tokens it is carrying home', () => {
    // Lovelace below the floor can go to the fee; tokens cannot. A body that fails to return them
    // does not conserve value and the chain rejects it, so this must refuse instead.
    expect(() =>
      buildCardanoTransfer(
        adaPlan([adaUtxo(50_000_000n)], 2, {
          sponsor: sponsoring([
            {
              txHash: SPONSOR_HASH,
              outputIndex: 0,
              lovelace: 300_000n,
              holdsOtherAssets: true,
              assets: [{ ...USDCX, quantity: 1n }]
            }
          ])
        })
      )
    ).toThrow(/CARDANO_SPONSOR_CHANGE_WOULD_BE_BURNED|CARDANO_INSUFFICIENT_FUNDS/);
  });

  it("reports the sponsor's change assets as one entry per asset", () => {
    // The sponsor's own residual and the fee are the same token here. Two entries would serialize
    // correctly and still be wrong: this list is what the caller records as pending change.
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(ATTACHED, 2_000_000n)], 2, {
        chatterPayFee: 100_000n,
        sponsor: sponsoring([
          adaUtxo(500_000_000n, 0, SPONSOR_HASH),
          {
            txHash: SPONSOR_HASH,
            outputIndex: 1,
            lovelace: 2_000_000n,
            holdsOtherAssets: true,
            assets: [{ ...USDCX, quantity: 500_000n }]
          }
        ])
      })
    );
    const usdcxEntries = built.sponsorChangeAssets.filter(
      (asset) => asset.policyId === USDCX.policyId
    );
    expect(usdcxEntries).toHaveLength(1);
  });
});

describe("ChatterPay's fee, in both schemes", () => {
  const FEE_UNITS = 100_000n;

  for (const scheme of SCHEMES) {
    it(`scheme ${scheme}: comes out of the amount, not out of the sender's ADA`, () => {
      const built = buildCardanoTransfer(
        tokenPlan([tokenUtxo(ATTACHED, 2_000_000n)], scheme, { chatterPayFee: FEE_UNITS })
      );
      expect(built.chatterPayFee).toBe(FEE_UNITS);
      // Reported so the caller can record the sponsor's change as carrying it, which is what keeps
      // the next transfer from spending that output as if it were pure ADA.
      expect(built.sponsorChangeAssets).toEqual([{ ...USDCX, quantity: FEE_UNITS }]);
    });
  }

  it('is refused when it would leave the destination with nothing', () => {
    for (const scheme of SCHEMES) {
      expect(() =>
        buildCardanoTransfer(
          tokenPlan([tokenUtxo(ATTACHED, 2_000_000n)], scheme, { chatterPayFee: 2_000_000n })
        )
      ).toThrow(/CARDANO_INVALID_FEE/);
    }
  });
});

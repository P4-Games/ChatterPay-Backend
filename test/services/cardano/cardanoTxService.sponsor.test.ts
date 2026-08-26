import { describe, expect, it } from 'vitest';

import { decodeCardanoAddress } from '../../../src/services/cardano/cardanoAddressService';
import {
  buildCardanoTransfer,
  minimumAdaFor
} from '../../../src/services/cardano/cardanoTxService';
import type {
  CardanoAssetAmount,
  CardanoProtocolParameters,
  CardanoTransferPlan,
  CardanoUtxo
} from '../../../src/types/cardanoType';

/** Preprod protocol parameters as the chain reports them (epoch 307). */
const PREPROD: CardanoProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155381,
  coinsPerUtxoByte: 4310n,
  maxTxSize: 16384
};

const SENDER = decodeCardanoAddress(
  'addr_test1vrhdandhv2ngazdseql7v5fkg5utnu629anv9zt25x8vrsqn2mhal'
)!.payload;
const RECIPIENT = decodeCardanoAddress(
  'addr_test1vz74kulhkqmrdrrg6u57we4pzckf07wj5e906zdpeddpz2ct8f930'
)!.payload;
/** The sponsor: the wallet that pays the network fee and receives the ChatterPay fee. */
const SPONSOR = decodeCardanoAddress(
  'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae'
)!.payload;

const TTL = 131_235_000;

const USDM = { policyId: 'a1'.repeat(28), assetName: Buffer.from('USDM').toString('hex') };
const USDA = { policyId: 'b2'.repeat(28), assetName: Buffer.from('USDA').toString('hex') };

const SENDER_HASH = 'aa'.repeat(32);
const SPONSOR_HASH = 'dd'.repeat(32);

function tokenUtxo(
  lovelace: bigint,
  assets: CardanoAssetAmount[],
  index = 0,
  hash = SENDER_HASH
): CardanoUtxo {
  return { txHash: hash, outputIndex: index, lovelace, holdsOtherAssets: true, assets };
}

function adaUtxo(lovelace: bigint, index = 0, hash = SENDER_HASH): CardanoUtxo {
  return { txHash: hash, outputIndex: index, lovelace, holdsOtherAssets: false, assets: [] };
}

/** The sponsor's contribution, as `cardanoTransferService` assembles it. */
function sponsoring(utxos: CardanoUtxo[] = [adaUtxo(10_000_000n, 0, SPONSOR_HASH)]) {
  return { utxos, changeAddress: SPONSOR };
}

/** Whether the body pays this address: its bytes appear verbatim in the output it pays. */
function paysTo(bodyBytes: Uint8Array, address: Uint8Array): boolean {
  return Buffer.from(bodyBytes).includes(Buffer.from(address));
}

/** ADA the sender put in minus what came back: what the transfer actually cost it. */
function costToSender(built: { inputs: readonly CardanoUtxo[]; change: bigint }): bigint {
  const contributed = built.inputs
    .filter((utxo) => utxo.txHash === SENDER_HASH)
    .reduce((sum, utxo) => sum + utxo.lovelace, 0n);
  return contributed - built.change;
}

/** The min-ADA the token output carries, computed rather than hardcoded. */
const ATTACHED = minimumAdaFor(RECIPIENT, [{ ...USDM, quantity: 30_000_000n }], 4310n);

function tokenPlan(
  utxos: CardanoUtxo[],
  extra: Partial<CardanoTransferPlan> = {}
): CardanoTransferPlan {
  return {
    utxos,
    destinationAddress: RECIPIENT,
    changeAddress: SENDER,
    amount: 0n,
    asset: { ...USDM, quantity: 30_000_000n },
    ttlSlot: TTL,
    parameters: PREPROD,
    witnessCount: extra.sponsor ? 2 : 1,
    ...extra
  };
}

function adaPlan(
  utxos: CardanoUtxo[],
  extra: Partial<CardanoTransferPlan> = {}
): CardanoTransferPlan {
  return {
    utxos,
    destinationAddress: RECIPIENT,
    changeAddress: SENDER,
    amount: 5_000_000n,
    ttlSlot: TTL,
    parameters: PREPROD,
    witnessCount: extra.sponsor ? 2 : 1,
    ...extra
  };
}

describe('sponsoring a native-asset transfer', () => {
  it('takes the network fee from the sponsor and not from the sender', () => {
    // The regression this file exists for: `buildAssetTransfer` ignored `plan.sponsor` entirely, so
    // a token transfer charged the fee to the sender while the deployment was configured to cover
    // it. What leaves the sender must be exactly the ADA the token drags along, and nothing else.
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(3_000_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        sponsor: sponsoring()
      })
    );

    expect(built.sentLovelace).toBe(ATTACHED);
    expect(costToSender(built)).toBe(ATTACHED);
    expect(built.change).toBe(3_000_000n - ATTACHED);
    expect(built.fee).toBeGreaterThan(0n);
  });

  it('spends the sponsor and returns its leftover to the sponsor', () => {
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(3_000_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        sponsor: sponsoring()
      })
    );

    expect(built.inputs.some((utxo) => utxo.txHash === SPONSOR_HASH)).toBe(true);
    expect(paysTo(built.bodyBytes, SPONSOR)).toBe(true);
  });

  it('lets a wallet holding tokens and no spare ADA transfer at all', () => {
    // The case sponsoring exists for. Unsponsored the wallet is permanently stuck: it holds the
    // token and just enough ADA to carry it, and not one lovelace for the fee.
    const barely = ATTACHED + minimumAdaFor(SENDER, [{ ...USDM, quantity: 70_000_000n }], 4310n);
    const utxos = [tokenUtxo(barely, [{ ...USDM, quantity: 100_000_000n }])];

    const sponsored = buildCardanoTransfer(tokenPlan(utxos, { sponsor: sponsoring() }));
    expect(sponsored.sentLovelace).toBe(ATTACHED);

    expect(() => buildCardanoTransfer(tokenPlan(utxos))).toThrow(/CARDANO_INSUFFICIENT_FUNDS/);
  });

  it('still charges the sender when nobody sponsors', () => {
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(3_000_000n, [{ ...USDM, quantity: 100_000_000n }])])
    );

    expect(costToSender(built)).toBe(ATTACHED + built.fee);
    expect(built.change).toBe(3_000_000n - ATTACHED - built.fee);
  });

  it('ignores sponsor outputs that carry tokens of their own', () => {
    // Spending one would drag the sponsor's assets into the *sender's* change output: a sponsor
    // handing its tokens over to cover a fee.
    expect(() =>
      buildCardanoTransfer(
        tokenPlan([tokenUtxo(3_000_000n, [{ ...USDM, quantity: 100_000_000n }])], {
          sponsor: sponsoring([
            tokenUtxo(10_000_000n, [{ ...USDA, quantity: 5n }], 0, SPONSOR_HASH)
          ])
        })
      )
    ).toThrow(/CARDANO_INSUFFICIENT_FUNDS/);
  });
});

/** What came back to the sponsor: whatever the other outputs and the network fee did not claim. */
function sponsorChangeOf(built: {
  inputs: readonly CardanoUtxo[];
  sentLovelace: bigint;
  fee: bigint;
  change: bigint;
}): bigint {
  const consumed = built.inputs.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
  return consumed - built.sentLovelace - built.fee - built.change;
}

/** Net ADA the sponsor is up on this transfer: what came back less what it put in. */
function gainToSponsor(built: {
  inputs: readonly CardanoUtxo[];
  sentLovelace: bigint;
  fee: bigint;
  change: bigint;
}): bigint {
  const contributed = built.inputs
    .filter((utxo) => utxo.txHash === SPONSOR_HASH)
    .reduce((sum, utxo) => sum + utxo.lovelace, 0n);
  return sponsorChangeOf(built) - contributed;
}

/** How many times a byte string appears in the body — one per output that carries it. */
function occurrences(bodyBytes: Uint8Array, needle: Uint8Array): number {
  const hay = Buffer.from(bodyBytes).toString('hex');
  const pin = Buffer.from(needle).toString('hex');
  return hay.split(pin).length - 1;
}

describe("charging ChatterPay's fee on an ADA transfer", () => {
  /** Roughly USD 0.08 of ADA — and, deliberately, well under the ~0.97 min-ADA of an output. */
  const FEE = 400_000n;

  it('takes the fee out of the amount, so the sender is charged exactly what they asked to send', () => {
    // The EVM contract does `transferAmount = amount - fee`. Matching it is what makes
    // `amount - fee` mean the same thing on both chains — and what stops the sender's balance from
    // dropping by more than the figure they typed.
    const built = buildCardanoTransfer(
      adaPlan([adaUtxo(8_000_000n)], { sponsor: sponsoring(), chatterPayFee: FEE })
    );

    expect(built.chatterPayFee).toBe(FEE);
    expect(built.sentLovelace).toBe(5_000_000n - FEE);
    expect(costToSender(built)).toBe(5_000_000n);
  });

  it('hands the fee to the sponsor inside the change output it already had', () => {
    // The whole trick. A fee of 0.4 ADA cannot be an output of its own — it is under the floor —
    // which is why this used to accrue until it had tripled. Folded into an output that already
    // exists and already clears the floor, it can be charged in full every time.
    const built = buildCardanoTransfer(
      adaPlan([adaUtxo(8_000_000n)], { sponsor: sponsoring(), chatterPayFee: FEE })
    );

    expect(gainToSponsor(built)).toBe(FEE - built.fee);
    // Payment, sender's change, sponsor's change. A fourth output would be the old fee output back.
    expect(built.changeIndex).toBe(1);
    expect(built.sponsorChangeIndex).toBe(2);
  });

  it('charges the same fee every time, with nothing carried between transfers', () => {
    const built = [1, 2, 3].map(() =>
      buildCardanoTransfer(
        adaPlan([adaUtxo(8_000_000n)], { sponsor: sponsoring(), chatterPayFee: FEE })
      )
    );

    expect(built.map((b) => b.chatterPayFee)).toEqual([FEE, FEE, FEE]);
    expect(built.map((b) => b.sentLovelace)).toEqual(Array(3).fill(5_000_000n - FEE));
  });

  it('charges nothing when nobody sponsors, because there is no change to fold it into', () => {
    const built = buildCardanoTransfer(adaPlan([adaUtxo(8_000_000n)], { chatterPayFee: FEE }));

    expect(built.chatterPayFee).toBe(0n);
    expect(built.sentLovelace).toBe(5_000_000n);
  });

  it('refuses when the fee would push what arrives under the floor, naming what to send instead', () => {
    // The floor applies to what *arrives*, so charging a fee raises the smallest transfer that can
    // work. The figure in the message has to be the amount to type, not the floor.
    const floor = minimumAdaFor(RECIPIENT, [], 4310n);
    const plan = adaPlan([adaUtxo(8_000_000n)], {
      amount: floor + FEE - 1n,
      sponsor: sponsoring(),
      chatterPayFee: FEE
    });

    expect(() => buildCardanoTransfer(plan)).toThrow(
      new RegExp(`CARDANO_AMOUNT_BELOW_MINIMUM_UTXO: ${floor + FEE} lovelace minimum`)
    );
  });

  it('refuses a fee that would swallow the whole amount rather than building nonsense', () => {
    expect(() =>
      buildCardanoTransfer(
        adaPlan([adaUtxo(8_000_000n)], { sponsor: sponsoring(), chatterPayFee: 5_000_000n })
      )
    ).toThrow(/CARDANO_INVALID_FEE/);
  });
});

describe("charging ChatterPay's fee on a native-asset transfer", () => {
  /** The fee in the token's own base units — USDCx, not ADA, exactly as EVM charges it. */
  const FEE = 80_000n;

  it("takes the fee out of the token, leaving the sender's ADA cost untouched", () => {
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(4_500_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        sponsor: sponsoring(),
        chatterPayFee: FEE
      })
    );

    expect(built.chatterPayFee).toBe(FEE);
    // The only ADA the sender parts with is the min-ADA the token drags along, as before: charging
    // in the token is what keeps a stablecoin transfer from also costing ADA.
    expect(costToSender(built)).toBe(ATTACHED);
    expect(built.change).toBe(4_500_000n - ATTACHED);
  });

  it('sends the fee home in the sponsor change, which now carries the token too', () => {
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(4_500_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        sponsor: sponsoring(),
        chatterPayFee: FEE
      })
    );

    // The policy appears in the destination's output, in the sender's change, and now in the
    // sponsor's change — three outputs carrying USDM, and still no output created for the fee.
    expect(occurrences(built.bodyBytes, Buffer.from(USDM.policyId, 'hex'))).toBe(3);
    expect(paysTo(built.bodyBytes, SPONSOR)).toBe(true);
    expect(built.sponsorChangeIndex).toBe(2);
  });

  it('costs the sponsor no extra ADA beyond the network fee', () => {
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(4_500_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        sponsor: sponsoring(),
        chatterPayFee: FEE
      })
    );

    expect(gainToSponsor(built)).toBe(-built.fee);
  });

  it('charges nothing when nobody sponsors', () => {
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(4_500_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        chatterPayFee: FEE
      })
    );

    expect(built.chatterPayFee).toBe(0n);
  });
});

describe('sponsoring an ADA transfer', () => {
  it('takes the network fee from the sponsor and not from the sender', () => {
    const built = buildCardanoTransfer(adaPlan([adaUtxo(8_000_000n)], { sponsor: sponsoring() }));

    expect(built.sentLovelace).toBe(5_000_000n);
    expect(costToSender(built)).toBe(5_000_000n);
    expect(built.inputs.some((utxo) => utxo.txHash === SPONSOR_HASH)).toBe(true);
    expect(built.fee).toBeGreaterThan(0n);
  });

  it('pays the sponsor back through its own change output', () => {
    const built = buildCardanoTransfer(
      adaPlan([adaUtxo(8_000_000n)], { sponsor: sponsoring(), chatterPayFee: 400_000n })
    );

    expect(costToSender(built)).toBe(5_000_000n);
    expect(paysTo(built.bodyBytes, SPONSOR)).toBe(true);
  });

  it('still charges the sender when nobody sponsors', () => {
    const built = buildCardanoTransfer(adaPlan([adaUtxo(8_000_000n)]));

    expect(costToSender(built)).toBe(5_000_000n + built.fee);
  });
});

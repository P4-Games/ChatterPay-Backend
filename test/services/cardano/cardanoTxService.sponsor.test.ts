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

describe('collecting the accumulated ChatterPay fee on a native-asset transfer', () => {
  const DEBT = 1_200_000n;

  it('pays the debt to the sponsor, on top of the ADA the token drags along', () => {
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(4_500_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        sponsor: sponsoring(),
        feeCollectionLovelace: DEBT
      })
    );

    expect(built.feeCollected).toBe(DEBT);
    // The sender pays the attached ADA and the debt. The network fee is still the sponsor's.
    expect(costToSender(built)).toBe(ATTACHED + DEBT);
    expect(built.change).toBe(4_500_000n - ATTACHED - DEBT);
  });

  it('leaves the debt owed when it is below the min-ADA of its own output', () => {
    // An output cannot hold less than min-ADA, so a small debt has nowhere to go yet. It stays owed
    // rather than being written off, and is collected once it has grown enough.
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(4_500_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        sponsor: sponsoring(),
        feeCollectionLovelace: 100_000n
      })
    );

    expect(built.feeCollected).toBe(0n);
    expect(costToSender(built)).toBe(ATTACHED);
  });

  it('collects nothing when there is no sponsor to collect into', () => {
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(4_500_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        feeCollectionLovelace: DEBT
      })
    );

    expect(built.feeCollected).toBe(0n);
  });
});

describe('deferring the accumulated fee rather than failing the transfer', () => {
  // The debt has no deadline — that is the entire reason it accrues instead of being charged per
  // transfer. So collecting it is opportunistic: it happens when it is free, and waits when it is
  // not. These are the two ways it is not free.

  /** min-ADA of the sender's change output when it carries the residual token. */
  const CHANGE_FLOOR = minimumAdaFor(SENDER, [{ ...USDM, quantity: 70_000_000n }], 4310n);
  /** min-ADA of a plain ADA-only change output back to the sender. */
  const PLAIN_FLOOR = minimumAdaFor(SENDER, [], 4310n);

  it('sends anyway when collecting the debt would leave the sender short', () => {
    // The reported case: a wallet holding just enough ADA to carry the token and its residual, and
    // a debt larger than what is left over. Collecting it made the whole transfer fail — the user
    // was told they had no balance for a transfer they could plainly afford.
    const barely = ATTACHED + CHANGE_FLOOR;
    const plan = tokenPlan([tokenUtxo(barely, [{ ...USDM, quantity: 100_000_000n }])], {
      sponsor: sponsoring(),
      feeCollectionLovelace: 1_400_000n
    });

    const built = buildCardanoTransfer(plan);

    expect(built.feeCollected).toBe(0n);
    expect(built.sentLovelace).toBe(ATTACHED);
    expect(costToSender(built)).toBe(ATTACHED);
    expect(built.change).toBe(CHANGE_FLOOR);
  });

  it('waits rather than burning the change it would have to destroy to collect', () => {
    // Change under min-ADA cannot be an output, so the ledger absorbs it into the fee. Collecting
    // a 1.2 ADA debt by silently destroying 0.85 ADA of the sender's own money is a worse outcome
    // than collecting nothing, and the sender would only find out by reading the transaction.
    const leftover = PLAIN_FLOOR - 1n;
    const held = ATTACHED + 1_200_000n + leftover;
    const plan = tokenPlan([tokenUtxo(held, [{ ...USDM, quantity: 30_000_000n }])], {
      sponsor: sponsoring(),
      feeCollectionLovelace: 1_200_000n
    });

    const built = buildCardanoTransfer(plan);

    expect(built.feeCollected).toBe(0n);
    expect(built.change).toBe(held - ATTACHED);
    expect(costToSender(built)).toBe(ATTACHED);
  });

  it('collects when the sender can afford it, which is the point', () => {
    // The guard must not have turned collection off in general.
    const held = ATTACHED + CHANGE_FLOOR + 1_200_000n;
    const built = buildCardanoTransfer(
      tokenPlan([tokenUtxo(held, [{ ...USDM, quantity: 100_000_000n }])], {
        sponsor: sponsoring(),
        feeCollectionLovelace: 1_200_000n
      })
    );

    expect(built.feeCollected).toBe(1_200_000n);
    expect(paysTo(built.bodyBytes, SPONSOR)).toBe(true);
    expect(costToSender(built)).toBe(ATTACHED + 1_200_000n);
  });

  it('names what the transfer needs, not what the debt needs, when truly short', () => {
    // A wallet that cannot carry the token at all is refused — but the figure in the message has to
    // be the one the user can act on, and the debt is not part of it.
    const plan = tokenPlan([tokenUtxo(ATTACHED - 1n, [{ ...USDM, quantity: 30_000_000n }])], {
      sponsor: sponsoring(),
      feeCollectionLovelace: 1_400_000n
    });

    expect(() => buildCardanoTransfer(plan)).toThrow(
      new RegExp(`CARDANO_INSUFFICIENT_FUNDS.*need at least ${ATTACHED}`)
    );
  });

  it('defers on the ADA path too', () => {
    const built = buildCardanoTransfer(
      adaPlan([adaUtxo(6_000_000n)], {
        sponsor: sponsoring(),
        feeCollectionLovelace: 4_000_000n
      })
    );

    expect(built.feeCollected).toBe(0n);
    expect(built.sentLovelace).toBe(5_000_000n);
    expect(costToSender(built)).toBe(5_000_000n);
  });

  it('propagates a failure that is not about money', () => {
    // A debt must not turn a defect into a silent retry: only a shortfall is worth deferring for.
    const plan = adaPlan([adaUtxo(6_000_000n)], {
      amount: 1n,
      sponsor: sponsoring(),
      feeCollectionLovelace: 1_200_000n
    });

    expect(() => buildCardanoTransfer(plan)).toThrow(/CARDANO_AMOUNT_BELOW_MINIMUM_UTXO/);
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

  it('collects the accumulated fee into the sponsor', () => {
    const built = buildCardanoTransfer(
      adaPlan([adaUtxo(8_000_000n)], {
        sponsor: sponsoring(),
        feeCollectionLovelace: 1_200_000n
      })
    );

    expect(built.feeCollected).toBe(1_200_000n);
    expect(costToSender(built)).toBe(5_000_000n + 1_200_000n);
    expect(paysTo(built.bodyBytes, SPONSOR)).toBe(true);
  });

  it('still charges the sender when nobody sponsors', () => {
    const built = buildCardanoTransfer(adaPlan([adaUtxo(8_000_000n)]));

    expect(costToSender(built)).toBe(5_000_000n + built.fee);
  });
});

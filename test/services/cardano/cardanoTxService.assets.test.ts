import { describe, expect, it } from 'vitest';

import { decodeCardanoAddress } from '../../../src/services/cardano/cardanoAddressService';
import {
  assetBalance,
  buildCardanoTransfer,
  encodeValue,
  minimumAdaFor,
  selectableBalance,
  selectableUtxos,
  spendableBalance,
  totalAssets,
  utxosHolding
} from '../../../src/services/cardano/cardanoTxService';
import type {
  CardanoAssetAmount,
  CardanoProtocolParameters,
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

const TTL = 131_235_000;

/** A plausible 28-byte policy hash and a hex asset name, shaped like the real thing. */
const USDM = { policyId: 'a1'.repeat(28), assetName: Buffer.from('USDM').toString('hex') };
const USDA = { policyId: 'b2'.repeat(28), assetName: Buffer.from('USDA').toString('hex') };

function tokenUtxo(
  lovelace: bigint,
  assets: CardanoAssetAmount[],
  index = 0,
  hash = 'aa'.repeat(32)
): CardanoUtxo {
  return { txHash: hash, outputIndex: index, lovelace, holdsOtherAssets: true, assets };
}

function adaUtxo(lovelace: bigint, index = 0, hash = 'cc'.repeat(32)): CardanoUtxo {
  return { txHash: hash, outputIndex: index, lovelace, holdsOtherAssets: false, assets: [] };
}

function plan(utxos: CardanoUtxo[], asset: CardanoAssetAmount, amount = 0n) {
  return {
    utxos,
    destinationAddress: RECIPIENT,
    changeAddress: SENDER,
    amount,
    asset,
    ttlSlot: TTL,
    parameters: PREPROD,
    witnessCount: 1
  };
}

describe('native assets - the token cannot travel alone', () => {
  it('attaches the protocol minimum ADA to the token output', () => {
    // A Cardano output carries a value, not a token. The ADA that goes with it is not a fee and not
    // optional: it leaves the sender and arrives at the recipient.
    const built = buildCardanoTransfer(
      plan([tokenUtxo(10_000_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        ...USDM,
        quantity: 30_000_000n
      })
    );

    // Measured against real Preprod parameters, not guessed: an output to an enterprise address
    // carrying 30.000000 of one asset costs 1.034400 ADA of min-ADA.
    expect(built.sentLovelace).toBe(1_034_400n);
  });

  it('prices the min-ADA by how many distinct assets the output carries', () => {
    const forAssets = (count: number) =>
      minimumAdaFor(
        RECIPIENT,
        [
          { ...USDM, quantity: 30_000_000n },
          { ...USDA, quantity: 30_000_000n },
          { policyId: 'c3'.repeat(28), assetName: '55534443', quantity: 30_000_000n }
        ].slice(0, count),
        PREPROD.coinsPerUtxoByte
      );

    expect(minimumAdaFor(RECIPIENT, [], PREPROD.coinsPerUtxoByte)).toBe(849_070n);
    expect(forAssets(1)).toBe(1_034_400n);
    expect(forAssets(2)).toBe(1_211_110n);
    expect(forAssets(3)).toBe(1_387_820n);
  });

  it('also grows a little with the magnitude of the quantity, which is serialized in the output', () => {
    // Worth pinning: it is the reason a min-ADA measured with a quantity of 1 understates what a
    // real transfer costs, which is a mistake easy to make and hard to notice.
    const forQuantity = (quantity: bigint) =>
      minimumAdaFor(RECIPIENT, [{ ...USDM, quantity }], PREPROD.coinsPerUtxoByte);

    expect(forQuantity(1n)).toBe(1_017_160n);
    expect(forQuantity(1_000_000n)).toBe(1_034_400n);
    expect(forQuantity(10_000_000_000_000n)).toBe(1_051_640n);
  });

  it('balances: inputs = sent + fee + change', () => {
    const built = buildCardanoTransfer(
      plan([tokenUtxo(10_000_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        ...USDM,
        quantity: 30_000_000n
      })
    );
    const consumed = built.inputs.reduce((sum, input) => sum + input.lovelace, 0n);
    expect(consumed).toBe(built.sentLovelace + built.fee + built.change);
  });
});

describe('native assets - residual tokens always come back', () => {
  it('returns the unsent remainder in the change output', () => {
    // Spending an output holding 100 to send 30 requires a change output carrying 70. A transaction
    // that does not return them does not balance, and the ledger rejects it.
    const built = buildCardanoTransfer(
      plan([tokenUtxo(10_000_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        ...USDM,
        quantity: 30_000_000n
      })
    );

    expect(built.changeAssets).toHaveLength(1);
    expect(built.changeAssets[0].quantity).toBe(70_000_000n);
    expect(built.changeAssets[0].policyId).toBe(USDM.policyId);
  });

  it('carries back other assets that rode along in the selected inputs', () => {
    // The input chosen to cover USDM also holds USDA. Both remainders have to return.
    const built = buildCardanoTransfer(
      plan(
        [
          tokenUtxo(10_000_000n, [
            { ...USDM, quantity: 100_000_000n },
            { ...USDA, quantity: 5_000_000n }
          ])
        ],
        { ...USDM, quantity: 30_000_000n }
      )
    );

    expect(built.changeAssets).toHaveLength(2);
    const usda = built.changeAssets.find((asset) => asset.policyId === USDA.policyId);
    expect(usda?.quantity).toBe(5_000_000n);
  });

  it('emits no change asset when the whole balance is sent', () => {
    const built = buildCardanoTransfer(
      plan([tokenUtxo(10_000_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        ...USDM,
        quantity: 100_000_000n
      })
    );
    expect(built.changeAssets).toHaveLength(0);
  });

  it('refuses rather than dropping residual tokens when ADA cannot fund the change output', () => {
    // Dust ADA can go to the fee. Residual tokens cannot: dropping them is not a rounding loss, it
    // is a transaction the chain refuses. So the builder asks for more ADA and, finding none,
    // refuses before signing.
    expect(() =>
      buildCardanoTransfer(
        plan([tokenUtxo(1_500_000n, [{ ...USDM, quantity: 100_000_000n }])], {
          ...USDM,
          quantity: 30_000_000n
        })
      )
    ).toThrow(/CARDANO_INSUFFICIENT_FUNDS/);
  });
});

describe('native assets - two-dimensional selection', () => {
  it('pulls in a plain ADA output when the token input cannot cover the ADA needs', () => {
    // Covering the token says nothing about covering the ADA. Here the token sits in an output with
    // barely any ADA, so a separate ADA-only input has to join.
    const built = buildCardanoTransfer(
      plan(
        [tokenUtxo(2_000_000n, [{ ...USDM, quantity: 100_000_000n }]), adaUtxo(10_000_000n, 0)],
        { ...USDM, quantity: 30_000_000n }
      )
    );

    expect(built.inputs).toHaveLength(2);
    expect(built.changeAssets[0].quantity).toBe(70_000_000n);
  });

  it('combines several token outputs when one does not hold enough', () => {
    const built = buildCardanoTransfer(
      plan(
        [
          tokenUtxo(3_000_000n, [{ ...USDM, quantity: 20_000_000n }], 0, 'aa'.repeat(32)),
          tokenUtxo(3_000_000n, [{ ...USDM, quantity: 20_000_000n }], 0, 'bb'.repeat(32))
        ],
        { ...USDM, quantity: 35_000_000n }
      )
    );

    expect(built.inputs).toHaveLength(2);
    expect(built.changeAssets[0].quantity).toBe(5_000_000n);
  });

  it('refuses when the wallet does not hold enough of the token', () => {
    expect(() =>
      buildCardanoTransfer(
        plan([tokenUtxo(10_000_000n, [{ ...USDM, quantity: 10_000_000n }])], {
          ...USDM,
          quantity: 30_000_000n
        })
      )
    ).toThrow(/CARDANO_INSUFFICIENT_TOKEN_BALANCE/);
  });

  it('uses a UTxO holding a different token as an ADA source when there is no loose ADA', () => {
    // The natural state of a wallet holding several stablecoins: every output carries a token, so
    // there is no "plain ADA" input to reach for. Refusing here would refuse a transfer the wallet
    // can plainly afford. The other token rides along into the change output.
    const built = buildCardanoTransfer(
      plan(
        [
          tokenUtxo(1_500_000n, [{ ...USDM, quantity: 100_000_000n }], 0, 'aa'.repeat(32)),
          tokenUtxo(8_000_000n, [{ ...USDA, quantity: 50_000_000n }], 0, 'bb'.repeat(32))
        ],
        { ...USDM, quantity: 30_000_000n }
      )
    );

    expect(built.inputs).toHaveLength(2);
    // Both remainders come back: 70 USDM unsent, and all 50 USDA that only came along for its ADA.
    const usdm = built.changeAssets.find((a) => a.policyId === USDM.policyId);
    const usda = built.changeAssets.find((a) => a.policyId === USDA.policyId);
    expect(usdm?.quantity).toBe(70_000_000n);
    expect(usda?.quantity).toBe(50_000_000n);
  });

  it('prefers a plain ADA input over one carrying another token', () => {
    // Reaching for the token-bearing one first would grow the change output for no reason.
    const built = buildCardanoTransfer(
      plan(
        [
          tokenUtxo(1_500_000n, [{ ...USDM, quantity: 100_000_000n }], 0, 'aa'.repeat(32)),
          tokenUtxo(8_000_000n, [{ ...USDA, quantity: 50_000_000n }], 0, 'bb'.repeat(32)),
          adaUtxo(8_000_000n, 0, 'cc'.repeat(32))
        ],
        { ...USDM, quantity: 30_000_000n }
      )
    );

    expect(built.inputs).toHaveLength(2);
    expect(built.changeAssets.some((a) => a.policyId === USDA.policyId)).toBe(false);
  });

  it('refuses a wallet holding the token and no ADA at all', () => {
    // The state a stablecoin-only user is permanently in, and the strongest argument for a
    // platform subsidy: there is no amount of USDM that buys the ADA to move it.
    expect(() =>
      buildCardanoTransfer(
        plan([tokenUtxo(1_000_000n, [{ ...USDM, quantity: 100_000_000n }])], {
          ...USDM,
          quantity: 100_000_000n
        })
      )
    ).toThrow(/CARDANO_INSUFFICIENT_FUNDS/);
  });

  it('refuses a non-positive quantity', () => {
    expect(() =>
      buildCardanoTransfer(
        plan([tokenUtxo(10_000_000n, [{ ...USDM, quantity: 100n }])], { ...USDM, quantity: 0n })
      )
    ).toThrow('CARDANO_INVALID_ASSET_QUANTITY');
  });
});

describe('native assets - determinism and encoding', () => {
  it('produces the same transaction id for the same inputs regardless of asset order', () => {
    // The transaction id is the hash of the encoded bytes, so the multiasset map has to be written
    // in canonical order or the same transfer hashes two ways.
    const utxos = (assets: CardanoAssetAmount[]) => [tokenUtxo(10_000_000n, assets)];
    const first = buildCardanoTransfer(
      plan(
        utxos([
          { ...USDM, quantity: 100_000_000n },
          { ...USDA, quantity: 5_000_000n }
        ]),
        { ...USDM, quantity: 30_000_000n }
      )
    );
    const second = buildCardanoTransfer(
      plan(
        utxos([
          { ...USDA, quantity: 5_000_000n },
          { ...USDM, quantity: 100_000_000n }
        ]),
        { ...USDM, quantity: 30_000_000n }
      )
    );
    expect(first.transactionId).toBe(second.transactionId);
  });

  it('is case-insensitive about policy and asset name hex', () => {
    const built = buildCardanoTransfer(
      plan([tokenUtxo(10_000_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        policyId: USDM.policyId.toUpperCase(),
        assetName: USDM.assetName.toUpperCase(),
        quantity: 30_000_000n
      })
    );
    expect(built.changeAssets[0].quantity).toBe(70_000_000n);
  });

  it('costs more than an ADA transfer, because the outputs are bigger', () => {
    const token = buildCardanoTransfer(
      plan([tokenUtxo(10_000_000n, [{ ...USDM, quantity: 100_000_000n }])], {
        ...USDM,
        quantity: 30_000_000n
      })
    );
    const ada = buildCardanoTransfer({
      utxos: [adaUtxo(15_000_000n)],
      destinationAddress: RECIPIENT,
      changeAddress: SENDER,
      amount: 2_000_000n,
      ttlSlot: TTL,
      parameters: PREPROD,
      witnessCount: 1
    });
    expect(token.fee).toBeGreaterThan(ada.fee);
  });
});

describe('native assets - conformance with the real chain', () => {
  /**
   * Bytes lifted from a confirmed Cardano Preprod transaction:
   * `ec00dbc3b03ae69d0490ec71fe678490d7bbbc3248a1e9056c4bf16ede430cc2`, output 0.
   *
   * This is the only offline check that proves the encoder agrees with the *ledger* rather than
   * with itself. Everything else in this file would pass just as happily against a consistently
   * wrong encoding.
   */
  const REAL_POLICY = '0000001c1f5134859ee40556e75834b9929d1b393ab94858a3d27ae0';
  const REAL_VALUE_CBOR =
    '821a001e8480a1581c0000001c1f5134859ee40556e75834b9929d1b393ab94858a3d27ae0' +
    'a244494e43591b00005af3107a400046424541434f4e01';

  it('encodes a multiasset value byte for byte as the chain does', () => {
    const encoded = Buffer.from(
      encodeValue(2_000_000n, [
        { policyId: REAL_POLICY, assetName: '424541434f4e', quantity: 1n },
        { policyId: REAL_POLICY, assetName: '494e4359', quantity: 100_000_000_000_000n }
      ])
    ).toString('hex');

    expect(encoded).toBe(REAL_VALUE_CBOR);
  });

  it('orders asset names by length first, which is what the chain does', () => {
    // In the real transaction `494e4359` (4 bytes) precedes `424541434f4e` (6 bytes), even though
    // `42…` sorts before `49…` lexicographically. Sorting purely lexicographically would produce a
    // different byte string and therefore a different transaction id.
    const shortNameFirst = Buffer.from(
      encodeValue(2_000_000n, [
        { policyId: REAL_POLICY, assetName: '494e4359', quantity: 1n },
        { policyId: REAL_POLICY, assetName: '424541434f4e', quantity: 1n }
      ])
    ).toString('hex');

    expect(shortNameFirst.indexOf('494e4359')).toBeLessThan(shortNameFirst.indexOf('424541434f4e'));
  });

  it('emits a bare coin, not a one-element value, when there are no assets', () => {
    // The two forms are not interchangeable, and the wrong one changes the size the fee is charged
    // for. `1a001e8480` is the bare uint 2000000.
    expect(Buffer.from(encodeValue(2_000_000n, [])).toString('hex')).toBe('1a001e8480');
  });

  it('drops zero quantities rather than emitting an asset with none of it', () => {
    expect(
      Buffer.from(
        encodeValue(2_000_000n, [{ policyId: REAL_POLICY, assetName: '494e4359', quantity: 0n }])
      ).toString('hex')
    ).toBe('1a001e8480');
  });
});

describe('native assets - reading balances', () => {
  it('sums one asset across outputs', () => {
    const utxos = [
      tokenUtxo(3_000_000n, [{ ...USDM, quantity: 20_000_000n }], 0, 'aa'.repeat(32)),
      tokenUtxo(3_000_000n, [{ ...USDM, quantity: 5_000_000n }], 0, 'bb'.repeat(32)),
      adaUtxo(1_000_000n)
    ];
    expect(assetBalance(utxos, USDM)).toBe(25_000_000n);
    expect(assetBalance(utxos, USDA)).toBe(0n);
  });

  it('totals every asset held, one entry each', () => {
    const totals = totalAssets([
      tokenUtxo(3_000_000n, [{ ...USDM, quantity: 20_000_000n }], 0, 'aa'.repeat(32)),
      tokenUtxo(
        3_000_000n,
        [
          { ...USDM, quantity: 5_000_000n },
          { ...USDA, quantity: 7_000_000n }
        ],
        0,
        'bb'.repeat(32)
      )
    ]);
    expect(totals).toHaveLength(2);
    expect(totals.find((a) => a.policyId === USDM.policyId)?.quantity).toBe(25_000_000n);
    expect(totals.find((a) => a.policyId === USDA.policyId)?.quantity).toBe(7_000_000n);
  });

  it('orders candidate inputs by how much of the asset they hold', () => {
    const small = tokenUtxo(3_000_000n, [{ ...USDM, quantity: 1_000_000n }], 0, 'aa'.repeat(32));
    const large = tokenUtxo(3_000_000n, [{ ...USDM, quantity: 90_000_000n }], 0, 'bb'.repeat(32));
    expect(utxosHolding([small, large], USDM)[0]).toBe(large);
  });
});

/** An ADA transfer — no `asset` — over the same fixtures. */
function adaPlan(utxos: CardanoUtxo[], amount: bigint) {
  return {
    utxos,
    destinationAddress: RECIPIENT,
    changeAddress: SENDER,
    amount,
    ttlSlot: TTL,
    parameters: PREPROD,
    witnessCount: 1
  };
}

describe('an ADA transfer reaching outputs that carry tokens', () => {
  it('spends the only output there is and brings its tokens home in the change', () => {
    // The shape that stranded funds: a wallet sends part of a token, its change lands in one output
    // holding the remainder, and from then on that ADA was neither spendable nor visible. Refusing
    // it left a wallet unable to move ADA it plainly held.
    const built = buildCardanoTransfer(
      adaPlan([tokenUtxo(100_000_000n, [{ ...USDM, quantity: 2_000_000n }])], 10_000_000n)
    );

    expect(built.sentLovelace).toBe(10_000_000n);
    expect(built.changeAssets).toHaveLength(1);
    expect(built.changeAssets[0].quantity).toBe(2_000_000n);
    // Nothing of the token may go missing: a transaction that does not return its inputs' assets
    // does not balance, and the ledger rejects it outright.
    expect(built.inputs).toHaveLength(1);
  });

  it('still balances: inputs = amount + fee + change', () => {
    const built = buildCardanoTransfer(
      adaPlan([tokenUtxo(100_000_000n, [{ ...USDM, quantity: 2_000_000n }])], 10_000_000n)
    );
    const consumed = built.inputs.reduce((sum, u) => sum + u.lovelace, 0n);

    expect(consumed).toBe(built.sentLovelace + built.fee + built.change);
  });

  it('leaves token-bearing outputs alone while plain ADA covers the transfer', () => {
    // Pulling one in drags its assets into the change and grows the transaction, so it is a last
    // resort and not a first choice — even when it is the largest output in the wallet.
    const tokens = tokenUtxo(100_000_000n, [{ ...USDM, quantity: 2_000_000n }], 0, 'aa'.repeat(32));
    const plain = adaUtxo(20_000_000n, 0, 'cc'.repeat(32));

    const built = buildCardanoTransfer(adaPlan([tokens, plain], 10_000_000n));

    expect(built.inputs).toHaveLength(1);
    expect(built.inputs[0].txHash).toBe('cc'.repeat(32));
    expect(built.changeAssets).toHaveLength(0);
  });

  it('reaches for one once the plain outputs run short, and carries every token home', () => {
    const plain = adaUtxo(5_000_000n, 0, 'cc'.repeat(32));
    const tokens = tokenUtxo(
      50_000_000n,
      [
        { ...USDM, quantity: 2_000_000n },
        { ...USDA, quantity: 7_000_000n }
      ],
      0,
      'aa'.repeat(32)
    );

    const built = buildCardanoTransfer(adaPlan([plain, tokens], 40_000_000n));

    expect(built.inputs).toHaveLength(2);
    expect(built.changeAssets).toHaveLength(2);
    expect(built.changeAssets.reduce((sum, a) => sum + a.quantity, 0n)).toBe(9_000_000n);
  });

  it('keeps the change above the floor the tokens raise it to', () => {
    // A change output carrying tokens is bigger than one carrying only ADA, so its min-ADA is
    // higher. Change that clears the plain floor can still fall under this one.
    const built = buildCardanoTransfer(
      adaPlan([tokenUtxo(100_000_000n, [{ ...USDM, quantity: 2_000_000n }])], 10_000_000n)
    );

    expect(built.change).toBeGreaterThanOrEqual(
      minimumAdaFor(SENDER, built.changeAssets, PREPROD.coinsPerUtxoByte)
    );
  });

  it('refuses rather than stranding the tokens when nothing can fund that floor', () => {
    // Sending everything is legal when the wallet holds only ADA — there is simply no change. With
    // tokens in the inputs there is no such escape: they have to come back, the output carrying
    // them has a floor, and nothing is left to fund it.
    expect(() =>
      buildCardanoTransfer(
        adaPlan([tokenUtxo(11_000_000n, [{ ...USDM, quantity: 2_000_000n }])], 10_000_000n)
      )
    ).toThrow(/CARDANO_CHANGE_WOULD_BE_BURNED|CARDANO_INSUFFICIENT_FUNDS/);
  });
});

describe('selectableUtxos - what the sender can reach', () => {
  it('offers plain ADA first and token-bearing outputs last, each largest first', () => {
    const bigToken = tokenUtxo(90_000_000n, [{ ...USDM, quantity: 1n }], 0, 'aa'.repeat(32));
    const smallPlain = adaUtxo(1_000_000n, 0, 'cc'.repeat(32));
    const bigPlain = adaUtxo(5_000_000n, 0, 'dd'.repeat(32));

    const order = selectableUtxos([bigToken, smallPlain, bigPlain]);

    expect(order.map((u) => u.lovelace)).toEqual([5_000_000n, 1_000_000n, 90_000_000n]);
  });

  it('counts every lovelace, tokens company included', () => {
    const utxos = [
      adaUtxo(5_000_000n, 0, 'cc'.repeat(32)),
      tokenUtxo(3_000_000n, [{ ...USDM, quantity: 1n }], 0, 'aa'.repeat(32))
    ];

    expect(selectableBalance(utxos)).toBe(8_000_000n);
    // The ADA-only view is what the sponsor uses, and it still excludes them.
    expect(spendableBalance(utxos)).toBe(5_000_000n);
  });
});

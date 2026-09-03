import { describe, expect, it } from 'vitest';

import { decodeCardanoAddress } from '../../../src/services/cardano/cardanoAddressService';
import {
  adaOnlyBalance,
  buildCardanoTransfer,
  encodeSignedTransaction,
  minimumAdaForOutput,
  spendableBalance,
  spendableUtxos,
  transactionIdOf
} from '../../../src/services/cardano/cardanoTxService';
import type { CardanoProtocolParameters, CardanoUtxo } from '../../../src/types/cardanoType';

/**
 * Protocol parameters as Cardano Preprod actually reports them (epoch 307).
 *
 * Real values rather than round numbers on purpose: the borders this suite exercises — dust change,
 * a balance that covers the amount but not the fee — sit at specific lovelace amounts that only
 * exist under the real `coinsPerUtxoByte`.
 */
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

/**
 * A base address — the shape ChatterPay actually issues.
 *
 * 57 bytes against the 29 of the enterprise fixtures above, which is the whole reason it is here:
 * every output paid to one is larger, so its min-ADA and its fee are larger too. The enterprise
 * fixtures stay because an enterprise address remains a legal destination and the builder must keep
 * accepting one.
 */
const BASE_RECIPIENT = decodeCardanoAddress(
  'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae'
)!.payload;

const TTL = 131_235_000;

function utxo(lovelace: bigint, index = 0, hash = 'aa'.repeat(32)): CardanoUtxo {
  return { txHash: hash, outputIndex: index, lovelace, holdsOtherAssets: false };
}

function plan(utxos: CardanoUtxo[], amount: bigint, witnessCount = 1) {
  return {
    utxos,
    destinationAddress: RECIPIENT,
    changeAddress: SENDER,
    amount,
    ttlSlot: TTL,
    parameters: PREPROD,
    witnessCount
  };
}

describe('cardanoTxService - the balance invariant', () => {
  it('always satisfies inputs = amount + fee + change', () => {
    // The invariant reconciliation depends on. Checked across a spread of shapes rather than one
    // happy case, because the place it breaks is the dust border, not the middle.
    for (const [funds, amount] of [
      [[15_000_000n], 2_000_000n],
      [[15_000_000n], 5_000_000n],
      [[5_000_000n, 5_000_000n], 8_000_000n],
      [[1_200_000n, 1_200_000n, 1_200_000n], 2_000_000n],
      // The shape that used to burn: selection covers the amount with one output and leaves a
      // remainder inside the dust window. The second output has to come in for it to survive.
      [[10_000_000n, 10_000_000n], 9_500_000n]
    ] as const) {
      const built = buildCardanoTransfer(
        plan(
          funds.map((v, i) => utxo(v, i)),
          amount
        )
      );
      const consumed = built.inputs.reduce((sum, input) => sum + input.lovelace, 0n);
      expect(consumed, `funds=${funds} amount=${amount}`).toBe(amount + built.fee + built.change);
    }
  });
});

describe('cardanoTxService - fee', () => {
  it('charges for the witness bytes, so two signers cost more than one', () => {
    // A fee computed over the body alone is short by about a hundred bytes per witness, which the
    // network answers with a rejection rather than a rounding error.
    const one = buildCardanoTransfer(plan([utxo(15_000_000n)], 2_000_000n, 1));
    const two = buildCardanoTransfer(plan([utxo(15_000_000n)], 2_000_000n, 2));
    expect(two.fee).toBeGreaterThan(one.fee);
  });

  it('does not depend on the amount, only on the size', () => {
    const small = buildCardanoTransfer(plan([utxo(15_000_000n)], 2_000_000n));
    const large = buildCardanoTransfer(plan([utxo(15_000_000n)], 5_000_000n));
    expect(small.fee).toBe(large.fee);
  });

  it('grows with the number of inputs', () => {
    const one = buildCardanoTransfer(plan([utxo(15_000_000n)], 2_000_000n));
    const many = buildCardanoTransfer(
      plan([utxo(2_000_000n, 0), utxo(2_000_000n, 1), utxo(2_000_000n, 2)], 4_000_000n)
    );
    expect(many.fee).toBeGreaterThan(one.fee);
  });
});

describe('cardanoTxService - change', () => {
  it('pulls another input rather than letting the remainder go to the fee', () => {
    // Two outputs of 10 ADA, sending 9.5: selection covers the amount with the first one and leaves
    // ~0.33 ADA, which is inside the dust window. Absorbing it means the sender pays half an ADA of
    // "fee" nobody quoted them — and on a sponsored transfer, one they were told was covered. The
    // second output comes in instead, and the remainder survives as change.
    const built = buildCardanoTransfer(
      plan([utxo(10_000_000n, 0), utxo(10_000_000n, 1)], 9_500_000n)
    );
    expect(built.inputs).toHaveLength(2);
    expect(built.change).toBeGreaterThan(849_070n);
    // The fee is the network's price for the bytes, not a hiding place for the remainder.
    expect(built.fee).toBeLessThan(200_000n);
  });

  it('refuses when the remainder would be lost and there is nothing left to select', () => {
    // 3 ADA in, 2 ADA out, one output: the ~0.84 ADA left cannot be its own UTxO and there is no
    // second output to pull. Refused rather than absorbed — the pre-flight turns this into a
    // message naming the two amounts that do work, before the operation starts.
    expect(() => buildCardanoTransfer(plan([utxo(3_000_000n)], 2_000_000n))).toThrow(
      /CARDANO_CHANGE_WOULD_BE_BURNED/
    );
  });

  it('keeps change as its own output when it clears the minimum', () => {
    const built = buildCardanoTransfer(plan([utxo(15_000_000n)], 2_000_000n));
    expect(built.change).toBeGreaterThan(0n);
    // Above the min-ADA of a change output to an enterprise address.
    expect(built.change).toBeGreaterThan(849_070n);
  });
});

describe('cardanoTxService - refusals, all of them before any signature', () => {
  it('refuses an amount below the min-ADA of the output that would carry it', () => {
    // Not a small payment: the ledger rejects the whole transaction.
    expect(() => buildCardanoTransfer(plan([utxo(15_000_000n)], 80_000n))).toThrow(
      /CARDANO_AMOUNT_BELOW_MINIMUM_UTXO/
    );
  });

  it('refuses when the funds cover the amount but not the fee', () => {
    // The nastiest border: a balance that looks sufficient right up to the moment it is not.
    expect(() => buildCardanoTransfer(plan([utxo(2_000_000n)], 2_000_000n))).toThrow(
      /CARDANO_INSUFFICIENT_FUNDS/
    );
  });

  it('refuses when there are not enough funds at all', () => {
    expect(() => buildCardanoTransfer(plan([utxo(1_000_000n)], 5_000_000n))).toThrow(
      /CARDANO_INSUFFICIENT_FUNDS/
    );
  });

  it('refuses a transaction over maxTxSize, which is what a fragmented wallet produces', () => {
    const dust = Array.from({ length: 600 }, (_, i) => utxo(1_000_000n, i));
    expect(() => buildCardanoTransfer(plan(dust, 590_000_000n))).toThrow(/CARDANO_TX_TOO_LARGE/);
  });
});

describe('cardanoTxService - coin selection', () => {
  it('never selects a UTxO holding native assets', () => {
    // Spending one would require carrying those assets into the change output, and V1 carries ADA
    // only. Its ADA stays unspent rather than silently burned.
    const withTokens: CardanoUtxo = {
      txHash: 'bb'.repeat(32),
      outputIndex: 0,
      lovelace: 100_000_000n,
      holdsOtherAssets: true
    };
    const built = buildCardanoTransfer(plan([withTokens, utxo(15_000_000n, 1)], 2_000_000n));
    expect(built.inputs.some((input) => input.holdsOtherAssets)).toBe(false);
    expect(built.inputs).toHaveLength(1);
    expect(built.inputs[0].lovelace).toBe(15_000_000n);
  });

  it('is deterministic when two UTxOs hold the same amount', () => {
    // A selection that changes between two identical calls is a fee that changes for no reason.
    const a = utxo(5_000_000n, 0, 'cc'.repeat(32));
    const b = utxo(5_000_000n, 0, 'bb'.repeat(32));
    const first = buildCardanoTransfer(plan([a, b], 2_000_000n));
    const second = buildCardanoTransfer(plan([b, a], 2_000_000n));
    expect(first.transactionId).toBe(second.transactionId);
    expect(first.inputs[0].txHash).toBe('bb'.repeat(32));
  });

  it('orders spendable UTxOs largest first', () => {
    const ordered = spendableUtxos([utxo(1_000_000n, 0), utxo(9_000_000n, 1), utxo(5_000_000n, 2)]);
    expect(ordered.map((u) => u.lovelace)).toEqual([9_000_000n, 5_000_000n, 1_000_000n]);
  });
});

describe('cardanoTxService - spendableBalance', () => {
  it('counts ADA sitting beside native assets, because the sponsor can spend it', () => {
    const utxos: CardanoUtxo[] = [
      utxo(5_000_000n, 0),
      { txHash: 'bb'.repeat(32), outputIndex: 0, lovelace: 100_000_000n, holdsOtherAssets: true }
    ];
    // Excluding these is what used to retire one of the sponsor's outputs on every token transfer:
    // its own change carries the fee asset, and the filter then refused to look at it again.
    expect(spendableBalance(utxos)).toBe(105_000_000n);
    // The ADA-only figure still exists, for the wallet view that means "not beside a token".
    expect(adaOnlyBalance(utxos)).toBe(5_000_000n);
  });

  it('is zero for an address nobody has funded', () => {
    expect(spendableBalance([])).toBe(0n);
  });
});

describe('cardanoTxService - serialization', () => {
  it('produces a reproducible transaction id: canonical CBOR, byte for byte', () => {
    // A body encoded two ways hashes to two different transactions, which would mean signing one
    // and submitting another.
    const first = buildCardanoTransfer(plan([utxo(15_000_000n)], 2_000_000n));
    const second = buildCardanoTransfer(plan([utxo(15_000_000n)], 2_000_000n));
    expect(first.transactionId).toBe(second.transactionId);
    expect(first.transactionId).toMatch(/^[0-9a-f]{64}$/);
    expect(transactionIdOf(first.bodyBytes)).toBe(first.transactionId);
  });

  it('refuses to serialize an unsigned transaction', () => {
    const built = buildCardanoTransfer(plan([utxo(15_000_000n)], 2_000_000n));
    expect(() => encodeSignedTransaction(built.bodyBytes, [])).toThrow('CARDANO_WITNESS_REQUIRED');
  });

  it('wraps the body verbatim, so what is submitted is what was hashed', () => {
    const built = buildCardanoTransfer(plan([utxo(15_000_000n)], 2_000_000n));
    const signed = encodeSignedTransaction(built.bodyBytes, [
      { publicKey: '11'.repeat(32), signature: '22'.repeat(64) }
    ]);
    expect(signed).toContain(Buffer.from(built.bodyBytes).toString('hex'));
    expect(transactionIdOf(built.bodyBytes)).toBe(built.transactionId);
  });
});

describe('cardanoTxService - minimumAdaForOutput', () => {
  it('prices an output from its own serialized size', () => {
    const small = minimumAdaForOutput(new Uint8Array(37), PREPROD.coinsPerUtxoByte);
    const large = minimumAdaForOutput(new Uint8Array(65), PREPROD.coinsPerUtxoByte);
    expect(small).toBe((160n + 37n) * 4310n);
    expect(large).toBeGreaterThan(small);
  });
});

describe('cardanoTxService - base addresses', () => {
  it('builds a transfer to a base address, which is what this deployment issues', () => {
    const built = buildCardanoTransfer({
      ...plan([utxo(15_000_000n)], 2_000_000n),
      destinationAddress: BASE_RECIPIENT,
      changeAddress: BASE_RECIPIENT
    });
    const consumed = built.inputs.reduce((sum, input) => sum + input.lovelace, 0n);
    expect(consumed).toBe(2_000_000n + built.fee + built.change);
  });

  it('costs more than the same transfer to an enterprise address', () => {
    // 28 extra bytes of staking credential on every output. Not a rounding error: the fee is
    // charged per byte and the min-ADA of an output is priced the same way, so a builder that sized
    // an output as if it were enterprise would underpay both.
    const enterprise = buildCardanoTransfer(plan([utxo(15_000_000n)], 2_000_000n));
    const base = buildCardanoTransfer({
      ...plan([utxo(15_000_000n)], 2_000_000n),
      destinationAddress: BASE_RECIPIENT,
      changeAddress: BASE_RECIPIENT
    });
    expect(base.fee).toBeGreaterThan(enterprise.fee);
    // Fee comes out of the change, and nothing else moved.
    expect(base.change).toBeLessThan(enterprise.change);
  });

  it('prices the min-ADA of a base output 28 bytes above an enterprise one', () => {
    const enterprise = minimumAdaForOutput(new Uint8Array(29 + 8), PREPROD.coinsPerUtxoByte);
    const base = minimumAdaForOutput(new Uint8Array(57 + 8), PREPROD.coinsPerUtxoByte);
    expect(base - enterprise).toBe(28n * PREPROD.coinsPerUtxoByte);
    // ~0.12 ADA. The number that makes issuing base addresses cheap enough to just do.
    expect(base - enterprise).toBe(120_680n);
  });
});

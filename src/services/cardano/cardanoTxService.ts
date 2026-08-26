/**
 * Cardano transactions, built from arithmetic instead of from a wallet library.
 *
 * Everything here is pure: it takes UTxOs, protocol parameters and a destination, and returns the
 * bytes a provider would submit. No network, no key material, no clock. That is what makes coin
 * selection and fee calculation testable against fabricated UTxOs, which is the only way to
 * exercise the borders — dust change, a balance that covers the amount but not the fee — without
 * arranging them on a real chain first.
 *
 * **Why hand-rolled CBOR.** The transaction body is a canonical CBOR map with four integer keys,
 * and its blake2b-256 hash is the transaction id. Pulling in a serialization library would add a
 * WASM dependency to sign four fields, and would not remove the need to understand them: the fee
 * depends on the serialized size, so the encoder is part of the fee calculation and not a detail
 * underneath it.
 *
 * **What V1 does not do**, declared rather than discovered: a UTxO holding native assets is never
 * selected, because spending it would require carrying those assets into the change output and V1
 * carries ADA only. Those UTxOs stay unspent and their ADA is not counted as available.
 */

import { blake2b } from '@noble/hashes/blake2';
import type {
  BuiltCardanoTransaction,
  CardanoAsset,
  CardanoAssetAmount,
  CardanoProtocolParameters,
  CardanoTransferPlan,
  CardanoUtxo,
  CardanoVkeyWitness
} from '../../types/cardanoType';
import { assetUnit } from '../../types/cardanoType';

/** CBOR major types, shifted into the high three bits of a head byte. */
const MAJOR_UNSIGNED = 0 << 5;
const MAJOR_BYTES = 2 << 5;
const MAJOR_ARRAY = 4 << 5;
const MAJOR_MAP = 5 << 5;
const MAJOR_TAG = 6 << 5;

/** `#6.258`, the tag Conway's CDDL puts in front of every set. */
const SET_TAG = 258;

/** `true` and `null` as CBOR simple values: the validity flag and the absent auxiliary data. */
const CBOR_TRUE = Uint8Array.from([0xf5]);
const CBOR_NULL = Uint8Array.from([0xf6]);

/** Constant overhead the ledger adds to a UTxO's serialized size when charging for it. */
const UTXO_ENTRY_SIZE_OVERHEAD = 160n;

/** Size of a transaction id, and of the blake2b digest that produces one. */
const TX_ID_BYTES = 32;

/** Size of a raw Ed25519 public key. */
const PUBLIC_KEY_BYTES = 32;

/** Size of a raw Ed25519 signature. */
const SIGNATURE_BYTES = 64;

/**
 * Ceiling on the build loop. Each pass can only raise the fee, and the fee raises the size by at
 * most a byte or two, so convergence takes two or three passes; more than this is a defect.
 */
const MAX_FEE_PASSES = 8;

/**
 * A CBOR head: the major type and either the value itself or the width of what follows.
 *
 * Always the shortest form that fits, which is what canonical CBOR requires and what makes the
 * transaction id reproducible: a body encoded two ways hashes to two different transactions.
 */
function head(major: number, value: bigint): Uint8Array {
  if (value < 24n) return Uint8Array.from([major | Number(value)]);
  if (value < 0x100n) return Uint8Array.from([major | 24, Number(value)]);
  if (value < 0x10000n) {
    return Uint8Array.from([major | 25, Number(value >> 8n), Number(value & 0xffn)]);
  }
  if (value < 0x100000000n) {
    const parts = [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn));
    return Uint8Array.from([major | 26, ...parts]);
  }
  const parts = [56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((shift) =>
    Number((value >> shift) & 0xffn)
  );
  return Uint8Array.from([major | 27, ...parts]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint(value: bigint | number): Uint8Array {
  return head(MAJOR_UNSIGNED, BigInt(value));
}

function bytes(value: Uint8Array): Uint8Array {
  return concat([head(MAJOR_BYTES, BigInt(value.length)), value]);
}

function array(items: readonly Uint8Array[]): Uint8Array {
  return concat([head(MAJOR_ARRAY, BigInt(items.length)), ...items]);
}

/**
 * A definite-length map. Entries are written in the order given, which for the transaction body
 * means ascending integer keys — the canonical order.
 */
function map(entries: readonly (readonly [Uint8Array, Uint8Array])[]): Uint8Array {
  return concat([head(MAJOR_MAP, BigInt(entries.length)), ...entries.flat()]);
}

function tagged(tag: number, value: Uint8Array): Uint8Array {
  return concat([head(MAJOR_TAG, BigInt(tag)), value]);
}

function set(items: readonly Uint8Array[]): Uint8Array {
  return tagged(SET_TAG, array(items));
}

function hexToBytes(value: string): Uint8Array {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('CARDANO_INVALID_HEX');
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

/**
 * The minimum lovelace an output is allowed to hold, given its own size.
 *
 * An output below this is not a small payment: the ledger rejects the whole transaction. It is what
 * decides whether change can exist as its own UTxO or has to go somewhere else.
 *
 * @param output - The serialized output being priced.
 * @param coinsPerUtxoByte - Protocol parameter, lovelace per byte.
 * @returns The minimum the output must hold, in lovelace.
 */
export function minimumAdaForOutput(output: Uint8Array, coinsPerUtxoByte: bigint): bigint {
  return (UTXO_ENTRY_SIZE_OVERHEAD + BigInt(output.length)) * coinsPerUtxoByte;
}

/**
 * Orders map keys the way canonical CBOR does: shorter first, then bytewise.
 *
 * Asset names run from 0 to 32 bytes, so length has to come first — and the order matters beyond
 * tidiness, because the transaction id is the hash of these exact bytes. Two encodings of the same
 * value are two different transactions.
 *
 * @param left - Hex of the first key.
 * @param right - Hex of the second key.
 * @returns Negative, zero or positive, for `sort`.
 */
function compareCborKeys(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Serializes a `multiasset`: `{ policy_id => { asset_name => quantity } }`.
 *
 * @param assets - The assets to encode. Quantities of zero are dropped: the ledger has no
 *   representation for "zero of an asset" inside a value, and emitting one is a malformed output.
 * @returns The canonical CBOR of the multiasset map.
 */
function encodeMultiasset(assets: readonly CardanoAssetAmount[]): Uint8Array {
  const byPolicy = new Map<string, Map<string, bigint>>();
  for (const asset of assets) {
    if (asset.quantity <= 0n) continue;
    const policyId = asset.policyId.toLowerCase();
    const assetName = asset.assetName.toLowerCase();
    const names = byPolicy.get(policyId) ?? new Map<string, bigint>();
    names.set(assetName, (names.get(assetName) ?? 0n) + asset.quantity);
    byPolicy.set(policyId, names);
  }

  const policies = [...byPolicy.keys()].sort(compareCborKeys);
  return map(
    policies.map((policyId) => {
      const names = byPolicy.get(policyId)!;
      const sortedNames = [...names.keys()].sort(compareCborKeys);
      return [
        bytes(hexToBytes(policyId)),
        map(
          sortedNames.map(
            (assetName) => [bytes(hexToBytes(assetName)), uint(names.get(assetName)!)] as const
          )
        )
      ] as const;
    })
  );
}

/**
 * A `value`: bare coin when there are no tokens, `[coin, multiasset]` when there are.
 *
 * The two forms are not interchangeable. Wrapping a token-free value in the array form is accepted
 * by some tools and rejected by others, and it changes the size the fee is charged for.
 */
export function encodeValue(lovelace: bigint, assets: readonly CardanoAssetAmount[]): Uint8Array {
  const positive = assets.filter((asset) => asset.quantity > 0n);
  return positive.length === 0
    ? uint(lovelace)
    : array([uint(lovelace), encodeMultiasset(positive)]);
}

/** A `transaction_output` in the legacy array form: address bytes and the value it holds. */
function encodeOutput(
  addressBytes: Uint8Array,
  lovelace: bigint,
  assets: readonly CardanoAssetAmount[] = []
): Uint8Array {
  return array([bytes(addressBytes), encodeValue(lovelace, assets)]);
}

/** A `transaction_input`: the id of the transaction that created the output, and its index. */
function encodeInput(utxo: CardanoUtxo): Uint8Array {
  return array([bytes(hexToBytes(utxo.txHash)), uint(utxo.outputIndex)]);
}

/**
 * Serializes a `transaction_body`.
 *
 * @param inputs - Outputs being spent.
 * @param outputs - Already-serialized outputs, in order.
 * @param fee - Fee in lovelace.
 * @param ttlSlot - Slot after which the transaction is no longer valid.
 * @returns The canonical CBOR of the body.
 */
function encodeBody(
  inputs: readonly CardanoUtxo[],
  outputs: readonly Uint8Array[],
  fee: bigint,
  ttlSlot: number
): Uint8Array {
  return map([
    [uint(0), set(inputs.map(encodeInput))],
    [uint(1), array(outputs)],
    [uint(2), uint(fee)],
    [uint(3), uint(ttlSlot)]
  ]);
}

/**
 * The transaction id of a body: its blake2b-256 hash.
 *
 * @param bodyBytes - Serialized `transaction_body`.
 * @returns The transaction id, hex without `0x`.
 */
export function transactionIdOf(bodyBytes: Uint8Array): string {
  return bytesToHex(blake2b(bodyBytes, { dkLen: TX_ID_BYTES }));
}

/**
 * Assembles the signed transaction a provider accepts.
 *
 * @param bodyBytes - The serialized body the witnesses signed. Reused verbatim rather than
 *   re-encoded, so the submitted transaction cannot differ from the one that was hashed and signed.
 * @param witnesses - One entry per distinct signing key.
 * @returns The serialized signed transaction, hex without `0x`.
 * @throws Error `CARDANO_WITNESS_REQUIRED` when no witness is supplied: an unsigned transaction is
 *   not a transaction anyone can submit, and returning one would defer the failure to the provider.
 */
export function encodeSignedTransaction(
  bodyBytes: Uint8Array,
  witnesses: readonly CardanoVkeyWitness[]
): string {
  if (witnesses.length === 0) throw new Error('CARDANO_WITNESS_REQUIRED');
  const witnessSet = map([
    [
      uint(0),
      set(
        witnesses.map((witness) =>
          array([bytes(hexToBytes(witness.publicKey)), bytes(hexToBytes(witness.signature))])
        )
      )
    ]
  ]);
  return bytesToHex(array([bodyBytes, witnessSet, CBOR_TRUE, CBOR_NULL]));
}

/**
 * The fee a transaction of this size pays, per the protocol parameters.
 *
 * @param sizeBytes - Size of the **signed** transaction. The witnesses are part of what the network
 *   charges for, so a fee computed over the body alone is short by about a hundred bytes.
 * @param parameters - Protocol parameters in force.
 * @returns The fee in lovelace.
 */
function feeForSize(sizeBytes: number, parameters: CardanoProtocolParameters): bigint {
  return BigInt(parameters.minFeeA) * BigInt(sizeBytes) + BigInt(parameters.minFeeB);
}

/**
 * UTxOs V1 is willing to spend, largest first.
 *
 * Largest-first is chosen for being deterministic and for keeping the input count low, which is
 * what keeps the fee down. It fragments the wallet over time, and that is accepted debt: a
 * production selector would balance UTxO count against fee, and this one is auditable.
 *
 * @param utxos - Everything the address holds.
 * @returns The spendable subset, ordered by descending value and then by outpoint, so that equal
 *   values do not select in provider order — a selection that changes between two identical calls
 *   is a fee that changes for no reason.
 */
export function spendableUtxos(utxos: readonly CardanoUtxo[]): CardanoUtxo[] {
  return utxos
    .filter((utxo) => !utxo.holdsOtherAssets)
    .slice()
    .sort((left, right) => {
      if (left.lovelace !== right.lovelace) return left.lovelace > right.lovelace ? -1 : 1;
      const byHash = left.txHash.localeCompare(right.txHash);
      return byHash !== 0 ? byHash : left.outputIndex - right.outputIndex;
    });
}

/**
 * What a wallet can spend as plain ADA right now.
 *
 * Excludes ADA sitting in outputs that also hold native assets: it is real, and it is not available
 * to an ADA transfer, because spending that output would drag its tokens along.
 *
 * @param utxos - Everything the address holds.
 * @returns Spendable lovelace.
 */
export function spendableBalance(utxos: readonly CardanoUtxo[]): bigint {
  return spendableUtxos(utxos).reduce((sum, utxo) => sum + utxo.lovelace, 0n);
}

/** The native assets an output holds, normalised to lowercase hex. */
function assetsOf(utxo: CardanoUtxo): CardanoAssetAmount[] {
  return (utxo.assets ?? []).map((asset) => ({
    policyId: asset.policyId.toLowerCase(),
    assetName: asset.assetName.toLowerCase(),
    quantity: asset.quantity
  }));
}

/** A stable key for an unspent output. */
function outpointOf(utxo: CardanoUtxo): string {
  return `${utxo.txHash}#${utxo.outputIndex}`;
}

/**
 * How much of one asset an output holds.
 *
 * @param utxo - The output.
 * @param asset - The asset being counted.
 * @returns The quantity, `0n` when the output does not hold it.
 */
function quantityOf(utxo: CardanoUtxo, asset: CardanoAsset): bigint {
  const unit = assetUnit(asset);
  return assetsOf(utxo)
    .filter((held) => assetUnit(held) === unit)
    .reduce((sum, held) => sum + held.quantity, 0n);
}

/**
 * How much of one asset a wallet holds in total.
 *
 * @param utxos - Everything the address holds.
 * @param asset - The asset being counted.
 * @returns The quantity across every output.
 */
export function assetBalance(utxos: readonly CardanoUtxo[], asset: CardanoAsset): bigint {
  return utxos.reduce((sum, utxo) => sum + quantityOf(utxo, asset), 0n);
}

/**
 * Every native asset a wallet holds, summed per asset.
 *
 * @param utxos - Outputs to total.
 * @returns One entry per distinct asset, in canonical key order.
 */
export function totalAssets(utxos: readonly CardanoUtxo[]): CardanoAssetAmount[] {
  const totals = new Map<string, CardanoAssetAmount>();
  for (const utxo of utxos) {
    for (const asset of assetsOf(utxo)) {
      const unit = assetUnit(asset);
      const current = totals.get(unit);
      totals.set(
        unit,
        current ? { ...current, quantity: current.quantity + asset.quantity } : { ...asset }
      );
    }
  }
  return [...totals.values()].sort((left, right) =>
    compareCborKeys(assetUnit(left), assetUnit(right))
  );
}

/**
 * Outputs holding a given asset, most of it first.
 *
 * Largest-first over the *asset* rather than over ADA: covering the quantity in as few inputs as
 * possible is what keeps the transaction small, and the transaction size is the fee.
 *
 * @param utxos - Everything the address holds.
 * @param asset - The asset being spent.
 * @returns The outputs that hold it, ordered deterministically.
 */
export function utxosHolding(utxos: readonly CardanoUtxo[], asset: CardanoAsset): CardanoUtxo[] {
  return utxos
    .filter((utxo) => quantityOf(utxo, asset) > 0n)
    .slice()
    .sort((left, right) => {
      const byQuantity = quantityOf(right, asset) - quantityOf(left, asset);
      if (byQuantity !== 0n) return byQuantity > 0n ? 1 : -1;
      return outpointOf(left).localeCompare(outpointOf(right));
    });
}

/**
 * The smallest lovelace an output holding these assets may carry.
 *
 * Iterated rather than computed in one shot: the minimum depends on the output's serialized size,
 * and the size depends on how many bytes the lovelace figure itself takes. Two or three passes.
 *
 * @param addressBytes - Address the output pays.
 * @param assets - Assets the output carries.
 * @param coinsPerUtxoByte - Protocol parameter.
 * @returns The minimum, in lovelace.
 * @throws Error `CARDANO_MIN_ADA_DID_NOT_CONVERGE` when the loop fails to settle.
 */
export function minimumAdaFor(
  addressBytes: Uint8Array,
  assets: readonly CardanoAssetAmount[],
  coinsPerUtxoByte: bigint
): bigint {
  let value = minimumAdaForOutput(encodeOutput(addressBytes, 0n, assets), coinsPerUtxoByte);
  for (let pass = 0; pass < 4; pass++) {
    const required = minimumAdaForOutput(
      encodeOutput(addressBytes, value, assets),
      coinsPerUtxoByte
    );
    if (required <= value) return value;
    value = required;
  }
  throw new Error('CARDANO_MIN_ADA_DID_NOT_CONVERGE');
}

/** What is left of the inputs' assets after sending one of them. */
function residualAssets(
  selected: readonly CardanoUtxo[],
  sent: CardanoAssetAmount
): CardanoAssetAmount[] {
  const sentUnit = assetUnit(sent);
  return totalAssets(selected)
    .map((held) =>
      assetUnit(held) === sentUnit ? { ...held, quantity: held.quantity - sent.quantity } : held
    )
    .filter((held) => held.quantity > 0n);
}

/**
 * Takes UTxOs off the front of an already-ordered list until they cover `target`.
 *
 * @param available - Spendable outputs, largest first.
 * @param target - Amount plus fee that has to be covered.
 * @returns The selected outputs.
 * @throws Error `CARDANO_INSUFFICIENT_FUNDS` when everything spendable is not enough.
 */
/**
 * What the selection below would actually gather for a target.
 *
 * Exported because the pre-flight has to answer the same question this builder answers, and
 * answering it against the *balance* instead of against the *selection* is how a transfer gets
 * approved and then burns the remainder: coin selection stops as soon as it covers the target, so
 * the change is whatever the chosen outputs leave over, not whatever the wallet holds.
 *
 * @param utxos - Everything the address holds, spendable or not.
 * @param target - Lovelace the selection has to cover.
 * @returns The lovelace the selection gathers, or `null` when it cannot reach the target.
 */
export function selectionTotalFor(utxos: readonly CardanoUtxo[], target: bigint): bigint | null {
  let total = 0n;
  for (const utxo of spendableUtxos(utxos)) {
    total += utxo.lovelace;
    if (total >= target) return total;
  }
  return null;
}

function selectFor(available: readonly CardanoUtxo[], target: bigint): CardanoUtxo[] {
  const selected: CardanoUtxo[] = [];
  let total = 0n;
  for (const utxo of available) {
    selected.push(utxo);
    total += utxo.lovelace;
    if (total >= target) return selected;
  }
  throw new Error(`CARDANO_INSUFFICIENT_FUNDS: have ${total} lovelace, need ${target}`);
}

/**
 * Builds a transfer: selects inputs, computes the exact fee, and places the change.
 *
 * The fee depends on the size, the size depends on the fee and the change, and the change depends
 * on the fee — so this iterates until the fee stops rising rather than padding an estimate. What
 * comes out is exact: the fee in the body is the fee the network charges for those bytes.
 *
 * Change below the minimum a UTxO may hold cannot be returned as an output and is added to the fee
 * instead. That is a real cost to the sender and it is reported as fee rather than hidden, which is
 * what lets reconciliation add up: inputs = amount + fee + change, always.
 *
 * **The accrued ChatterPay fee is collected only when it is free to collect.** It is a debt with no
 * deadline, so it never gets to be the reason a transfer fails, and it never gets to cost the
 * sender more than itself: the transfer is built both ways and the collecting build is taken only
 * if it both succeeds and does not push the sender's change under min-ADA. Otherwise the debt
 * stands and the next transfer tries again. `feeCollected` on the result says which happened.
 *
 * @param plan - Inputs, addresses, amount, expiry and parameters.
 * @returns The body, its transaction id, and the numbers the ledger reconciles against.
 * @throws Error `CARDANO_AMOUNT_BELOW_MINIMUM_UTXO` when the amount itself is under the min-ADA of
 *   the output that would carry it — the network would reject the transaction, so it is refused
 *   before anything is signed.
 * @throws Error `CARDANO_INSUFFICIENT_FUNDS` when the spendable UTxOs do not cover amount plus fee.
 *   Raised before signing on purpose: a transaction that cannot pay its own fee has no partial
 *   outcome to recover from.
 * @throws Error `CARDANO_TX_TOO_LARGE` when the transaction exceeds `maxTxSize`, which is what a
 *   wallet fragmented into many small UTxOs eventually produces.
 * @throws Error `CARDANO_FEE_DID_NOT_CONVERGE` when the fee loop fails to settle.
 */
export function buildCardanoTransfer(plan: CardanoTransferPlan): BuiltCardanoTransaction {
  const build = (candidate: CardanoTransferPlan): BuiltCardanoTransaction =>
    candidate.asset ? buildAssetTransfer(candidate, candidate.asset) : buildAdaTransfer(candidate);

  const owed = plan.feeCollectionLovelace ?? 0n;
  if (owed <= 0n) return build(plan);

  // Built first, and it is this one that decides whether the transfer happens at all. The accrued
  // fee is a debt with no deadline — that is the whole point of accruing it — so it must never be
  // the reason a transfer the sender could otherwise afford gets refused. If this throws, the
  // wallet is genuinely short, and the message says so without a collection the user never asked
  // for inflating the figure it names.
  const deferred = build({ ...plan, feeCollectionLovelace: undefined });

  let collecting: BuiltCardanoTransaction;
  try {
    collecting = build(plan);
  } catch (error) {
    if (!isShortOfAda(error)) throw error;
    return deferred;
  }

  // The builder declined it on its own: below min-ADA the fee cannot be an output at all.
  if ((collecting.feeCollected ?? 0n) <= 0n) return deferred;

  // Both build. Take the collecting one only if collecting is all it costs — see the constant.
  return collecting.fee - deferred.fee <= FEE_COLLECTION_MAX_EXTRA_COST ? collecting : deferred;
}

/**
 * Tolerance on what collecting the accrued fee may cost the sender beyond the fee itself.
 *
 * The extra output adds bytes and bytes are lovelace: a few thousand, unavoidable, fine. What is
 * not fine is the collection pushing the sender's change under min-ADA, because change that cannot
 * be an output is absorbed into the network fee — the sender loses it *on top of* the fee, the
 * transaction still succeeds, and the only way to find out is to read it on chain. Costing more
 * than this ceiling means that happened, not that the transaction grew.
 */
const FEE_COLLECTION_MAX_EXTRA_COST = 50_000n;

/**
 * Whether an error is a builder refusing for lack of ADA, as opposed to a defect.
 *
 * Matched on the code rather than on a class because the builders raise plain `Error`s carrying a
 * machine-readable prefix, and every caller up to the controller already reads them that way.
 */
function isShortOfAda(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('CARDANO_INSUFFICIENT_FUNDS');
}

/**
 * Builds a plain ADA transfer.
 *
 * @param plan - Inputs, addresses, amount, expiry and parameters.
 * @returns The body, its transaction id, and the numbers the ledger reconciles against.
 */
function buildAdaTransfer(plan: CardanoTransferPlan): BuiltCardanoTransaction {
  const { parameters, amount, ttlSlot } = plan;

  const paymentOutput = encodeOutput(plan.destinationAddress, amount);
  const minimumPayment = minimumAdaForOutput(paymentOutput, parameters.coinsPerUtxoByte);
  if (amount < minimumPayment) {
    throw new Error(`CARDANO_AMOUNT_BELOW_MINIMUM_UTXO: ${minimumPayment} lovelace minimum`);
  }

  const available = spendableUtxos(plan.utxos);
  const placeholderWitnesses = Array.from({ length: Math.max(1, plan.witnessCount) }, () => ({
    publicKey: '00'.repeat(PUBLIC_KEY_BYTES),
    signature: '00'.repeat(SIGNATURE_BYTES)
  }));
  const signedSizeOf = (body: Uint8Array): number =>
    encodeSignedTransaction(body, placeholderWitnesses).length / 2;

  const sponsor = plan.sponsor;
  const sponsorAvailable = sponsor ? spendableUtxos(sponsor.utxos) : [];

  // Fee collection: when the accumulated ChatterPay fee clears min-ADA, it becomes an extra output
  // to the sponsor's address. The sender pays it on top of the amount.
  const feeCollection = plan.feeCollectionLovelace ?? 0n;
  const feeCollectionOutput =
    feeCollection > 0n && sponsor
      ? encodeOutput(sponsor.changeAddress, feeCollection)
      : new Uint8Array();
  const collectsFee =
    feeCollection > 0n &&
    sponsor !== undefined &&
    feeCollection >= minimumAdaForOutput(feeCollectionOutput, parameters.coinsPerUtxoByte);

  // The sender covers: amount + fee collection (if any). Sponsor covers network fee.
  const senderOwes = amount + (collectsFee ? feeCollection : 0n);

  let fee = feeForSize(0, parameters);
  for (let pass = 0; pass < MAX_FEE_PASSES; pass++) {
    const target = sponsor ? senderOwes : senderOwes + fee;
    let selected = selectFor(available, target);
    let total = selected.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
    let change = total - target;

    // Change below the floor is change the network takes as fee: the transfer succeeds and the
    // sender is quietly short by up to a whole min-ADA. Coin selection stops as soon as it covers
    // the target, so this is not a matter of the wallet being poor — it is one output's remainder
    // landing in the gap. Pulling one more output is what a wallet does about it, and it is only
    // when there is nothing left to pull that the transfer has to be refused.
    const floor = minimumAdaForOutput(
      encodeOutput(plan.changeAddress, change),
      parameters.coinsPerUtxoByte
    );
    if (change > 0n && change < floor) {
      let widened: CardanoUtxo[];
      try {
        widened = selectFor(available, target + floor);
      } catch {
        throw new Error(
          `CARDANO_CHANGE_WOULD_BE_BURNED: ${change} lovelace of change is below the ${floor} ` +
            `an output must hold, and there is nothing further to select`
        );
      }
      selected = widened;
      total = selected.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
      change = total - target;
    }

    const sponsorSelected = sponsor ? selectFor(sponsorAvailable, fee) : [];
    const sponsorTotal = sponsorSelected.reduce((sum, utxo) => sum + utxo.lovelace, 0n);

    const changeOutput = encodeOutput(plan.changeAddress, change);
    const keepsChange =
      change > 0n && change >= minimumAdaForOutput(changeOutput, parameters.coinsPerUtxoByte);
    if (!keepsChange && change > 0n) {
      throw new Error(
        `CARDANO_CHANGE_WOULD_BE_BURNED: ${change} lovelace is below the minimum an output may hold`
      );
    }
    if (!keepsChange) change = 0n;

    let sponsorChange = sponsor ? sponsorTotal - fee : 0n;
    const sponsorChangeOutput = sponsor
      ? encodeOutput(sponsor.changeAddress, sponsorChange)
      : new Uint8Array();
    const keepsSponsorChange =
      sponsor !== undefined &&
      sponsorChange > 0n &&
      sponsorChange >= minimumAdaForOutput(sponsorChangeOutput, parameters.coinsPerUtxoByte);
    if (!keepsSponsorChange) sponsorChange = 0n;

    const outputs = [
      paymentOutput,
      ...(collectsFee ? [feeCollectionOutput] : []),
      ...(keepsChange ? [changeOutput] : []),
      ...(keepsSponsorChange ? [sponsorChangeOutput] : [])
    ];
    const inputs = [...selected, ...sponsorSelected];
    const body = encodeBody(
      inputs,
      outputs,
      total + sponsorTotal - amount - (collectsFee ? feeCollection : 0n) - change - sponsorChange,
      ttlSlot
    );
    const size = signedSizeOf(body);
    if (size > parameters.maxTxSize) {
      throw new Error(`CARDANO_TX_TOO_LARGE: ${size} bytes over ${parameters.maxTxSize}`);
    }

    const required = feeForSize(size, parameters);
    if (required <= fee) {
      return {
        bodyBytes: body,
        transactionId: transactionIdOf(body),
        fee:
          total +
          sponsorTotal -
          amount -
          (collectsFee ? feeCollection : 0n) -
          change -
          sponsorChange,
        sentLovelace: amount,
        change,
        changeAssets: [],
        inputs,
        ttlSlot,
        feeCollected: collectsFee ? feeCollection : 0n
      };
    }
    fee = required;
  }

  throw new Error('CARDANO_FEE_DID_NOT_CONVERGE');
}

/**
 * Builds a native-asset transfer.
 *
 * Three things make this different from the ADA path, and all three are consequences of the same
 * rule — a Cardano output carries a *value*, and a token cannot travel without ADA beside it:
 *
 * 1. **The token output must carry ADA.** The minimum is set by the output's own size, and for a
 *    token output it lands around 1.2–1.5 ADA. That ADA leaves the sender and arrives at the
 *    recipient; it is not a fee, and it is not optional.
 * 2. **Residual tokens must come back.** Spending an output holding 100 USDM to send 30 requires a
 *    change output carrying 70. Unlike dust ADA, residual tokens can never be folded into the fee:
 *    a transaction that does not return them does not balance and the ledger rejects it. So when
 *    there are residuals the change output is mandatory, and if the selected inputs cannot fund its
 *    min-ADA, more ADA has to be pulled in.
 * 3. **Selection is two-dimensional.** Inputs must cover the token quantity *and* enough ADA for
 *    the token output, the fee and the change. Covering one says nothing about the other.
 *
 * @param plan - Inputs, addresses, expiry and parameters.
 * @param asset - The asset and quantity being sent.
 * @returns The body, its transaction id, and the numbers the ledger reconciles against.
 * @throws Error `CARDANO_INVALID_ASSET_QUANTITY` for a non-positive quantity.
 * @throws Error `CARDANO_INSUFFICIENT_TOKEN_BALANCE` when the wallet does not hold enough of it.
 * @throws Error `CARDANO_INSUFFICIENT_FUNDS` when there is not enough ADA to carry the transfer —
 *   which is the state a wallet holding stablecoins and no ADA is permanently in.
 * @throws Error `CARDANO_TX_TOO_LARGE`, `CARDANO_FEE_DID_NOT_CONVERGE` as in the ADA path.
 */
function buildAssetTransfer(
  plan: CardanoTransferPlan,
  asset: CardanoAssetAmount
): BuiltCardanoTransaction {
  const { parameters, ttlSlot } = plan;
  if (asset.quantity <= 0n) throw new Error('CARDANO_INVALID_ASSET_QUANTITY');

  const sent: CardanoAssetAmount = {
    policyId: asset.policyId.toLowerCase(),
    assetName: asset.assetName.toLowerCase(),
    quantity: asset.quantity
  };

  // Inputs that carry the token, fewest first. Refused here rather than after a signature.
  const holders = utxosHolding(plan.utxos, sent);
  const assetInputs: CardanoUtxo[] = [];
  let held = 0n;
  for (const utxo of holders) {
    assetInputs.push(utxo);
    held += quantityOf(utxo, sent);
    if (held >= sent.quantity) break;
  }
  if (held < sent.quantity) {
    throw new Error(`CARDANO_INSUFFICIENT_TOKEN_BALANCE: have ${held}, need ${sent.quantity}`);
  }

  // Outputs available to top the transaction up, in the order they should be reached for.
  //
  // Pure-ADA ones come first because they add no bytes beyond the input itself. Outputs holding
  // *other* tokens come after: pulling one in drags its assets into the change output and grows the
  // transaction, but a wallet holding several stablecoins and no loose ADA has nothing else — and
  // refusing it would be refusing a transfer the wallet can plainly afford.
  const alreadyChosen = new Set(assetInputs.map(outpointOf));
  const untouched = plan.utxos.filter((utxo) => !alreadyChosen.has(outpointOf(utxo)));
  const byLovelaceDescending = (left: CardanoUtxo, right: CardanoUtxo): number => {
    if (left.lovelace !== right.lovelace) return left.lovelace > right.lovelace ? -1 : 1;
    return outpointOf(left).localeCompare(outpointOf(right));
  };
  const spare = [
    ...untouched.filter((utxo) => !utxo.holdsOtherAssets).sort(byLovelaceDescending),
    ...untouched.filter((utxo) => utxo.holdsOtherAssets).sort(byLovelaceDescending)
  ];

  // Sponsoring works here exactly as it does on the ADA path: a second wallet contributes inputs
  // that cover the network fee and gets its own change back. Only its ADA-only outputs are taken —
  // pulling in a sponsor UTxO that holds tokens would drag them into a change output belonging to
  // the sender, which is how a sponsor quietly gives its assets away.
  const sponsor = plan.sponsor;
  const sponsorAvailable = sponsor ? spendableUtxos(sponsor.utxos) : [];

  const placeholderWitnesses = Array.from({ length: Math.max(1, plan.witnessCount) }, () => ({
    publicKey: '00'.repeat(PUBLIC_KEY_BYTES),
    signature: '00'.repeat(SIGNATURE_BYTES)
  }));
  const signedSizeOf = (body: Uint8Array): number =>
    encodeSignedTransaction(body, placeholderWitnesses).length / 2;

  // The ADA attached to the token output: what the caller asked for, or the protocol minimum.
  const minimumAttached = minimumAdaFor(
    plan.destinationAddress,
    [sent],
    parameters.coinsPerUtxoByte
  );
  const attached = plan.amount > 0n ? plan.amount : minimumAttached;
  if (attached < minimumAttached) {
    throw new Error(`CARDANO_AMOUNT_BELOW_MINIMUM_UTXO: ${minimumAttached} lovelace minimum`);
  }
  const paymentOutput = encodeOutput(plan.destinationAddress, attached, [sent]);

  // Fee collection: the accumulated ChatterPay fee becomes an extra output to the sponsor's
  // address, paid by the sender on top of the ADA the token drags along. Below min-ADA it cannot be
  // an output at all, so it stays owed and is collected once it has grown enough.
  const feeCollection = plan.feeCollectionLovelace ?? 0n;
  const feeCollectionOutput =
    feeCollection > 0n && sponsor
      ? encodeOutput(sponsor.changeAddress, feeCollection)
      : new Uint8Array();
  const collectsFee =
    feeCollection > 0n &&
    sponsor !== undefined &&
    feeCollection >= minimumAdaForOutput(feeCollectionOutput, parameters.coinsPerUtxoByte);
  const collected = collectsFee ? feeCollection : 0n;

  // One pass per extra ADA-only input. Each pass runs the fee loop to convergence; a pass that
  // cannot fund the mandatory change output asks for one more input rather than giving up.
  let shortfall = '';
  for (let extra = 0; extra <= spare.length; extra++) {
    const selected = [...assetInputs, ...spare.slice(0, extra)];
    const inputAda = selected.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
    const residual = residualAssets(selected, sent);

    let fee = feeForSize(0, parameters);
    // Distinguishes "this selection cannot pay" — which one more input might fix — from "the fee
    // loop failed to settle", which is a defect and must not be retried into silence.
    let needsMoreAda = false;

    for (let pass = 0; pass < MAX_FEE_PASSES; pass++) {
      const sponsorSelected = sponsor ? selectFor(sponsorAvailable, fee) : [];
      const sponsorTotal = sponsorSelected.reduce((sum, utxo) => sum + utxo.lovelace, 0n);

      // What the sender owes: the ADA attached to the token output, plus the fee being collected.
      // The network fee is on this list only when nobody is sponsoring it.
      const senderOwes = attached + collected + (sponsor ? 0n : fee);
      const change = inputAda - senderOwes;
      if (change < 0n) {
        shortfall = `CARDANO_INSUFFICIENT_FUNDS: ${inputAda} lovelace available, need at least ${senderOwes}`;
        needsMoreAda = true;
        break;
      }

      const changeOutput = encodeOutput(plan.changeAddress, change, residual);
      const minimumChange = minimumAdaForOutput(changeOutput, parameters.coinsPerUtxoByte);
      let keepsChange: boolean;

      if (residual.length > 0) {
        // Mandatory: the tokens have nowhere else to go.
        if (change < minimumChange) {
          shortfall =
            `CARDANO_INSUFFICIENT_FUNDS: change output must hold ${minimumChange} lovelace ` +
            `to carry ${residual.length} residual asset(s), only ${change} available`;
          needsMoreAda = true;
          break;
        }
        keepsChange = true;
      } else if (change > 0n && change < minimumChange) {
        // The same gap the ADA path guards: a remainder too small to stand as its own output is a
        // remainder the network keeps. Asking for more ADA pulls another input in, which is what
        // closes it; running out of inputs ends the loop with the shortfall below.
        shortfall =
          `CARDANO_INSUFFICIENT_FUNDS: change of ${change} lovelace is below the ${minimumChange} ` +
          `an output must hold, and would be lost to the network as fee`;
        needsMoreAda = true;
        break;
      } else {
        keepsChange = change > 0n;
      }

      let sponsorChange = sponsor ? sponsorTotal - fee : 0n;
      const sponsorChangeOutput = sponsor
        ? encodeOutput(sponsor.changeAddress, sponsorChange)
        : new Uint8Array();
      const keepsSponsorChange =
        sponsor !== undefined &&
        sponsorChange > 0n &&
        sponsorChange >= minimumAdaForOutput(sponsorChangeOutput, parameters.coinsPerUtxoByte);
      // Below min-ADA the sponsor's leftover cannot be an output, so it stays in the fee. The
      // sponsor donates it — the same call the ADA path makes, and it never reaches the sender.
      if (!keepsSponsorChange) sponsorChange = 0n;

      const outputs = [
        paymentOutput,
        ...(collectsFee ? [feeCollectionOutput] : []),
        ...(keepsChange ? [encodeOutput(plan.changeAddress, change, residual)] : []),
        ...(keepsSponsorChange ? [sponsorChangeOutput] : [])
      ];
      const inputs = [...selected, ...sponsorSelected];
      const bodyFee = inputAda + sponsorTotal - attached - collected - change - sponsorChange;
      const body = encodeBody(inputs, outputs, bodyFee, ttlSlot);
      const size = signedSizeOf(body);
      if (size > parameters.maxTxSize) {
        throw new Error(`CARDANO_TX_TOO_LARGE: ${size} bytes over ${parameters.maxTxSize}`);
      }

      const required = feeForSize(size, parameters);
      if (required <= fee) {
        return {
          bodyBytes: body,
          transactionId: transactionIdOf(body),
          fee: bodyFee,
          sentLovelace: attached,
          change,
          changeAssets: residual,
          inputs,
          ttlSlot,
          feeCollected: collected
        };
      }
      fee = required;
    }

    // The fee loop ran out of passes without either settling or asking for more ADA. Each pass can
    // only raise the fee by a byte or two's worth, so more than a handful means the arithmetic is
    // wrong, not that the wallet is short.
    if (!needsMoreAda) throw new Error('CARDANO_FEE_DID_NOT_CONVERGE');
  }

  throw new Error(shortfall || 'CARDANO_INSUFFICIENT_FUNDS');
}

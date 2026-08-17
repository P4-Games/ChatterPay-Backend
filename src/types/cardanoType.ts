/**
 * Cardano domain types.
 *
 * Kept apart from the EVM types on purpose: nothing here has an equivalent on the other side.
 * There is no nonce, no gas price and no relayer — a transfer is a set of unspent outputs turned
 * into new unspent outputs, and these are the shapes that describes.
 */

/**
 * Which Cardano network something belongs to.
 *
 * Never defaulted anywhere: the network travels inside the address itself (CIP-19), so a defaulted
 * value is how a testnet address becomes a mainnet one that nobody can spend from.
 */
export type CardanoNetwork = 'mainnet' | 'testnet';

/**
 * A native asset, identified the only way Cardano identifies one.
 *
 * There is no contract address: an asset *is* the pair (minting policy, name). Two tokens with the
 * same ticker and different policies are different assets, and confusing them does not fail — it
 * moves something the user did not mean to move.
 */
export interface CardanoAsset {
  /** Minting policy hash, 28 bytes, hex without `0x`. */
  policyId: string;
  /** Asset name, 0–32 bytes, hex without `0x`. Empty string is a valid name. */
  assetName: string;
}

/** A native asset and how much of it. */
export interface CardanoAssetAmount extends CardanoAsset {
  /** Quantity, in the asset's own base unit. */
  quantity: bigint;
}

/**
 * The concatenated `policyId + assetName`, which is how providers name an asset on the wire.
 *
 * @param asset - The asset.
 * @returns The unit string, lowercase.
 */
export function assetUnit(asset: CardanoAsset): string {
  return `${asset.policyId}${asset.assetName}`.toLowerCase();
}

/** An unspent output an address controls, as a provider reports it. */
export interface CardanoUtxo {
  /** Hash of the transaction that created the output, hex without `0x`. */
  txHash: string;
  /** Index of the output inside that transaction. */
  outputIndex: number;
  /** ADA held, in lovelace. */
  lovelace: bigint;
  /**
   * Whether the output also holds native assets.
   *
   * Kept alongside {@link assets} because it answers the question an ADA-only transfer asks — "can
   * I ignore this?" — without walking a list. An ADA transfer never spends one of these, since
   * doing so would require carrying the tokens into the change output.
   */
  holdsOtherAssets: boolean;
  /**
   * The native assets this output holds. Empty or absent for a pure-ADA output.
   *
   * Populated only when the provider was asked for the detail. A token transfer needs it; an ADA
   * transfer does not, and asking for it costs a heavier provider response.
   */
  assets?: CardanoAssetAmount[];
  /**
   * Height of the block that created this output, when the provider reports one.
   *
   * Cardano puts no confirmation count on a UTxO, so this is what a depth threshold is resolved
   * against. Absent means the provider could not say, which is treated as "not deep enough" rather
   * than as "deep enough": the conservative reading is the only safe one when the question is
   * whether these funds can still disappear in a rollback.
   */
  blockHeight?: number;
}

/** The protocol parameters a transfer needs, read from the network rather than assumed. */
export interface CardanoProtocolParameters {
  /** Fee per byte of the serialized signed transaction. */
  minFeeA: number;
  /** Constant term of the fee. */
  minFeeB: number;
  /** Lovelace per byte of a UTxO, which is what sets the minimum an output may hold. */
  coinsPerUtxoByte: bigint;
  /** Ceiling on the serialized transaction size, in bytes. */
  maxTxSize: number;
}

/** What an address turned out to be, when it could be read at all. */
export interface DecodedCardanoAddress {
  /** The network the address belongs to, agreed between its prefix and its header byte. */
  network: CardanoNetwork;
  /**
   * High nibble of the header. `0` is the base address ChatterPay issues and the one every ordinary
   * wallet hands out; `1`–`3` are its script variants; `6` is an enterprise address, with no
   * staking part.
   */
  addressType: number;
  /** Hex of the payment credential: the 28 bytes right after the header, staking part excluded. */
  credentialHex: string;
  /**
   * Hex of the staking credential, for the address types that carry one (`0`–`3`). Absent for
   * enterprise addresses.
   *
   * Nothing in a transfer needs it — an output is paid to the whole address. It is read here for
   * what comes after: registering a stake key and delegating it both address the credential, not
   * the address.
   */
  stakeCredentialHex?: string;
  /**
   * The address exactly as it goes into a transaction output, header byte first. Decoded here
   * rather than re-derived by the transaction builder, so the bytes that get paid are the bytes
   * whose checksum was verified.
   */
  payload: Uint8Array;
}

/** A signature, as the signing boundary returns it. */
export interface CardanoVkeyWitness {
  /** Raw 32-byte Ed25519 public key, hex with or without `0x`. */
  publicKey: string;
  /** Raw 64-byte Ed25519 signature, hex with or without `0x`. */
  signature: string;
}

/** Everything a transaction build needs that does not come from the chain. */
export interface CardanoTransferPlan {
  /** Unspent outputs the sender holds. */
  utxos: readonly CardanoUtxo[];
  /** Raw bytes of the destination address, header included. */
  destinationAddress: Uint8Array;
  /** Raw bytes of the sender's address, where change goes. */
  changeAddress: Uint8Array;
  /**
   * Lovelace to send.
   *
   * For an ADA transfer this is the amount. For a native-asset transfer it is the ADA *attached* to
   * the token output — pass `0n` to let the builder attach the minimum the protocol requires, which
   * is what a user sending 30 USDM means.
   */
  amount: bigint;
  /**
   * The native asset being sent, when this is a token transfer.
   *
   * Absent for ADA. One asset per transfer: that is what the product asks for, and it keeps
   * selection tractable. The *change* may still carry several, because the inputs chosen to cover
   * this one may hold others.
   */
  asset?: CardanoAssetAmount;
  /** Slot after which the transaction expires. */
  ttlSlot: number;
  /** Protocol parameters in force. */
  parameters: CardanoProtocolParameters;
  /** How many keys will sign. Decides the witness bytes the fee is charged for. */
  witnessCount: number;
}

/** A transfer, built and ready to be signed. */
export interface BuiltCardanoTransaction {
  /** Serialized `transaction_body`: the bytes the signature is made over. */
  bodyBytes: Uint8Array;
  /** blake2b-256 of {@link bodyBytes}: the transaction id, hex without `0x`. */
  transactionId: string;
  /** Fee this transaction pays, in lovelace. Exact, not an estimate. */
  fee: bigint;
  /**
   * Lovelace that actually leaves for the destination.
   *
   * Equal to the requested amount on an ADA transfer. On a token transfer it is the ADA attached to
   * the token output — money that really leaves the sender and arrives at the recipient, so the
   * reconciliation invariant is stated against this and never against "what was asked for".
   */
  sentLovelace: bigint;
  /** Change returned to the sender, in lovelace. Zero when there is no change output. */
  change: bigint;
  /**
   * Native assets returned to the sender in the change output.
   *
   * Whatever the selected inputs held minus what was sent. Unlike dust ADA, residual tokens can
   * never be dropped into the fee: a transaction that does not return them does not balance, and
   * the ledger rejects it.
   */
  changeAssets: readonly CardanoAssetAmount[];
  /** The outputs selected as inputs, in the order they appear in the body. */
  inputs: readonly CardanoUtxo[];
  /** Slot after which the network stops accepting this transaction. */
  ttlSlot: number;
}

/** A wallet's Cardano identity: the address, its raw bytes, and the key behind it. */
export interface CardanoAccount {
  /** The bech32 address, `addr_test1…` on testnet and `addr1…` on mainnet. */
  address: string;
  /** The address as it goes into a transaction output, header byte first. */
  addressBytes: Uint8Array;
  /** Raw 32-byte Ed25519 payment public key, hex with `0x`. This is the one that signs. */
  publicKey: string;
  /**
   * Raw 32-byte Ed25519 staking public key, hex with `0x`.
   *
   * Present in every address this deployment issues, and registered in none of them. It signs
   * nothing today: a transfer is authorised by the payment key alone. It exists so that delegating
   * later is a certificate rather than a new address.
   */
  stakePublicKey: string;
}

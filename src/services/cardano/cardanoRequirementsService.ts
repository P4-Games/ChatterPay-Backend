/**
 * What a wallet needs before a Cardano transfer can be built at all.
 *
 * The answer is not "the amount". Cardano puts a floor under every output (min-ADA), charges its fee
 * from the transaction's own inputs, and refuses a transaction whose change would fall below that
 * same floor. So a wallet holding exactly the amount cannot send it, and a wallet holding slightly
 * more than the amount can end up burning the remainder as fee.
 *
 * This is computed **before the operation lock is taken**, so a wallet that cannot pay is told why
 * while it can still do something about it, instead of being told after the lock, the notification
 * and the optimistic answer have already gone out.
 *
 * @see __to_deploy__/opciones-fees-cardano.md
 */

import { getCardanoFeeConfig } from '../../config/cardanoFeeConfig';
import type {
  CardanoAssetAmount,
  CardanoProtocolParameters,
  CardanoUtxo
} from '../../types/cardanoType';
import { minimumAdaFor, spendableBalance, totalAssets } from './cardanoTxService';

/** A fee estimate good enough to validate against, in lovelace. */
const FEE_ESTIMATE = 200_000n;

/** What the wallet must hold, and whether it does. */
export interface CardanoRequirement {
  /** Whether the transfer can be built with what the wallet holds. */
  ok: boolean;
  /** Lovelace the wallet must hold for this transfer. */
  requiredLovelace: bigint;
  /** Lovelace the wallet actually holds. */
  heldLovelace: bigint;
  /** A message for the user, empty when `ok`. */
  message: string;
}

/** Lovelace as a human-readable ADA figure. */
function ada(lovelace: bigint): string {
  return (Number(lovelace) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * What an ADA transfer needs.
 *
 * @param amountLovelace - Amount the user asked to send.
 * @param utxos - Everything the sender holds.
 * @param addressBytes - The sender's address, used to price the change output.
 * @param parameters - Protocol parameters, read from the chain.
 * @param sponsored - Whether ChatterPay covers the network fee. Taken as a parameter rather than
 *   read here so the three fee models can be exercised without reaching for the environment.
 * @returns The requirement, with a message naming the exact figures when it cannot be met.
 */
export function adaTransferRequirement(
  amountLovelace: bigint,
  utxos: readonly CardanoUtxo[],
  addressBytes: Uint8Array,
  parameters: CardanoProtocolParameters,
  sponsored: boolean = getCardanoFeeConfig().sponsorNetworkFee
): CardanoRequirement {
  const held = spendableBalance(utxos);
  const minOutput = minimumAdaFor(addressBytes, [], parameters.coinsPerUtxoByte);
  const sponsorNetworkFee = sponsored;
  const fee = sponsorNetworkFee ? 0n : FEE_ESTIMATE;

  if (amountLovelace < minOutput) {
    return {
      ok: false,
      requiredLovelace: minOutput,
      heldLovelace: held,
      message:
        `El mínimo que se puede enviar en Cardano es ${ada(minOutput)} ADA. ` +
        `Es un límite de la red, no de ChatterPay: un envío menor hace fallar la transacción entera.`
    };
  }

  const required = amountLovelace + fee;
  if (held < required) {
    return {
      ok: false,
      requiredLovelace: required,
      heldLovelace: held,
      message:
        `No te alcanza el saldo. Para enviar ${ada(amountLovelace)} ADA necesitás ` +
        `${ada(required)} ADA en tu wallet${sponsorNetworkFee ? '' : ' (incluye el costo de red)'} ` +
        `y tenés ${ada(held)} ADA.`
    };
  }

  // The dust window: what is left would be too small to be its own UTxO, so the network absorbs it
  // as fee. The user does not lose the transfer, they lose the remainder — which is worse, because
  // it succeeds and they only notice afterwards.
  const change = held - required;
  if (change > 0n && change < minOutput) {
    const maxKeepingChange = held - fee - minOutput;
    return {
      ok: false,
      requiredLovelace: required,
      heldLovelace: held,
      message:
        `Con ${ada(held)} ADA podés enviar hasta ${ada(maxKeepingChange)} ADA, o enviar todo ` +
        `(${ada(held - fee)} ADA). Entre esos dos valores el vuelto queda por debajo del mínimo ` +
        `que exige la red (${ada(minOutput)} ADA) y se pierde.`
    };
  }

  return { ok: true, requiredLovelace: required, heldLovelace: held, message: '' };
}

/**
 * What a native-asset transfer needs, in ADA.
 *
 * A token never travels alone: the output carrying it must hold min-ADA, which the sender provides
 * and the recipient keeps. And when the sender keeps part of the token, their own change carries
 * the remainder and needs min-ADA too — **the floor is paid twice**.
 *
 * @param asset - The asset and quantity being sent.
 * @param utxos - Everything the sender holds.
 * @param addressBytes - The sender's address.
 * @param parameters - Protocol parameters.
 * @param sponsored - Whether ChatterPay covers the network fee and the ADA the token drags along.
 * @returns The requirement, in lovelace, ignoring whether the token balance itself suffices — that
 *   is checked separately and reported in the token's own units.
 */
export function tokenTransferRequirement(
  asset: CardanoAssetAmount,
  utxos: readonly CardanoUtxo[],
  addressBytes: Uint8Array,
  parameters: CardanoProtocolParameters,
  sponsored: boolean = getCardanoFeeConfig().sponsorNetworkFee
): CardanoRequirement {
  const held = utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
  const sponsorNetworkFee = sponsored;
  const fee = sponsorNetworkFee ? 0n : FEE_ESTIMATE;

  const attached = minimumAdaFor(addressBytes, [asset], parameters.coinsPerUtxoByte);

  // Does the sender keep any of this asset? If so their change output carries it and needs its own
  // min-ADA.
  const heldOfAsset =
    totalAssets(utxos).find(
      (held_) => held_.policyId === asset.policyId && held_.assetName === asset.assetName
    )?.quantity ?? 0n;
  const keepsSome = heldOfAsset > asset.quantity;
  const changeFloor = keepsSome
    ? minimumAdaFor(addressBytes, [{ ...asset, quantity: heldOfAsset - asset.quantity }], parameters.coinsPerUtxoByte)
    : 0n;

  const required = sponsorNetworkFee ? 0n : attached + changeFloor + fee;

  if (held < required) {
    return {
      ok: false,
      requiredLovelace: required,
      heldLovelace: held,
      message:
        `Para enviar un token de Cardano también necesitás ADA: la red exige que el envío lleve ` +
        `${ada(attached)} ADA adjunta${keepsSome ? `, y otro tanto para el vuelto que conserva el resto del token` : ''}. ` +
        `Necesitás ${ada(required)} ADA en tu wallet y tenés ${ada(held)} ADA.`
    };
  }

  return { ok: true, requiredLovelace: required, heldLovelace: held, message: '' };
}

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
 */

import { getCardanoFeeConfig } from '../../config/cardanoFeeConfig';
import type {
  CardanoAssetAmount,
  CardanoProtocolParameters,
  CardanoUtxo
} from '../../types/cardanoType';
import { minimumAdaFor, selectableBalance, selectionFor, totalAssets } from './cardanoTxService';

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
 * @param chatterPayFee - ChatterPay's fee in lovelace, which comes out of the amount. It raises the
 *   smallest transfer that can work — what reaches the destination is the amount less this, and
 *   that is the figure the ledger's floor applies to.
 * @returns The requirement, with a message naming the exact figures when it cannot be met.
 */
export function adaTransferRequirement(
  amountLovelace: bigint,
  utxos: readonly CardanoUtxo[],
  addressBytes: Uint8Array,
  parameters: CardanoProtocolParameters,
  sponsored: boolean = getCardanoFeeConfig().sponsorNetworkFee,
  chatterPayFee: bigint = 0n
): CardanoRequirement {
  const held = selectableBalance(utxos);
  const minOutput = minimumAdaFor(addressBytes, [], parameters.coinsPerUtxoByte);
  const sponsorNetworkFee = sponsored;
  const fee = sponsorNetworkFee ? 0n : FEE_ESTIMATE;

  // The floor applies to what arrives, and what arrives is the amount less ChatterPay's fee — so
  // the smallest transfer that works is the floor plus that fee, not the floor.
  const smallestSendable = minOutput + chatterPayFee;
  if (amountLovelace < smallestSendable) {
    return {
      ok: false,
      requiredLovelace: smallestSendable,
      heldLovelace: held,
      message:
        `The minimum you can send on Cardano is ${ada(smallestSendable)} ADA. ` +
        `${ada(minOutput)} of it is a network limit, not a ChatterPay one: below that, the ` +
        `transfer fails the whole transaction.`
    };
  }

  const required = amountLovelace + fee;
  if (held < required) {
    return {
      ok: false,
      requiredLovelace: required,
      heldLovelace: held,
      message:
        `Not enough balance. To send ${ada(amountLovelace)} ADA you need ` +
        `${ada(required)} ADA in your wallet${sponsorNetworkFee ? '' : ' (network cost included)'} ` +
        `and you have ${ada(held)} ADA.`
    };
  }

  // The dust window: what is left would be too small to be its own UTxO, so the network absorbs it
  // as fee. The user does not lose the transfer, they lose the remainder — which is worse, because
  // it succeeds and they only notice afterwards.
  //
  // Measured against what coin selection will actually gather, not against the balance. Selection
  // stops as soon as it covers the target, so a wallet holding ten spendable outputs may well hand
  // the builder one of them — and the change that gets burned is that one output's remainder, not
  // the wallet's. Checking the balance here is why this window went undetected.
  //
  // And priced against what that selection *carries*: an output pulled in for its ADA may hold
  // tokens as well, and those tokens have to come home in the change output, which puts its floor
  // above the plain one.
  const selection = selectionFor(utxos, required);
  const gathered = selection ? selection.reduce((sum, utxo) => sum + utxo.lovelace, 0n) : held;
  const carried = selection ? totalAssets(selection) : [];
  const changeFloor = minimumAdaFor(addressBytes, carried, parameters.coinsPerUtxoByte);
  const change = gathered - required;

  // Tokens in the selection make the change output mandatory — they have nowhere else to go — so
  // the "or send it all" escape below does not exist here: that floor stays behind, always.
  if (carried.length > 0 && change < changeFloor) {
    return {
      ok: false,
      requiredLovelace: required,
      heldLovelace: held,
      message:
        `With ${ada(held)} ADA you can send up to ${ada(gathered - fee - changeFloor)} ADA. ` +
        `The rest has to stay in your wallet: it holds tokens, and the ${ada(changeFloor)} ADA ` +
        `that carries them cannot leave with the transfer.`
    };
  }

  if (change > 0n && change < changeFloor) {
    const maxKeepingChange = gathered - fee - changeFloor;
    return {
      ok: false,
      requiredLovelace: required,
      heldLovelace: held,
      message:
        `With ${ada(held)} ADA you can send up to ${ada(maxKeepingChange)} ADA, or send it all ` +
        `(${ada(held - fee)} ADA). Between those two figures the change falls below the minimum ` +
        `the network requires (${ada(changeFloor)} ADA) and is lost.`
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
 * @param sponsored - Whether ChatterPay covers the network fee. It does not cover the ADA the
 *   token drags along: that ADA is the sender's value moving to the recipient, not a fee.
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
    ? minimumAdaFor(
        addressBytes,
        [{ ...asset, quantity: heldOfAsset - asset.quantity }],
        parameters.coinsPerUtxoByte
      )
    : 0n;

  // Sponsoring covers the *network fee*, and nothing else. The ADA attached to the token output is
  // not a fee: it is value that leaves the sender and arrives at the recipient, and a sponsor that
  // supplied it would be giving away roughly 1.2 ADA on every token transfer to buy a fee worth a
  // few cents. So the sender owes it whether or not the fee is sponsored — and reporting `0` here,
  // as this did, told a wallet with no ADA that it could send a token and then let the builder
  // refuse it after the operation had already been announced.
  const required = attached + changeFloor + fee;

  if (held < required) {
    return {
      ok: false,
      requiredLovelace: required,
      heldLovelace: held,
      message:
        `Sending a Cardano token also takes ADA: the network requires the transfer to carry ` +
        `${ada(attached)} ADA attached${keepsSome ? `, and as much again for the change that keeps the rest of the token` : ''}` +
        `${sponsorNetworkFee ? ' (ChatterPay covers the network cost)' : ' (plus the network cost)'}. ` +
        `You need ${ada(required)} ADA in your wallet and you have ${ada(held)} ADA.`
    };
  }

  return { ok: true, requiredLovelace: required, heldLovelace: held, message: '' };
}

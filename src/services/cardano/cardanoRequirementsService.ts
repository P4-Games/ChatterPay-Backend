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
 * What this module does **not** do is write the sentence. It answers with a reason and the figures
 * that reason names; the words come from the notification template in the user's own language, the
 * same way the EVM path renders its limits. A number formatted here is a number, not a message.
 */

import { getCardanoFeeConfig } from '../../config/cardanoFeeConfig';
import type {
  CardanoAssetAmount,
  CardanoProtocolParameters,
  CardanoRefusal,
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
  /** Why the transfer cannot be built, ready to be put into words. Null when `ok`. */
  refusal: CardanoRefusal | null;
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
  chatterPayFee: bigint = 0n,
  routesDust: boolean = getCardanoFeeConfig().routeDustToSponsor
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
      refusal: {
        reason: 'amount_below_minimum',
        params: { '[MIN_AMOUNT]': ada(smallestSendable), '[NETWORK_MIN]': ada(minOutput) }
      }
    };
  }

  const required = amountLovelace + fee;
  if (held < required) {
    return {
      ok: false,
      requiredLovelace: required,
      heldLovelace: held,
      // `[REQUIRED]` already carries the network cost when there is one to carry, so the sentence
      // does not have to say whether it did: the figure is the figure either way.
      refusal: {
        reason: 'insufficient_ada',
        params: {
          '[AMOUNT]': ada(amountLovelace),
          '[REQUIRED]': ada(required),
          '[HELD]': ada(held)
        }
      }
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
      refusal: {
        reason: 'change_carries_tokens',
        params: {
          '[HELD]': ada(held),
          '[MAX_AMOUNT]': ada(gathered - fee - changeFloor),
          '[CHANGE_FLOOR]': ada(changeFloor)
        }
      }
    };
  }

  // With routing on, a remainder below the floor is no longer a reason to refuse: it rides home in
  // the sponsor's change and is credited back. The check above stays, because a remainder carrying
  // tokens can never be routed.
  if (routesDust) {
    return { ok: true, requiredLovelace: required, heldLovelace: held, refusal: null };
  }

  if (change > 0n && change < changeFloor) {
    const maxKeepingChange = gathered - fee - changeFloor;
    return {
      ok: false,
      requiredLovelace: required,
      heldLovelace: held,
      refusal: {
        reason: 'change_below_floor',
        params: {
          '[HELD]': ada(held),
          '[MAX_AMOUNT]': ada(maxKeepingChange),
          '[ALL_AMOUNT]': ada(held - fee),
          '[CHANGE_FLOOR]': ada(changeFloor)
        }
      }
    };
  }

  return { ok: true, requiredLovelace: required, heldLovelace: held, refusal: null };
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
  sponsored: boolean = getCardanoFeeConfig().sponsorNetworkFee,
  sponsorsMinAda: boolean = getCardanoFeeConfig().sponsorMinAda
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

  // Under scheme 1 the sender owes the ADA attached to the token output. It is not a fee: it is
  // value that leaves them and arrives at the recipient, and a sponsor supplying it would be giving
  // away roughly 1.2 ADA on every token transfer to buy a fee worth a few cents.
  //
  // Under scheme 2 the sponsor does supply it, so that part drops off. **What does not drop off is
  // the floor of the sender's own change**, and answering a flat zero here was wrong: when the
  // sender keeps part of the token, their change carries it and needs a floor priced against
  // *their* address, while the ADA their UTxO came with was priced against whoever funded it. The
  // two are not the same number, and where the wallet fell between them the preflight said yes and
  // the builder then refused — after the lock, after the user had been told it was under way.
  const required = (sponsorsMinAda ? 0n : attached) + changeFloor + fee;

  if (held < required) {
    return {
      ok: false,
      requiredLovelace: required,
      heldLovelace: held,
      // Two different problems, and the remedy differs: under scheme 2 the wallet is only short of
      // the floor its *own* change needs, and sending the whole balance sidesteps it entirely.
      refusal: sponsorsMinAda
        ? {
            reason: 'token_change_needs_ada',
            params: { '[CHANGE_FLOOR]': ada(changeFloor), '[HELD]': ada(held) }
          }
        : {
            // Keeping part of the token roughly doubles the figure, and a sentence that does not
            // say why reads as an arbitrary number.
            reason: keepsSome ? 'token_needs_ada_keeping_rest' : 'token_needs_ada',
            params: {
              '[ATTACHED]': ada(attached),
              '[REQUIRED]': ada(required),
              '[HELD]': ada(held)
            }
          }
    };
  }

  return { ok: true, requiredLovelace: required, heldLovelace: held, refusal: null };
}

/**
 * The check that runs before the operation lock is taken.
 *
 * Everything the transfer path validates about *policy* — daily limits, per-amount limits, the
 * security gate — happens before the lock already. What did not was the one thing the chain
 * decides: whether the wallet holds enough for the transaction to exist at all. That was discovered
 * inside the transfer, after the lock had been opened, the notification sent and the optimistic
 * answer returned — so a user with 1 ADA was told the operation was in progress and then, seconds
 * later, that it failed.
 *
 * This asks the provider once and answers the same question first, while the user can still act on
 * it.
 */

import { getCardanoConfig } from '../../config/cardanoConfig';
import { getCardanoFeeConfig } from '../../config/cardanoFeeConfig';
import { Logger } from '../../helpers/loggerHelper';
import type { CardanoAssetAmount } from '../../types/cardanoType';
import { decodeCardanoAddress } from './cardanoAddressService';
import { buildCardanoProvider } from './cardanoProviderService';
import {
  adaTransferRequirement,
  type CardanoRequirement,
  tokenTransferRequirement
} from './cardanoRequirementsService';
import { cardanoSignerService } from './cardanoSignerService';
import { SPONSOR_UNAVAILABLE } from './cardanoTransferService';
import { assetBalance, spendableBalance } from './cardanoTxService';

/** Amount, in the asset's own base units. */
function toBaseUnits(amount: string, decimals: number): bigint {
  const [whole, fraction = ''] = amount.trim().split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

/** What a preflight check concluded. */
export interface CardanoPreflight extends CardanoRequirement {
  /** Whether the check ran at all. A provider failure yields `true` — see below. */
  checked: boolean;
}

/**
 * Whether the sender can afford this transfer.
 *
 * @param address - The sender's bech32 address.
 * @param amount - Amount as the user typed it, in the asset's display units.
 * @param decimals - Decimals of the asset.
 * @param asset - The native asset, or undefined for ADA.
 * @param chatterPayFee - ChatterPay's fee in the asset's base units, which comes out of the amount.
 *   Priced by the caller, which is the layer that knows the ticker.
 * @returns The verdict. **A provider failure passes the check** rather than blocking the transfer:
 *   the authoritative validation still runs inside the transfer, before any signature, so a
 *   provider hiccup here must not turn into a refusal to move money that the wallet can afford.
 */
export async function canAffordCardanoTransfer(
  address: string,
  amount: string,
  decimals: number,
  asset?: Omit<CardanoAssetAmount, 'quantity'>,
  chatterPayFee: bigint = 0n
): Promise<CardanoPreflight> {
  const pass: CardanoPreflight = {
    checked: false,
    ok: true,
    requiredLovelace: 0n,
    heldLovelace: 0n,
    message: ''
  };

  const decoded = decodeCardanoAddress(address);
  if (!decoded) return pass;

  try {
    const provider = buildCardanoProvider();
    const [utxos, parameters] = await Promise.all([
      provider.utxosFor(address),
      provider.protocolParameters()
    ]);

    if (!asset) {
      const quantity = toBaseUnits(amount, decimals);
      return {
        checked: true,
        ...adaTransferRequirement(
          quantity,
          utxos,
          decoded.payload,
          parameters,
          undefined,
          chatterPayFee
        )
      };
    }

    const quantity = toBaseUnits(amount, decimals);
    const held = assetBalance(utxos, asset);
    if (held < quantity) {
      // Reported in the asset's own units: telling someone they are short of lovelace when they
      // asked to send USDC is an answer to a question nobody asked.
      const scale = 10 ** decimals;
      return {
        checked: true,
        ok: false,
        requiredLovelace: 0n,
        heldLovelace: 0n,
        message:
          `Not enough balance: you have ${(Number(held) / scale).toFixed(2)} and you are ` +
          `trying to send ${(Number(quantity) / scale).toFixed(2)}.`
      };
    }

    // The fee comes out of the quantity, so a quantity at or below it leaves the destination
    // nothing and the builder refuses with `CARDANO_INVALID_FEE`. Asked here rather than there:
    // that refusal arrives after the lock is taken and the user has been told the transfer is
    // under way, and it matters more under scheme 2, where the fee is several times larger.
    if (chatterPayFee > 0n && quantity <= chatterPayFee) {
      const scale = 10 ** decimals;
      const smallest = (Number(chatterPayFee) / scale).toFixed(decimals > 4 ? 4 : decimals);
      return {
        checked: true,
        ok: false,
        requiredLovelace: 0n,
        heldLovelace: 0n,
        message:
          `The amount has to be more than the ${smallest} fee for this transfer, ` +
          `otherwise nothing would reach the destination.`
      };
    }

    return {
      checked: true,
      ...tokenTransferRequirement({ ...asset, quantity }, utxos, decoded.payload, parameters)
    };
  } catch (error) {
    Logger.warn(
      'canAffordCardanoTransfer',
      `Preflight skipped for ${address}: ${String(error)}. The transfer will validate it itself.`
    );
    return pass;
  }
}

/** What a sponsor check concluded. */
export interface CardanoSponsorPreflight {
  /** Whether the transfer may go ahead. */
  ok: boolean;
  /** What to tell the user when it may not. Empty when it may. */
  message: string;
}

/**
 * Whether the fee sponsor can still cover a transfer.
 *
 * Asked here for the same reason the sender's balance is: an empty sponsor wallet used to surface
 * inside the transfer, after the lock was open and the user had been told the operation was in
 * progress — and since nothing about it is theirs to fix, the failure read as silence.
 *
 * The message names nothing: the wallet is the product's, and handing every user its address along
 * with the news that it is empty is an operational detail that belongs in the log.
 *
 * @param logKey - Correlation key for the logs.
 * @returns `ok: false` only when sponsoring is on and the sponsor wallet holds nothing spendable.
 *   Sponsoring turned off passes, and so does a provider that could not be reached: the transfer
 *   checks it again before signing, so a hiccup here must not refuse a transfer that would work.
 */
export async function sponsorCanCoverFee(logKey: string): Promise<CardanoSponsorPreflight> {
  const pass: CardanoSponsorPreflight = { ok: true, message: '' };

  const feeConfig = getCardanoFeeConfig();
  if (!feeConfig.sponsorNetworkFee) return pass;

  const config = getCardanoConfig();
  try {
    const sponsor = cardanoSignerService.getSponsorAccount(
      feeConfig.sponsorWalletId,
      config.network,
      config.chainId
    );
    // Every output, confirmed or not, which is the same set the transfer itself will spend from --
    // see the note in `cardanoTransferService`. A preflight that counted a different set than the
    // transfer would answer a different question than the one being asked, and the direction of the
    // mismatch matters: demanding confirmations here would refuse transfers the transfer path would
    // have gone on to complete.
    const utxos = await buildCardanoProvider().utxosFor(sponsor.address);
    if (spendableBalance(utxos) > 0n) return pass;

    Logger.error(
      'sponsorCanCoverFee',
      logKey,
      `CARDANO_SPONSOR_WALLET_EMPTY: ${sponsor.address} holds no spendable ADA`
    );
    return { ok: false, message: SPONSOR_UNAVAILABLE };
  } catch (error) {
    Logger.warn(
      'sponsorCanCoverFee',
      logKey,
      `Sponsor preflight skipped: ${String(error)}. The transfer will validate it itself.`
    );
    return pass;
  }
}

/** The Cardano network this deployment operates on, for callers that need it alongside the check. */
export function preflightNetwork(): string {
  return getCardanoConfig().network;
}

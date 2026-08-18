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
 *
 * @see __to_deploy__/opciones-fees-cardano.md
 */

import { getCardanoConfig } from '../../config/cardanoConfig';
import { Logger } from '../../helpers/loggerHelper';
import type { CardanoAssetAmount } from '../../types/cardanoType';
import { decodeCardanoAddress } from './cardanoAddressService';
import { buildCardanoProvider } from './cardanoProviderService';
import {
  adaTransferRequirement,
  type CardanoRequirement,
  tokenTransferRequirement
} from './cardanoRequirementsService';
import { assetBalance } from './cardanoTxService';

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
 * @returns The verdict. **A provider failure passes the check** rather than blocking the transfer:
 *   the authoritative validation still runs inside the transfer, before any signature, so a
 *   provider hiccup here must not turn into a refusal to move money that the wallet can afford.
 */
export async function canAffordCardanoTransfer(
  address: string,
  amount: string,
  decimals: number,
  asset?: Omit<CardanoAssetAmount, 'quantity'>
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
        ...adaTransferRequirement(quantity, utxos, decoded.payload, parameters)
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
          `No te alcanza el saldo: tenés ${(Number(held) / scale).toFixed(2)} y ` +
          `querés enviar ${(Number(quantity) / scale).toFixed(2)}.`
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

/** The Cardano network this deployment operates on, for callers that need it alongside the check. */
export function preflightNetwork(): string {
  return getCardanoConfig().network;
}

/**
 * Reads the environment into the shapes the rest of the code wants.
 *
 * `constants.ts` is the only module that touches the environment, and what it exposes is what the
 * environment literally holds: strings. Turning those into the answers a subsystem needs — a number
 * that is usable, a label that decodes, a whole configuration — is work, and work does not belong
 * in a list of constants.
 */

import {
  $S,
  CARDANO_CHAIN_ID,
  CARDANO_DEPOSIT_CONFIRMATIONS,
  CARDANO_ENABLED,
  CARDANO_EXPLORER_URL,
  CARDANO_FEE_SCHEME,
  CARDANO_NETWORK,
  CARDANO_PROVIDER_TIMEOUT_MS,
  CARDANO_PROVIDER_URL,
  CARDANO_RECYCLE_DESTINATION_UTXO,
  CARDANO_ROUTE_DUST_TO_SPONSOR,
  CARDANO_SPONSOR_FEES,
  CARDANO_SPONSOR_WALLET_ID,
  CARDANO_TRANSFER_FEE_ADA,
  CARDANO_TRANSFER_FEE_ADA_NEW_OUTPUT,
  CARDANO_TRANSFER_FEE_USD,
  CARDANO_TTL_SLOTS,
  CDC1,
  CDC2,
  CDC3,
  CDC4,
  CDC5,
  CDC6,
  NODE_ENV
} from '../config/constants';
import type { CardanoEnv, CardanoFeeEnv } from '../types/cardanoType';

/** Whether the process is running the test suite. */
export const isTestRun = (): boolean => NODE_ENV.trim().toLowerCase() === 'test';

/**
 * Reads a hex-encoded configuration value.
 *
 * `Buffer.from` is not a validator: it answers an empty string for `''` and for anything that is
 * not hex, and silently drops a trailing nibble on an odd-length input. A value read this way ends
 * up inside a derivation, where "quietly empty" is the worst of the three possible outcomes — so
 * anything that is not a whole number of hex bytes is refused here.
 *
 * The error carries no value, only the fact that one is unusable.
 *
 * @param value - The configured value.
 * @returns The decoded string.
 * @throws Error `CONFIG_HEX_INVALID` when the value is absent, empty or not whole hex bytes.
 */
export function $hx(value: string | undefined): string {
  if (!value || !/^(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error('CONFIG_HEX_INVALID');
  return Buffer.from(value, 'hex').toString();
}

/** A positive integer, or `null` when the value is absent or unusable. */
function positiveIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * A number that is zero or more, or `null` when absent or unusable.
 *
 * Negative is refused rather than accepted: a negative fee would pay the user.
 */
function nonNegativeNumberOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Whether every label the Cardano derivation needs is present and readable.
 *
 * Checked as a whole rather than one at a time because the answer is only ever used to decide
 * whether the family may run at all: with any of them unusable, the addresses this deployment
 * issues are not the ones it issued yesterday.
 *
 * @returns `true` when all of them decode.
 */
export function cardanoLabelsReadable(): boolean {
  try {
    [CDC1, CDC2, CDC3, CDC4, CDC5, CDC6].forEach((value) => $hx(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the Cardano settings.
 *
 * @returns The settings, validated but not defaulted.
 */
export function readCardanoEnv(): CardanoEnv {
  return {
    enabled: CARDANO_ENABLED.trim().toLowerCase() === 'true',
    network: CARDANO_NETWORK.trim(),
    chainId: positiveIntOrNull(CARDANO_CHAIN_ID),
    providerUrl: CARDANO_PROVIDER_URL.trim(),
    providerTimeoutMs: positiveIntOrNull(CARDANO_PROVIDER_TIMEOUT_MS),
    ttlSlots: positiveIntOrNull(CARDANO_TTL_SLOTS),
    depositConfirmations: positiveIntOrNull(CARDANO_DEPOSIT_CONFIRMATIONS),
    explorerUrl: CARDANO_EXPLORER_URL.trim(),
    hasSecret: Boolean($S),
    labelsReadable: cardanoLabelsReadable()
  };
}

/**
 * Reads the Cardano fee settings.
 *
 * @returns The settings, validated but not defaulted.
 */
export function readCardanoFeeEnv(): CardanoFeeEnv {
  return {
    sponsorFees: CARDANO_SPONSOR_FEES.trim().toLowerCase() === 'true',
    transferFeeUsd: nonNegativeNumberOrNull(CARDANO_TRANSFER_FEE_USD),
    transferFeeAda: nonNegativeNumberOrNull(CARDANO_TRANSFER_FEE_ADA),
    transferFeeAdaNewOutput: nonNegativeNumberOrNull(CARDANO_TRANSFER_FEE_ADA_NEW_OUTPUT),
    feeScheme: nonNegativeNumberOrNull(CARDANO_FEE_SCHEME),
    recycleDestinationUtxo: CARDANO_RECYCLE_DESTINATION_UTXO.trim().toLowerCase() === 'true',
    routeDustToSponsor: CARDANO_ROUTE_DUST_TO_SPONSOR.trim().toLowerCase() === 'true',
    sponsorWalletId: CARDANO_SPONSOR_WALLET_ID.trim()
  };
}

/**
 * Who pays what on a Cardano transfer.
 *
 * Cardano has no paymaster contract and no way to pay a fee in anything other than ADA, so the
 * question "how much does the user need in their wallet before they can move anything" has a
 * different answer depending on two independent decisions:
 *
 *   - does ChatterPay cover the network fee?
 *   - does ChatterPay charge a fee of its own?
 *
 * They are modelled as two settings rather than as one enum of named plans, because they are
 * genuinely independent and every combination is meaningful:
 *
 * | `CARDANO_SPONSOR_FEES` | `CARDANO_TRANSFER_FEE_USD` | resultado                          |
 * |---|---|---|
 * | false | 0    | el usuario paga la red, no se le cobra nada                     |
 * | false | 0.08 | el usuario paga la red; sin sponsor no se le cobra fee           |
 * | true  | 0.08 | ChatterPay paga la red y le descuenta el fee del monto enviado   |
 * | true  | 0    | ChatterPay paga la red y no cobra nada                          |
 *
 * The settings themselves are read by `constants.ts`, the only module that touches the environment.
 * What is left here is the decision the two of them add up to.
 */

import { readCardanoFeeEnv } from '../helpers/envHelper';
import type { CardanoFeeConfig, CardanoSponsorDisabledReason } from '../types/cardanoType';

/** ChatterPay's fee per transfer when the setting holds nothing usable: it charges nothing. */
const DEFAULT_TRANSFER_FEE_USD = 0;

/**
 * Resolves who pays what, from the environment.
 *
 * @returns The configuration. Sponsoring reports itself off, with a reason, when it is switched on
 *   without the wallet it needs — the same posture as the family flag: half-configured is off.
 */
export function getCardanoFeeConfig(): CardanoFeeConfig {
  const env = readCardanoFeeEnv();

  const disabledReason: CardanoSponsorDisabledReason =
    env.sponsorFees && env.sponsorWalletId === '' ? 'sponsor_wallet_missing' : '';

  return {
    sponsorNetworkFee: env.sponsorFees && disabledReason === '',
    transferFeeUsd: env.transferFeeUsd ?? DEFAULT_TRANSFER_FEE_USD,
    sponsorWalletId: env.sponsorWalletId,
    disabledReason
  };
}

/**
 * Whether ChatterPay charges anything for a Cardano transfer.
 *
 * Charging also needs a sponsor: the fee rides in the sponsor's change output, and without one
 * there is no output to ride in. The transfer path checks both.
 */
export function chargesTransferFee(config: CardanoFeeConfig): boolean {
  return config.transferFeeUsd > 0;
}

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
 * | false | 0.08 | el usuario paga la red y además debe el fee de ChatterPay       |
 * | true  | 0.08 | ChatterPay paga la red y le cobra el fee                        |
 * | true  | 0    | ChatterPay paga la red y no cobra nada                          |
 *
 * @see __to_deploy__/opciones-fees-cardano.md
 */

/** ChatterPay's fee cannot be a Cardano output of its own: it is below the ledger's min-ADA. */
export interface CardanoFeeConfig {
  /** Whether ChatterPay supplies an input to cover the network fee. */
  sponsorNetworkFee: boolean;
  /** ChatterPay's fee per transfer, in USD. Zero disables charging entirely. */
  transferFeeUsd: number;
  /**
   * Identifier the sponsor wallet derives from, when sponsoring is on.
   *
   * Derived like any other wallet rather than configured as a private key: the same master secret
   * produces it, so there is no second secret to distribute, rotate or leak.
   */
  sponsorWalletId: string;
  /** Why sponsoring is off, when it is configured on but unusable. Empty when nothing is wrong. */
  disabledReason: string;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  return raw === 'true';
}

function moneyFromEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  // A negative or unreadable fee is a configuration mistake, and charging a negative fee would pay
  // the user. Falls back rather than trusting it.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Resolves who pays what, from the environment.
 *
 * @returns The configuration. Sponsoring reports itself off, with a reason, when it is switched on
 *   without the wallet it needs — the same posture as the family flag: half-configured is off.
 */
export function getCardanoFeeConfig(): CardanoFeeConfig {
  const sponsorRequested = boolFromEnv('CARDANO_SPONSOR_FEES', false);
  const sponsorWalletId = (process.env.CARDANO_SPONSOR_WALLET_ID ?? '').trim();

  const disabledReason = !sponsorRequested
    ? ''
    : sponsorWalletId === ''
      ? 'CARDANO_SPONSOR_WALLET_ID is empty'
      : '';

  return {
    sponsorNetworkFee: sponsorRequested && disabledReason === '',
    transferFeeUsd: moneyFromEnv('CARDANO_TRANSFER_FEE_USD', 0),
    sponsorWalletId,
    disabledReason
  };
}

/** Whether ChatterPay charges anything for a Cardano transfer. */
export function chargesTransferFee(config: CardanoFeeConfig): boolean {
  return config.transferFeeUsd > 0;
}

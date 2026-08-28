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
 * | `CARDANO_SPONSOR_FEES` | `CARDANO_TRANSFER_FEE_USD` | result                             |
 * |---|---|---|
 * | false | 0    | the user pays the network, nothing is charged on top            |
 * | false | 0.08 | the user pays the network; with no sponsor, no fee is charged   |
 * | true  | 0.08 | ChatterPay pays the network and deducts its fee from the amount |
 * | true  | 0    | ChatterPay pays the network and charges nothing                 |
 *
 * On top of those sits a third, coarser decision: **which of the two fee schemes runs**, chosen by
 * `CARDANO_FEE_SCHEME`. The table above describes scheme 1, where the ADA a token drags along comes
 * out of the sender's own wallet. Scheme 2 — **the default** — moves that ADA to the sponsor and
 * prices the fee in ADA rather than USD, so a user sending a token sees their token balance fall
 * and nothing else:
 *
 * | scheme | who supplies the token's min-ADA | fee priced in | what the sender needs |
 * |---|---|---|---|
 * | 1 | the sender          | USD | the amount, plus ~1.16 ADA to move a token |
 * | 2 | the sponsor wallet  | ADA | the amount, and nothing else               |
 *
 * Scheme 2 needs a sponsor for the same reason charging does, and reports itself off without one.
 *
 * The settings themselves are read by `constants.ts`, the only module that touches the environment.
 * What is left here is the decision they add up to.
 */

import { readCardanoFeeEnv } from '../helpers/envHelper';
import { Logger } from '../helpers/loggerHelper';
import type {
  CardanoFeeConfig,
  CardanoFeeScheme,
  CardanoSponsorDisabledReason
} from '../types/cardanoType';

/** ChatterPay's fee per transfer when the setting holds nothing usable: it charges nothing. */
const DEFAULT_TRANSFER_FEE = 0;

/** The scheme a deployment gets when it does not ask for one. */
const DEFAULT_SCHEME: CardanoFeeScheme = 2;

/**
 * Which scheme was asked for.
 *
 * Scheme 2 is the default, so selecting scheme 1 is the deliberate act and an unreadable setting
 * lands on 2 rather than on 1. That is the right way round now that 2 is what the product means to
 * do: a typo should not quietly restore the behaviour where sending a token drains the sender's
 * ADA. Going back to 1 is a decision somebody makes by writing `1`.
 */
function schemeOf(configured: number | null): CardanoFeeScheme {
  return configured === 1 ? 1 : DEFAULT_SCHEME;
}

/**
 * Whether the "you are on scheme 2 and charging nothing" warning has already been said.
 *
 * This resolver is called on every transfer and twice per request, so the warning is said once per
 * process rather than becoming the log.
 */
let warnedAboutUnpricedSchemeTwo = false;

/**
 * Says something when a deployment lands on scheme 2 with no ADA fee configured.
 *
 * The case that matters is a deployment that was on scheme 1, charging in USD, and is upgraded
 * without anyone touching its environment: it now runs scheme 2, reads `CARDANO_TRANSFER_FEE_ADA`,
 * finds nothing, and charges nothing at all. Every transfer succeeds and every transfer is free,
 * which is exactly the kind of failure nobody notices until the month closes.
 *
 * A warning rather than a refusal: charging nothing is a legitimate configuration, and refusing to
 * start over a fee is worse than transferring for free. But it should never be silent.
 */
function warnIfSchemeTwoIsUnpriced(config: CardanoFeeConfig, hadUsdFee: boolean): void {
  if (warnedAboutUnpricedSchemeTwo) return;
  if (config.scheme !== 2 || chargesTransferFee(config) || !hadUsdFee) return;
  warnedAboutUnpricedSchemeTwo = true;
  Logger.warn(
    'getCardanoFeeConfig',
    'Running fee scheme 2 with no ADA fee configured while a USD fee is set: scheme 2 prices in ' +
      'ADA and does not read the USD figure, so every Cardano transfer is currently free. Set the ' +
      'ADA fee, or select scheme 1 explicitly.'
  );
}

/**
 * Resolves who pays what, from the environment.
 *
 * @returns The configuration. Sponsoring reports itself off, with a reason, when it is switched on
 *   without the wallet it needs — the same posture as the family flag: half-configured is off. The
 *   two capabilities scheme 2 adds report themselves off along with it, because both of them are
 *   things a sponsor does and there is nothing to do them with.
 */
export function getCardanoFeeConfig(): CardanoFeeConfig {
  const env = readCardanoFeeEnv();

  const disabledReason: CardanoSponsorDisabledReason =
    env.sponsorFees && env.sponsorWalletId === '' ? 'sponsor_wallet_missing' : '';

  const scheme = schemeOf(env.feeScheme);
  const sponsorNetworkFee = env.sponsorFees && disabledReason === '';
  const schemeTwo = scheme === 2 && sponsorNetworkFee;

  const config: CardanoFeeConfig = {
    scheme,
    sponsorNetworkFee,
    sponsorMinAda: schemeTwo,
    // Behind its own switch and off unless asked for: it moves lovelace out of the user's
    // address, and nothing credits it back yet.
    routeDustToSponsor: schemeTwo && env.routeDustToSponsor,
    recycleDestinationUtxo: schemeTwo && env.recycleDestinationUtxo,
    transferFeeUsd: env.transferFeeUsd ?? DEFAULT_TRANSFER_FEE,
    transferFeeAda: env.transferFeeAda ?? DEFAULT_TRANSFER_FEE,
    // Falls back to the ordinary fee rather than to zero: a deployment that configured one figure
    // and not the other meant to charge something, and charging the smaller of the two is the
    // mistake that costs ChatterPay rather than the user.
    transferFeeAdaNewOutput:
      env.transferFeeAdaNewOutput ?? env.transferFeeAda ?? DEFAULT_TRANSFER_FEE,
    sponsorWalletId: env.sponsorWalletId,
    disabledReason
  };

  warnIfSchemeTwoIsUnpriced(config, (env.transferFeeUsd ?? 0) > 0);
  return config;
}

/**
 * Whether ChatterPay charges anything for a Cardano transfer.
 *
 * Charging also needs a sponsor: the fee rides in the sponsor's change output, and without one
 * there is no output to ride in. The transfer path checks both.
 */
export function chargesTransferFee(config: CardanoFeeConfig): boolean {
  // Both figures under scheme 2, not just the ordinary one: a deployment that sets only the
  // new-output fee means to charge, and reading the ordinary one alone would answer "no" and hand
  // out the expensive transfers for free.
  return config.scheme === 2
    ? config.transferFeeAda > 0 || config.transferFeeAdaNewOutput > 0
    : config.transferFeeUsd > 0;
}

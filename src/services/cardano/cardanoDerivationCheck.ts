/**
 * The startup check that this deployment still issues the addresses it used to.
 *
 * Every Cardano address is a pure function of settings that live outside the repository. That is
 * the point — but it means a wrong one is not an error, it is a *different deployment*: well-formed
 * addresses, derived without complaint, that nobody can sign for and that hold none of the funds
 * the previous ones hold. Nothing downstream can tell the two apart, because there is nothing to
 * compare against at request time.
 *
 * So the comparison is made here, once, against values recorded when the settings were known to be
 * right. `CARDANO_DERIVATION_CHECK` holds the address a fixed internal identifier resolves to, and
 * `CARDANO_SPONSOR_DERIVATION_CHECK` the address the sponsor wallet resolves to. Neither is a
 * switch: they are addresses, and there is nothing to turn on.
 *
 * The check is not optional, and its verdict switches off Cardano rather than the process. Those
 * are the same decision made twice: an unverified derivation must not issue an address or sign
 * anything, and a Cardano misconfiguration must not take EVM transfers, the bot and the webhooks
 * down with it. The verdict reaches every Cardano path through the configuration, which reports the
 * family off with a `disabledReason` the callers already handle.
 *
 * The sponsor is checked separately because it is a separate key: its own wallet id and its own two
 * labels. It is only checked when sponsoring is on, because that is the only state in which it is
 * derived at all.
 */

import { getCardanoConfigForDerivationCheck } from '../../config/cardanoConfig';
import { recordCardanoDerivationState } from '../../config/cardanoDerivationState';
import { getCardanoFeeConfig } from '../../config/cardanoFeeConfig';
import { CARDANO_DERIVATION_CHECK, CARDANO_SPONSOR_DERIVATION_CHECK } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import type { CardanoDerivationCheck, CardanoDerivationScope } from '../../types/cardanoType';
import { cardanoSignerService } from './cardanoSignerService';

/**
 * The identifier the check derives from.
 *
 * Fixed, and not a phone number anybody has: the address it produces is only ever compared with
 * itself, so it never needs to belong to a user.
 */
const CHECK_IDENTIFIER = '000000000000';

/**
 * Compares one derived address against the one recorded for it.
 *
 * @param scope - Which derivation this is about.
 * @param recorded - The address recorded for it, trimmed. Empty when none was recorded.
 * @param derive - Produces the address this deployment derives now.
 * @returns The verdict for this scope, or `null` when it matched.
 */
function compare(
  scope: CardanoDerivationScope,
  recorded: string,
  derive: () => string
): CardanoDerivationCheck | null {
  let derived: string;
  try {
    derived = derive();
  } catch (error) {
    // Reached only past the config gate, so this is not a missing setting: it is a setting the
    // gate accepted and the derivation could not use. Unusable is treated as changed, because what
    // it rules out is the same thing — that this deployment produces the address it recorded.
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'changed', scope, expected: recorded || '(unrecorded)', derived: message };
  }

  if (recorded === '') return { status: 'unrecorded', scope, address: derived };
  if (recorded !== derived) return { status: 'changed', scope, expected: recorded, derived };
  return null;
}

/**
 * Compares what this deployment derives against what it recorded.
 *
 * @returns What it concluded. Only `ok` lets the family operate.
 */
export function checkCardanoDerivation(): CardanoDerivationCheck {
  const config = getCardanoConfigForDerivationCheck();
  // Already off for a reason of its own, and that reason is the one worth reporting. Deriving here
  // would be deriving against a configuration the family has already refused.
  if (!config.enabled) return { status: 'skipped', detail: config.disabledReason || 'disabled' };

  const user = compare(
    'user',
    CARDANO_DERIVATION_CHECK,
    () => cardanoSignerService.getAccount(CHECK_IDENTIFIER, config.network, config.chainId).address
  );
  if (user) return user;

  const feeConfig = getCardanoFeeConfig();
  // Nothing derives the sponsor while sponsoring is off, so there is nothing to verify and nothing
  // to hold the family back for. Switching sponsoring on without recording its address is what the
  // `unrecorded` verdict below is for.
  // The address is the recorded one rather than the derived one: `compare` answered `null`, which
  // is what says the two are the same string.
  if (!feeConfig.sponsorNetworkFee) {
    return { status: 'ok', address: CARDANO_DERIVATION_CHECK, sponsorAddress: null };
  }

  const sponsorAddress = () =>
    cardanoSignerService.getSponsorAccount(
      feeConfig.sponsorWalletId,
      config.network,
      config.chainId
    ).address;
  const sponsor = compare('sponsor', CARDANO_SPONSOR_DERIVATION_CHECK, sponsorAddress);
  if (sponsor) return sponsor;

  return {
    status: 'ok',
    address: CARDANO_DERIVATION_CHECK,
    sponsorAddress: CARDANO_SPONSOR_DERIVATION_CHECK
  };
}

/**
 * Runs the check at startup and records what it concluded.
 *
 * Never throws and never exits: an unverified derivation is a reason to keep Cardano off, not a
 * reason to leave the port closed. Every other family, the bot webhooks and the health check come
 * up exactly as they did.
 */
export function verifyCardanoDerivation(): void {
  const result = checkCardanoDerivation();

  switch (result.status) {
    case 'skipped':
      // The family is already off for a reason of its own, so the verdict changes nothing. The
      // state stays `pending`, which is what it means: nothing was verified.
      Logger.log('cardanoDerivationCheck', `skipped: ${result.detail}`);
      break;
    case 'unrecorded':
      recordCardanoDerivationState({ status: 'unrecorded', scope: result.scope });
      Logger.error(
        'cardanoDerivationCheck',
        `No address is recorded for the ${result.scope} derivation, so nothing verifies that this ` +
          'deployment still issues the addresses it used to. Cardano stays off; everything else ' +
          `runs. Verify ${result.address} against the addresses this environment already issued, ` +
          'and record it once it checks out.'
      );
      break;
    case 'changed':
      recordCardanoDerivationState({ status: 'changed', scope: result.scope });
      Logger.fatal(
        'cardanoDerivationCheck',
        `This deployment no longer derives the ${result.scope} address it recorded. Something the ` +
          `derivation depends on changed. Expected ${result.expected}, derived ${result.derived}. ` +
          'Cardano is off: every address issued from here would be one nobody can sign for.'
      );
      break;
    default:
      recordCardanoDerivationState({ status: 'verified' });
      Logger.log('cardanoDerivationCheck', 'ok');
  }
}

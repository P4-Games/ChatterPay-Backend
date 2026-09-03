/**
 * The startup check that this deployment still issues the addresses it used to.
 *
 * Every Cardano address is a pure function of settings that live outside the repository. That is
 * the point — but it means a wrong one is not an error, it is a *different deployment*: well-formed
 * addresses, derived without complaint, that nobody can sign for and that hold none of the funds
 * the previous ones hold. Nothing downstream can tell the two apart, because there is nothing to
 * compare against at request time.
 *
 * So the comparison is made here, once, against a value recorded when the settings were known to be
 * right. `CARDANO_DERIVATION_CHECK` holds the address a fixed internal identifier resolves to; if
 * the deployment no longer produces it, something it depends on changed and the process refuses to
 * start. Cloud Run keeps the previous revision serving, which is the correct outcome: yesterday's
 * deployment issuing yesterday's addresses beats today's issuing addresses nobody can reach.
 *
 * The check is opt-in. Without the recorded value there is nothing to compare against and the
 * deployment starts, with a warning — an environment that has never issued an address has nothing
 * to lose, and one that has should record it.
 */

import { getCardanoConfig } from '../../config/cardanoConfig';
import { CARDANO_DERIVATION_CHECK } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import type { CardanoDerivationCheck } from '../../types/cardanoType';
import { cardanoSignerService } from './cardanoSignerService';

/**
 * The identifier the check derives from.
 *
 * Fixed, and not a phone number anybody has: the address it produces is only ever compared with
 * itself, so it never needs to belong to a user.
 */
const CHECK_IDENTIFIER = '000000000000';

/**
 * Compares what this deployment derives against what it recorded.
 *
 * @returns What it concluded. `changed` is the one the caller must not ignore.
 */
export function checkCardanoDerivation(): CardanoDerivationCheck {
  const config = getCardanoConfig();
  if (!config.enabled) return { status: 'skipped', detail: config.disabledReason || 'disabled' };

  let derived: string;
  try {
    derived = cardanoSignerService.getAccount(
      CHECK_IDENTIFIER,
      config.network,
      config.chainId
    ).address;
  } catch (error) {
    // Reached only past the config gate, so this is not a missing setting: it is a setting the
    // gate accepted and the derivation could not use.
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'changed',
      expected: CARDANO_DERIVATION_CHECK || '(unrecorded)',
      derived: message
    };
  }

  if (!CARDANO_DERIVATION_CHECK) return { status: 'unrecorded', address: derived };
  if (CARDANO_DERIVATION_CHECK !== derived) {
    return { status: 'changed', expected: CARDANO_DERIVATION_CHECK, derived };
  }
  return { status: 'ok', address: derived };
}

/**
 * Runs the check at startup and stops the process when the derivation has moved.
 *
 * Exits rather than carrying on with Cardano switched off: a deployment that reaches this state was
 * misconfigured on the way in, and the deploy that produced it is the thing that should fail.
 */
export function assertCardanoDerivationUnchanged(): void {
  const result = checkCardanoDerivation();

  switch (result.status) {
    case 'skipped':
      Logger.log('cardanoDerivationCheck', `skipped: ${result.detail}`);
      break;
    case 'unrecorded':
      Logger.warn(
        'cardanoDerivationCheck',
        'CARDANO_DERIVATION_CHECK is not set: nothing verifies that this deployment still issues ' +
          `the addresses it used to. Record ${result.address} to switch the check on.`
      );
      break;
    case 'changed':
      Logger.fatal(
        'cardanoDerivationCheck',
        'This deployment no longer derives the address it recorded. Something the derivation ' +
          `depends on changed. Expected ${result.expected}, derived ${result.derived}. Refusing ` +
          'to start: every address issued from here would be one nobody can sign for.'
      );
      process.exit(1);
      break;
    default:
      Logger.log('cardanoDerivationCheck', 'ok');
  }
}

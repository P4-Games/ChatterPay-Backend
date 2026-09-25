import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID, getCardanoConfig } from '../../../src/config/cardanoConfig';
import { getCardanoDerivationState } from '../../../src/config/cardanoDerivationState';
import {
  checkCardanoDerivation,
  verifyCardanoDerivation
} from '../../../src/services/cardano/cardanoDerivationCheck';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import {
  cardanoEnvState,
  enableCardanoPreprod,
  resetCardanoEnv,
  setCardanoEnv,
  setCardanoFeeEnv
} from '../../support/cardanoEnv';

/**
 * What the startup check protects, and what it costs when it refuses.
 *
 * Two properties, and the second is the one that used to be wrong. The first: a deployment may not
 * issue an address or sign anything until the addresses it derives are the ones it recorded. The
 * second: that conclusion switches off Cardano and nothing else. A wrong derivation label is a
 * Cardano problem, and it used to end the process — taking EVM transfers, the bot webhooks and the
 * health check with it.
 */

vi.mock('../../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  const { cardanoConstantsMock } = await import('../../support/cardanoEnv');
  return cardanoConstantsMock(actual);
});

/** The sponsor wallet this deployment is configured with. */
const SPONSOR_WALLET = 'test-sponsor';

/** The identifier the check derives from, restated here so the test does not import a private. */
const CHECK_IDENTIFIER = '000000000000';

/** Any well-formed address that is not one of the two this deployment derives. */
const SOMEBODY_ELSE = 'addr_test1vzz7dpz6qkhkc9pvg9nt5rd9cqk9ktv0gqedfjnxqyuvqhs0lvsqy';

/** What this deployment derives for the check identifier, given the fixed test labels. */
function derivedUserAddress(): string {
  return cardanoSignerService.getAccount(CHECK_IDENTIFIER, 'testnet', CARDANO_PREPROD_CHAIN_ID)
    .address;
}

/** What it derives for the sponsor wallet. */
function derivedSponsorAddress(): string {
  return cardanoSignerService.getSponsorAccount(SPONSOR_WALLET, 'testnet', CARDANO_PREPROD_CHAIN_ID)
    .address;
}

/** Turns sponsoring on, which is what makes the sponsor derivation part of the answer. */
function sponsoring(): void {
  setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: SPONSOR_WALLET });
}

beforeEach(() => {
  enableCardanoPreprod();
  // `enableCardanoPreprod` states the verdict for suites that need a working family. This one is
  // about producing the verdict, so it starts from the state a process has before the check runs.
  resetCardanoEnv();
  setCardanoEnv({ enabled: true, network: 'preprod' });
});

describe('before the check has run', () => {
  it('reports the family off rather than inheriting the answer it would have given', () => {
    // Everything is configured correctly here, including the recorded address. The point is that
    // being correct is not the same as having been checked.
    cardanoEnvState.derivationCheck = derivedUserAddress();

    expect(getCardanoDerivationState()).toEqual({ status: 'pending' });
    expect(getCardanoConfig()).toMatchObject({
      enabled: false,
      disabledReason: 'derivation_unverified'
    });
  });
});

describe('the user derivation', () => {
  it('passes when this deployment still derives what it recorded', () => {
    cardanoEnvState.derivationCheck = derivedUserAddress();

    expect(checkCardanoDerivation()).toMatchObject({ status: 'ok' });

    verifyCardanoDerivation();
    expect(getCardanoConfig()).toMatchObject({ enabled: true, disabledReason: '' });
  });

  it('refuses when nothing was recorded, rather than adopting what it derives', () => {
    // The address is reported so an operator can check it against one this environment already
    // issued. Reporting it is not accepting it: an environment that has users must not have its
    // reference decided by the process being verified.
    const result = checkCardanoDerivation();

    expect(result).toMatchObject({ status: 'unrecorded', scope: 'user' });
    expect(result).toHaveProperty('address', derivedUserAddress());

    verifyCardanoDerivation();
    expect(getCardanoConfig()).toMatchObject({
      enabled: false,
      disabledReason: 'derivation_unrecorded'
    });
  });

  it('refuses when the recorded address is no longer the one it derives', () => {
    cardanoEnvState.derivationCheck = SOMEBODY_ELSE;

    expect(checkCardanoDerivation()).toMatchObject({
      status: 'changed',
      scope: 'user',
      expected: SOMEBODY_ELSE,
      derived: derivedUserAddress()
    });

    verifyCardanoDerivation();
    expect(getCardanoConfig()).toMatchObject({
      enabled: false,
      disabledReason: 'derivation_changed'
    });
  });
});

describe('the sponsor derivation', () => {
  it('is verified separately, and its absence is enough to refuse', () => {
    // The user reference is in place and matches. The sponsor's is not — and the sponsor is the
    // wallet that signs and spends, so this is not a lesser state.
    cardanoEnvState.derivationCheck = derivedUserAddress();
    sponsoring();

    expect(checkCardanoDerivation()).toMatchObject({ status: 'unrecorded', scope: 'sponsor' });

    verifyCardanoDerivation();
    expect(getCardanoConfig().enabled).toBe(false);
  });

  it('refuses when only the sponsor address moved', () => {
    cardanoEnvState.derivationCheck = derivedUserAddress();
    cardanoEnvState.sponsorDerivationCheck = SOMEBODY_ELSE;
    sponsoring();

    expect(checkCardanoDerivation()).toMatchObject({
      status: 'changed',
      scope: 'sponsor',
      derived: derivedSponsorAddress()
    });
  });

  it('catches a wallet id that changed, which the user derivation cannot see', () => {
    // The regression this exists for. `CARDANO_SPONSOR_WALLET_ID` is an input to the sponsor seed
    // and to nothing else, so before this the deployment reported `ok`, started, and refused every
    // sponsored transfer with a message that named nothing.
    cardanoEnvState.derivationCheck = derivedUserAddress();
    cardanoEnvState.sponsorDerivationCheck = derivedSponsorAddress();
    setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: 'a-different-wallet' });

    expect(checkCardanoDerivation()).toMatchObject({ status: 'changed', scope: 'sponsor' });
  });

  it('passes when both references match', () => {
    cardanoEnvState.derivationCheck = derivedUserAddress();
    cardanoEnvState.sponsorDerivationCheck = derivedSponsorAddress();
    sponsoring();

    verifyCardanoDerivation();
    expect(getCardanoConfig()).toMatchObject({ enabled: true, disabledReason: '' });
  });

  it('is not required while sponsoring is off, because nothing derives it', () => {
    cardanoEnvState.derivationCheck = derivedUserAddress();
    setCardanoFeeEnv({ sponsorFees: false, sponsorWalletId: '' });

    expect(checkCardanoDerivation()).toMatchObject({ status: 'ok', sponsorAddress: null });

    verifyCardanoDerivation();
    expect(getCardanoConfig().enabled).toBe(true);
  });
});

describe('a configuration that is already refused for its own reason', () => {
  it('is reported as that reason, not as a derivation verdict', () => {
    setCardanoEnv({ enabled: false });

    expect(checkCardanoDerivation()).toEqual({ status: 'skipped', detail: 'flag_off' });

    verifyCardanoDerivation();
    // Nothing was verified, so nothing is recorded. The family is off for the flag, which is what
    // an operator needs to read.
    expect(getCardanoDerivationState()).toEqual({ status: 'pending' });
    expect(getCardanoConfig().disabledReason).toBe('flag_off');
  });

  it('does not derive against a chain id that was refused', () => {
    setCardanoEnv({ chainId: 534351 });

    expect(checkCardanoDerivation()).toEqual({ status: 'skipped', detail: 'chain_id_mismatch' });
  });
});

describe('what a refusal costs the rest of the backend', () => {
  it('never ends the process, whatever it concludes', () => {
    // The property, stated as bluntly as it can be. Every one of these used to be, or could become,
    // a reason to stop the container — and every route the product serves goes down with it.
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit was called');
    }) as never);

    try {
      for (const arrange of [
        () => {
          cardanoEnvState.derivationCheck = '';
        },
        () => {
          cardanoEnvState.derivationCheck = SOMEBODY_ELSE;
        },
        () => {
          cardanoEnvState.derivationCheck = derivedUserAddress();
          sponsoring();
        },
        () => {
          setCardanoEnv({ enabled: false });
        }
      ]) {
        resetCardanoEnv();
        setCardanoEnv({ enabled: true, network: 'preprod' });
        arrange();

        expect(() => verifyCardanoDerivation()).not.toThrow();
      }

      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it('leaves a verdict the callers can read instead of one they have to infer', () => {
    // What replaces the exit: a reason that travels with the configuration every Cardano path
    // already consults, so no caller needs its own notion of whether the keys are trustworthy.
    cardanoEnvState.derivationCheck = SOMEBODY_ELSE;
    verifyCardanoDerivation();

    expect(getCardanoDerivationState()).toEqual({ status: 'changed', scope: 'user' });
    expect(getCardanoConfig().disabledReason).toBe('derivation_changed');
  });
});

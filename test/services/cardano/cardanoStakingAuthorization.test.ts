import type { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import CardanoStakingAccount from '../../../src/models/cardanoStakingAccountModel';
import { UserModel } from '../../../src/models/userModel';
import {
  rewardAddress,
  stakeCredentialHex
} from '../../../src/services/cardano/cardanoAddressService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import {
  signBffAssertion,
  verifyPinGrant
} from '../../../src/services/cardano/cardanoStakingAssertionService';
import { authorizeStakingAction } from '../../../src/services/cardano/cardanoStakingUserService';
import { mongoSecurityService } from '../../../src/services/mongo/mongoSecurityService';
import { securityService } from '../../../src/services/securityService';
import { enableCardanoPreprod } from '../../support/cardanoEnv';

/**
 * The authorisation step of a staking mutation, end to end against the real security service.
 *
 * What it covers is the handover between two modules that answer different questions: the security
 * service says whether this person proved who they are, and the assertion service turns that answer
 * into something the next request can present. Every refusal below reaches the user as one HTTP status
 * and one code, so a case that stops being distinguishable here stops being actionable on screen.
 *
 * `SECURITY_PIN_ENABLED` is read through a getter so the suite can drive both configurations. A
 * deployment with the PIN off is the one the local environment runs in, and it used to make every
 * authorisation refuse with `security_gate` because no user has a PIN to verify.
 */

const state = vi.hoisted(() => ({ pinEnabled: true }));

vi.mock('../../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  const { cardanoConstantsMock } = await import('../../support/cardanoEnv');
  // Fixed rather than read from the machine: the suite is a property of the code, and the values below
  // are fabricated for it.
  return Object.defineProperties(cardanoConstantsMock(actual), {
    SECURITY_PIN_ENABLED: { get: () => state.pinEnabled, enumerable: true },
    SECURITY_PIN_HMAC_KEY: { value: 'a-fabricated-pin-key-for-this-suite', enumerable: true },
    SECURITY_PIN_LENGTH: { value: 6, enumerable: true },
    SECURITY_PIN_MAX_FAILED_ATTEMPTS: { value: 3, enumerable: true },
    SECURITY_PIN_BLOCK_MINUTES: { value: 5, enumerable: true },
    CARDANO_STAKING_FRONTEND_BFF_SECRET: {
      value: 'a-fabricated-bff-secret-for-this-suite',
      enumerable: true
    }
  });
});

const PHONE = '5491133334444';
const PIN = '246810';
const WRONG_PIN = '135791';

/**
 * Where the delegation being authorised sends the voting power.
 *
 * Abstaining is the one target this surface offers, and the canonical form of it is the kind itself.
 * The target is inside both signatures, so it appears in the expectation a grant is checked against.
 */
const TARGET = { kind: 'always_abstain' } as const;
const TARGET_CANONICAL = 'always_abstain';

/**
 * Creates a user and the staking account the authorisation resolves before it checks anything.
 *
 * @param phoneNumber - Whose wallet it is.
 * @returns The account id.
 */
async function seed(phoneNumber: string): Promise<Types.ObjectId> {
  const derived = cardanoSignerService.getAccount(phoneNumber, 'testnet', CARDANO_PREPROD_CHAIN_ID);
  const user = await UserModel.create({
    phone_number: phoneNumber,
    name: `user-${phoneNumber}`,
    wallets: [],
    settings: {}
  });

  const account = await CardanoStakingAccount.create({
    userId: user._id,
    chainId: CARDANO_PREPROD_CHAIN_ID,
    walletAddress: derived.address,
    rewardAddress: rewardAddress(derived.stakePublicKey, 'testnet'),
    stakeCredentialHex: stakeCredentialHex(derived.stakePublicKey),
    state: 'awaiting_consent'
  });

  return account._id as Types.ObjectId;
}

beforeEach(async () => {
  state.pinEnabled = true;
  enableCardanoPreprod();
  await CardanoStakingAccount.deleteMany({});
  await UserModel.deleteMany({});
});

describe('authorizeStakingAction, with the PIN on', () => {
  it('issues a grant that verifies for the action it was asked for', async () => {
    await seed(PHONE);
    await securityService.setPin(PHONE, PIN, 'frontend');

    const result = await authorizeStakingAction(PHONE, 'delegate_vote', {
      pin: PIN,
      bffAssertion: signBffAssertion(PHONE, 'delegate_vote', null, TARGET_CANONICAL),
      governanceTarget: TARGET,
      actor: 'web'
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.data.action).toBe('delegate_vote');
    expect(
      verifyPinGrant(result.data.grant, {
        sub: PHONE,
        act: 'delegate_vote',
        rcp: null,
        gov: TARGET_CANONICAL
      })
    ).toMatchObject({ ok: true });
  });

  it('will not let a grant be carried to another action', async () => {
    await seed(PHONE);
    await securityService.setPin(PHONE, PIN, 'frontend');

    const result = await authorizeStakingAction(PHONE, 'delegate_vote', {
      pin: PIN,
      bffAssertion: signBffAssertion(PHONE, 'delegate_vote', null, TARGET_CANONICAL),
      governanceTarget: TARGET,
      actor: 'web'
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(
      verifyPinGrant(result.data.grant, {
        sub: PHONE,
        act: 'exit_and_send_max',
        rcp: null,
        gov: null
      })
    ).toMatchObject({ ok: false, rejection: 'mismatched' });
  });

  it('will not let a grant be carried to another user', async () => {
    await seed(PHONE);
    await securityService.setPin(PHONE, PIN, 'frontend');

    const result = await authorizeStakingAction(PHONE, 'delegate_vote', {
      pin: PIN,
      bffAssertion: signBffAssertion(PHONE, 'delegate_vote', null, TARGET_CANONICAL),
      governanceTarget: TARGET,
      actor: 'web'
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(
      verifyPinGrant(result.data.grant, {
        sub: '5491155556666',
        act: 'delegate_vote',
        rcp: null,
        gov: TARGET_CANONICAL
      })
    ).toMatchObject({ ok: false, rejection: 'mismatched' });
  });

  it('refuses a PIN that does not match, and says which situation it is', async () => {
    await seed(PHONE);
    await securityService.setPin(PHONE, PIN, 'frontend');

    // `active` is the security service's word for "wrong, and there are attempts left". The screen
    // needs it separate from `blocked` and from `not_set`.
    await expect(
      authorizeStakingAction(PHONE, 'delegate_vote', {
        pin: WRONG_PIN,
        bffAssertion: signBffAssertion(PHONE, 'delegate_vote', null, TARGET_CANONICAL),
        governanceTarget: TARGET,
        actor: 'web'
      })
    ).resolves.toMatchObject({ ok: false, refusal: 'security_gate', detail: 'active' });
  });

  it('refuses a user who has not set a PIN', async () => {
    await seed(PHONE);

    await expect(
      authorizeStakingAction(PHONE, 'delegate_vote', {
        pin: PIN,
        bffAssertion: signBffAssertion(PHONE, 'delegate_vote', null, TARGET_CANONICAL),
        governanceTarget: TARGET,
        actor: 'web'
      })
    ).resolves.toMatchObject({ ok: false, refusal: 'security_gate', detail: 'not_set' });
  });

  it('refuses a blocked PIN', async () => {
    await seed(PHONE);
    await securityService.setPin(PHONE, PIN, 'frontend');
    await mongoSecurityService.setPinBlockedUntil(PHONE, new Date(Date.now() + 60_000));

    await expect(
      authorizeStakingAction(PHONE, 'delegate_vote', {
        pin: PIN,
        bffAssertion: signBffAssertion(PHONE, 'delegate_vote', null, TARGET_CANONICAL),
        governanceTarget: TARGET,
        actor: 'web'
      })
    ).resolves.toMatchObject({ ok: false, refusal: 'security_gate', detail: 'blocked' });
  });

  it('refuses a request that carries no assertion, before it touches the PIN', async () => {
    await seed(PHONE);
    await securityService.setPin(PHONE, PIN, 'frontend');

    await expect(
      authorizeStakingAction(PHONE, 'delegate_vote', {
        pin: WRONG_PIN,
        bffAssertion: null,
        governanceTarget: TARGET,
        actor: 'web'
      })
    ).resolves.toMatchObject({ ok: false, refusal: 'assertion' });

    // The failed-attempt counter did not move, which is what keeps this endpoint from being a way to
    // brute-force somebody else's PIN.
    const status = await securityService.getSecurityStatus(PHONE);
    expect(status.failed_attempts).toBe(0);
  });

  it('refuses an assertion issued for a different action', async () => {
    await seed(PHONE);
    await securityService.setPin(PHONE, PIN, 'frontend');

    await expect(
      authorizeStakingAction(PHONE, 'delegate_vote', {
        pin: PIN,
        bffAssertion: signBffAssertion(PHONE, 'withdraw_rewards', null, TARGET_CANONICAL),
        governanceTarget: TARGET,
        actor: 'web'
      })
    ).resolves.toMatchObject({ ok: false, refusal: 'assertion' });
  });

  it('refuses a user with no staking account before it checks the PIN', async () => {
    await UserModel.create({ phone_number: PHONE, name: 'no account', wallets: [], settings: {} });
    await securityService.setPin(PHONE, PIN, 'frontend');

    await expect(
      authorizeStakingAction(PHONE, 'delegate_vote', {
        pin: WRONG_PIN,
        bffAssertion: signBffAssertion(PHONE, 'delegate_vote', null, TARGET_CANONICAL),
        governanceTarget: TARGET,
        actor: 'web'
      })
    ).resolves.toMatchObject({ ok: false, refusal: 'no_staking_account' });
  });

  it('refuses an action a user may not ask for', async () => {
    await seed(PHONE);
    await securityService.setPin(PHONE, PIN, 'frontend');

    await expect(
      authorizeStakingAction(PHONE, 'register_drep', {
        pin: PIN,
        bffAssertion: signBffAssertion(PHONE, 'register_drep'),
        actor: 'web'
      })
    ).resolves.toMatchObject({ ok: false, refusal: 'action_not_allowed' });
  });
});

describe('authorizeStakingAction, with the PIN off', () => {
  beforeEach(() => {
    state.pinEnabled = false;
  });

  it('issues a grant although no user has a PIN to verify', async () => {
    await seed(PHONE);

    const result = await authorizeStakingAction(PHONE, 'delegate_vote', {
      pin: PIN,
      bffAssertion: signBffAssertion(PHONE, 'delegate_vote', null, TARGET_CANONICAL),
      governanceTarget: TARGET,
      actor: 'web'
    });

    // The switch governs this step the way it governs the gate. Refusing here left the whole surface
    // unreachable: no user has a PIN in a deployment that has the PIN off, so every authorisation
    // answered `security_gate`.
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(
      verifyPinGrant(result.data.grant, {
        sub: PHONE,
        act: 'delegate_vote',
        rcp: null,
        gov: TARGET_CANONICAL
      })
    ).toMatchObject({ ok: true });
  });

  it('still requires the BFF assertion', async () => {
    await seed(PHONE);

    // The PIN switch says nothing about who authenticated the session, and that is the other half.
    await expect(
      authorizeStakingAction(PHONE, 'delegate_vote', {
        pin: PIN,
        bffAssertion: null,
        governanceTarget: TARGET,
        actor: 'web'
      })
    ).resolves.toMatchObject({ ok: false, refusal: 'assertion' });
  });

  it('still resolves the wallet from the identity', async () => {
    await expect(
      authorizeStakingAction(PHONE, 'delegate_vote', {
        pin: PIN,
        bffAssertion: signBffAssertion(PHONE, 'delegate_vote', null, TARGET_CANONICAL),
        governanceTarget: TARGET,
        actor: 'web'
      })
    ).resolves.toMatchObject({ ok: false, refusal: 'user_not_found' });
  });
});

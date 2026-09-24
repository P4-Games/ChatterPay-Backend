import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import { getCardanoStakingConfig } from '../../../src/config/cardanoStakingConfig';
import CardanoStakingAccount from '../../../src/models/cardanoStakingAccountModel';
import CardanoStakingGovernanceEvent from '../../../src/models/cardanoStakingGovernanceEventModel';
import { UserModel } from '../../../src/models/userModel';
import {
  rewardAddress,
  stakeCredentialHex
} from '../../../src/services/cardano/cardanoAddressService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import {
  getGovernanceHistory,
  setStakingConsent,
  USER_REQUESTABLE_ACTIONS
} from '../../../src/services/cardano/cardanoStakingUserService';
import { enableCardanoPreprod } from '../../support/cardanoEnv';

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

const PHONE = '5491133334444';
const OTHER_PHONE = '5491155556666';

/**
 * Creates a user and its staking account.
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
  enableCardanoPreprod();
  await CardanoStakingAccount.deleteMany({});
  await CardanoStakingGovernanceEvent.deleteMany({});
  await UserModel.deleteMany({});
});

describe('USER_REQUESTABLE_ACTIONS', () => {
  it('excludes every kind that registers or votes as a DRep of our own', () => {
    // Those exist in the model so the shape is settled. Exposing them here would route to a feature
    // whose flag is off and whose product decision has not been taken.
    expect(USER_REQUESTABLE_ACTIONS).not.toContain('register_drep');
    expect(USER_REQUESTABLE_ACTIONS).not.toContain('unregister_drep');
    expect(USER_REQUESTABLE_ACTIONS).not.toContain('update_drep');
    expect(USER_REQUESTABLE_ACTIONS).not.toContain('cast_drep_vote');
  });

  it('includes the ways out', () => {
    // A user has to be able to leave through this surface, not only through an operator.
    expect(USER_REQUESTABLE_ACTIONS).toContain('deregister');
    expect(USER_REQUESTABLE_ACTIONS).toContain('exit_and_send_max');
  });
});

describe('setStakingConsent', () => {
  it('refuses a phone number that resolves to no user', async () => {
    await expect(setStakingConsent('5490000000000', true, 'web')).resolves.toMatchObject({
      ok: false,
      refusal: 'user_not_found'
    });
  });

  it('refuses a user with no staking account on this network', async () => {
    await UserModel.create({ phone_number: PHONE, name: 'no account', wallets: [], settings: {} });

    await expect(setStakingConsent(PHONE, true, 'web')).resolves.toMatchObject({
      ok: false,
      refusal: 'no_staking_account'
    });
  });

  it('records the consent and the opt-in together', async () => {
    const accountId = await seed(PHONE);

    const result = await setStakingConsent(PHONE, true, 'web');

    expect(result).toMatchObject({ ok: true });
    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.preference.enabled).toBe(true);
    expect(stored?.termsConsent?.version).toBe(getCardanoStakingConfig().termsVersion);
    expect(stored?.termsConsent?.source).toBe('web');
  });

  it('opens a lifecycle when one is joined', async () => {
    const accountId = await seed(PHONE);

    await setStakingConsent(PHONE, true, 'web');

    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.currentLifecycleId).not.toBeNull();
    expect(stored?.financingMode).toBe('user');
  });

  it('does not rewrite a lifecycle that is already open', async () => {
    // Fixed when the cycle starts, because resolving it again at exit time would let a settings
    // change reassign ownership of a deposit that is already on chain.
    const accountId = await seed(PHONE);
    await CardanoStakingAccount.updateOne(
      { _id: accountId },
      { $set: { currentLifecycleId: 'cycle-original', financingMode: 'user' } }
    );

    await setStakingConsent(PHONE, true, 'web');

    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.currentLifecycleId).toBe('cycle-original');
  });

  it('switches staking off without erasing the consent', async () => {
    // Switching off is not a withdrawal of consent. A position already on chain does not disappear
    // because the switch moved, and the record says which terms it was opened under.
    const accountId = await seed(PHONE);
    await setStakingConsent(PHONE, true, 'web');

    await setStakingConsent(PHONE, false, 'web');

    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.preference.enabled).toBe(false);
    expect(stored?.termsConsent?.version).toBe(getCardanoStakingConfig().termsVersion);
  });

  it('bumps the preference version on every change', async () => {
    const accountId = await seed(PHONE);

    await setStakingConsent(PHONE, true, 'web');
    await setStakingConsent(PHONE, false, 'web');

    const stored = await CardanoStakingAccount.findById(accountId).lean();
    expect(stored?.preference.version).toBe(2);
  });

  it('touches only the account of the phone number it was given', async () => {
    // The property the whole module is shaped around: there is no parameter through which one user's
    // request reaches another user's credential.
    const mine = await seed(PHONE);
    const theirs = await seed(OTHER_PHONE);

    await setStakingConsent(PHONE, true, 'web');

    expect((await CardanoStakingAccount.findById(mine).lean())?.preference.enabled).toBe(true);
    expect((await CardanoStakingAccount.findById(theirs).lean())?.preference.enabled).toBe(false);
  });
});

describe('getGovernanceHistory', () => {
  it('returns only the events of the credential the phone number owns', async () => {
    const mine = await seed(PHONE);
    const theirs = await seed(OTHER_PHONE);

    await CardanoStakingGovernanceEvent.create({
      accountId: mine,
      chainId: CARDANO_PREPROD_CHAIN_ID,
      kind: 'always_abstain',
      actor: 'chain',
      requestedAt: new Date()
    });
    await CardanoStakingGovernanceEvent.create({
      accountId: theirs,
      chainId: CARDANO_PREPROD_CHAIN_ID,
      kind: 'always_no_confidence',
      actor: 'chain',
      requestedAt: new Date()
    });

    const result = await getGovernanceHistory(PHONE);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('expected a result');
    expect(result.data.events).toHaveLength(1);
  });

  it('refuses a phone number with no staking account', async () => {
    await expect(getGovernanceHistory('5490000000000')).resolves.toMatchObject({
      ok: false,
      refusal: 'user_not_found'
    });
  });
});

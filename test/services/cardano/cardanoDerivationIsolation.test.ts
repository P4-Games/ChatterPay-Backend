import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import { recordCardanoDerivationState } from '../../../src/config/cardanoDerivationState';
import Blockchain from '../../../src/models/blockchainModel';
import CardanoStakingAccount from '../../../src/models/cardanoStakingAccountModel';
import { UserModel } from '../../../src/models/userModel';
import { sponsorCanCoverFee } from '../../../src/services/cardano/cardanoPreflightService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import {
  runStakingSync,
  type StakingSyncRequest
} from '../../../src/services/cardano/cardanoStakingSyncService';
import { setStakingConsent } from '../../../src/services/cardano/cardanoStakingUserService';
import {
  deriveCardanoAccount,
  ensureCardanoWalletForUser,
  getOrCreateCardanoWallet
} from '../../../src/services/cardano/cardanoWalletService';
import {
  enableCardanoPreprod,
  markCardanoDerivationVerified,
  resetCardanoEnv,
  setCardanoEnv,
  setCardanoFeeEnv,
  setCardanoNetwork
} from '../../support/cardanoEnv';
import { seedStakingNetwork } from '../../support/cardanoStakingNetwork';

/**
 * What a deployment may do while its Cardano keys have not been shown to be its own.
 *
 * The answer is: read, and nothing else. No address issued, no wallet row written, no transaction
 * assembled and nothing signed. The configuration is what carries that decision, so this suite
 * drives the verdict directly and then goes at the functions that would otherwise derive, write or
 * spend — including the ones a caller reaches without passing an endpoint.
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

const PHONE = '5491100000031';
const UNKNOWN_PHONE = '5491100000032';

/** A deployment configured correctly, whose startup check has not run. */
function unverified(): void {
  resetCardanoEnv();
  setCardanoEnv({ enabled: true });
  setCardanoNetwork();
}

/** A deployment whose sponsor derivation no longer matches what it recorded. */
function sponsorChanged(): void {
  unverified();
  setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: 'sponsor' });
  recordCardanoDerivationState({ status: 'changed', scope: 'sponsor' });
}

beforeEach(async () => {
  unverified();
  await UserModel.deleteMany({});
  await CardanoStakingAccount.deleteMany({});
  await Blockchain.deleteMany({});
});

describe('issuing an address', () => {
  it('is refused while the derivation is unverified', () => {
    expect(() => deriveCardanoAccount(PHONE)).toThrow(/CARDANO_DISABLED/);
  });

  it('carries the reason, so the log says which setting to look at', () => {
    recordCardanoDerivationState({ status: 'changed', scope: 'user' });

    expect(() => deriveCardanoAccount(PHONE)).toThrow(/derivation_changed/);
  });

  it('works again once the check has passed', () => {
    markCardanoDerivationVerified();

    expect(deriveCardanoAccount(PHONE).address).toBe(
      cardanoSignerService.getAccount(PHONE, 'testnet', CARDANO_PREPROD_CHAIN_ID).address
    );
  });
});

describe('provisioning a wallet', () => {
  it('writes nothing for a user who already exists', async () => {
    const user = await UserModel.create({ phone_number: PHONE, wallets: [] });

    await expect(ensureCardanoWalletForUser(user)).rejects.toThrow(/CARDANO_DISABLED/);

    const stored = await UserModel.findOne({ phone_number: PHONE });
    expect(stored?.wallets).toHaveLength(0);
  });

  it('does not create the user a Cardano recipient would have needed', async () => {
    // The path that creates an account for somebody who has never used ChatterPay. Creating one
    // here would leave a row holding an address derived under keys nobody verified.
    await expect(getOrCreateCardanoWallet(UNKNOWN_PHONE)).rejects.toThrow(/CARDANO_DISABLED/);

    expect(await UserModel.countDocuments({})).toBe(0);
  });
});

describe('the sponsor', () => {
  it('is not derived, and the transfer is refused, when its identity is the thing in doubt', async () => {
    sponsorChanged();

    const result = await sponsorCanCoverFee('[test:cardano]');

    expect(result.ok).toBe(false);
    expect(result.refusal).toEqual({ reason: 'sponsor_unavailable', params: {} });
  });

  it('is refused while the verdict is merely pending, not only when it is wrong', async () => {
    unverified();
    setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: 'sponsor' });

    expect((await sponsorCanCoverFee('[test:cardano]')).ok).toBe(false);
  });
});

describe('the sweep', () => {
  it('refuses on the global verdict even with a network whose staking settings are valid', async () => {
    // The sweep is the one caller that signs without anybody having asked it to, and its own flag
    // reads the network document rather than the deployment's state.
    await seedStakingNetwork();
    recordCardanoDerivationState({ status: 'changed', scope: 'user' });

    const result = await runStakingSync({
      chainId: CARDANO_PREPROD_CHAIN_ID,
      jobName: 'cardano-staking-sync',
      scheduledTime: new Date('2026-09-25T12:00:00.000Z'),
      owner: 'instance-a',
      batchLimit: 10,
      execute: true,
      // Never reached: the refusal is decided before the run is claimed. Passed because the
      // request carries one, and a real object here would be a provider this test could call.
      provider: undefined as unknown as StakingSyncRequest['provider']
    });

    expect(result.status).toBe('failed');
    expect(result.refusal).toBe('staking_disabled');
  });
});

describe('opting in while the settings are not there', () => {
  it('is refused, and leaves the recorded decision to stay out where it was', async () => {
    // No network document, so the staking configuration reports itself off with no terms version.
    // Writing anyway would stamp a consent nobody can identify and clear an opt-out the user asked
    // for, both on the strength of a configuration fault.
    markCardanoDerivationVerified();
    enableCardanoPreprod();
    const user = await UserModel.create({ phone_number: PHONE, wallets: [] });
    const derived = cardanoSignerService.getAccount(PHONE, 'testnet', CARDANO_PREPROD_CHAIN_ID);
    await CardanoStakingAccount.create({
      userId: user._id,
      chainId: CARDANO_PREPROD_CHAIN_ID,
      walletAddress: derived.address,
      stakeCredentialHex: 'aa'.repeat(28),
      rewardAddress: 'stake_test1uq'.padEnd(60, 'q'),
      preference: { enabled: false, version: 1, updatedAt: new Date() },
      optOut: { at: new Date(), reason: 'user_request', source: 'web', preferenceVersion: 1 },
      state: 'awaiting_consent',
      onChain: { registered: false, poolId: null, asOf: new Date() }
    });

    const result = await setStakingConsent(PHONE, true, 'web');

    expect(result).toMatchObject({ ok: false, refusal: 'staking_disabled' });
    const stored = await CardanoStakingAccount.findOne({}).lean();
    expect(stored?.optOut).not.toBeNull();
    expect(stored?.preference.enabled).toBe(false);
    expect(stored?.termsConsent ?? null).toBeNull();
  });
});

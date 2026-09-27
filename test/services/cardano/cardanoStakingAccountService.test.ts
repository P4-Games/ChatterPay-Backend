import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import CardanoStakingAccount from '../../../src/models/cardanoStakingAccountModel';
import { type IUser, type IUserWallet, UserModel } from '../../../src/models/userModel';
import {
  rewardAddress,
  stakeCredentialHex
} from '../../../src/services/cardano/cardanoAddressService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import { ensureStakingAccount } from '../../../src/services/cardano/cardanoStakingAccountService';
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

/**
 * The alta of a staking account.
 *
 * Every field of the row is derived from the wallet, so what these cases are really about is which
 * wallets may have an account at all, and that asking twice does not produce two.
 */

const CHAIN_ID = CARDANO_PREPROD_CHAIN_ID;

/**
 * A Cardano wallet entry, derived so its address and its staking key agree.
 *
 * @param phoneNumber - Whose wallet it is.
 * @param overrides - What differs from a well-formed entry.
 * @returns The entry.
 */
function cardanoWallet(phoneNumber: string, overrides: Partial<IUserWallet> = {}): IUserWallet {
  const derived = cardanoSignerService.getAccount(phoneNumber, 'testnet', CHAIN_ID);
  return {
    wallet_proxy: derived.address,
    wallet_eoa: derived.address,
    created_with_chatterpay_proxy_address: '',
    created_with_factory_address: '',
    chain_id: CHAIN_ID,
    status: 'active',
    address_type: 'cardano_base',
    cardano_public_key: derived.publicKey,
    cardano_stake_public_key: derived.stakePublicKey,
    ...overrides
  } as IUserWallet;
}

/**
 * A user carrying the wallets given.
 *
 * @param phoneNumber - Its phone number.
 * @param wallets - Its wallets.
 * @returns The stored user.
 */
async function seedUser(phoneNumber: string, wallets: IUserWallet[]): Promise<IUser> {
  return UserModel.create({
    phone_number: phoneNumber,
    name: `user-${phoneNumber}`,
    wallets,
    settings: {}
  });
}

beforeEach(async () => {
  enableCardanoPreprod();
  await CardanoStakingAccount.deleteMany({});
  await UserModel.deleteMany({});
});

describe('ensureStakingAccount', () => {
  it('creates the account of a Cardano wallet', async () => {
    const wallet = cardanoWallet('5491100000001');
    const user = await seedUser('5491100000001', [wallet]);

    const outcome = await ensureStakingAccount(user, wallet);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.created).toBe(true);
    expect(outcome.account.walletAddress).toBe(wallet.wallet_proxy);
    expect(outcome.account.chainId).toBe(CHAIN_ID);
  });

  it('keys the account by the wallet own credentials rather than deriving new ones', async () => {
    // The reward address names where rewards accrue. One built from another key is well formed and
    // belongs to somebody else's account, which reads as empty forever.
    const wallet = cardanoWallet('5491100000002');
    const user = await seedUser('5491100000002', [wallet]);

    const outcome = await ensureStakingAccount(user, wallet);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const stakeKey = wallet.cardano_stake_public_key ?? '';
    expect(outcome.account.rewardAddress).toBe(rewardAddress(stakeKey, 'testnet'));
    expect(outcome.account.stakeCredentialHex).toBe(stakeCredentialHex(stakeKey));
  });

  it('creates it neutral, so nobody is enrolled by the alta', async () => {
    // Creating the row makes the position visible. Agreeing to the terms and switching staking on is
    // the user's, and a row written as enabled would enrol somebody who never said yes.
    const wallet = cardanoWallet('5491100000003');
    const user = await seedUser('5491100000003', [wallet]);

    const outcome = await ensureStakingAccount(user, wallet);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.account.state).toBe('awaiting_consent');
    expect(outcome.account.preference.enabled).toBe(false);
    expect(outcome.account.termsConsent).toBeNull();
    expect(outcome.account.onChain.registered).toBe(false);
    expect(outcome.account.depositEconomicOwner).toBe('user');
  });

  it('asked twice, leaves one account', async () => {
    const wallet = cardanoWallet('5491100000004');
    const user = await seedUser('5491100000004', [wallet]);

    const first = await ensureStakingAccount(user, wallet);
    const second = await ensureStakingAccount(user, wallet);

    expect(first.ok && first.created).toBe(true);
    expect(second.ok && second.created).toBe(false);
    expect(await CardanoStakingAccount.countDocuments({ userId: user._id })).toBe(1);
  });

  it('does not touch an account that already exists', async () => {
    // The second call must not reset a position. A user who opted in and got registered would be put
    // back to `awaiting_consent` by an alta that wrote unconditionally.
    const wallet = cardanoWallet('5491100000005');
    const user = await seedUser('5491100000005', [wallet]);
    await ensureStakingAccount(user, wallet);
    await CardanoStakingAccount.updateOne(
      { userId: user._id, chainId: CHAIN_ID },
      { $set: { state: 'active', 'preference.enabled': true } }
    );

    await ensureStakingAccount(user, wallet);

    const stored = await CardanoStakingAccount.findOne({ userId: user._id, chainId: CHAIN_ID });
    expect(stored?.state).toBe('active');
    expect(stored?.preference.enabled).toBe(true);
  });

  it('refuses a wallet of another family', async () => {
    const evm: IUserWallet = {
      wallet_proxy: '0xc17456b51CE6BEbC5fb01869d1403517111dbE02',
      wallet_eoa: '0x2D8bce1F07361EC1571eC7ffad24DeB777d212BB',
      created_with_chatterpay_proxy_address: '',
      created_with_factory_address: '',
      chain_id: 534351,
      status: 'active'
    } as IUserWallet;
    const user = await seedUser('5491100000006', [evm]);

    const outcome = await ensureStakingAccount(user, evm);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('not_cardano');
  });

  it('refuses an entry carrying no staking key', async () => {
    // Without it the reward account cannot be named, and a row without a reward address is a row no
    // withdrawal can ever be built from.
    const wallet = cardanoWallet('5491100000007', { cardano_stake_public_key: '' });
    const user = await seedUser('5491100000007', [wallet]);

    const outcome = await ensureStakingAccount(user, wallet);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('no_stake_public_key');
  });

  it('refuses a staking key that is not the one the address carries', async () => {
    // The inconsistency this catches is a row whose reward account belongs to a different wallet.
    const other = cardanoWallet('5491100000009');
    const wallet = cardanoWallet('5491100000008', {
      cardano_stake_public_key: other.cardano_stake_public_key
    });
    const user = await seedUser('5491100000008', [wallet]);

    const outcome = await ensureStakingAccount(user, wallet);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('credential_mismatch');
  });

  it('refuses an address that is not a base address', async () => {
    const wallet = cardanoWallet('5491100000010', {
      wallet_proxy: 'addr_test1nonsense',
      wallet_eoa: 'addr_test1nonsense'
    });
    const user = await seedUser('5491100000010', [wallet]);

    const outcome = await ensureStakingAccount(user, wallet);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('address_not_base');
  });

  it('refuses a credential another account already holds', async () => {
    // Two accounts on one credential would both claim the same deposit and both try to register it.
    const wallet = cardanoWallet('5491100000011');
    const user = await seedUser('5491100000011', [wallet]);
    const stakeKey = wallet.cardano_stake_public_key ?? '';
    await CardanoStakingAccount.create({
      userId: new Types.ObjectId(),
      chainId: CHAIN_ID,
      walletAddress: wallet.wallet_proxy,
      rewardAddress: rewardAddress(stakeKey, 'testnet'),
      stakeCredentialHex: stakeCredentialHex(stakeKey)
    });

    const outcome = await ensureStakingAccount(user, wallet);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('credential_taken');
    expect(await CardanoStakingAccount.countDocuments({ userId: user._id })).toBe(0);
  });
});

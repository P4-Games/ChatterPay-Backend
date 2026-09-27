/**
 * Where a Cardano staking account comes into existence.
 *
 * The account is a row in `cardano_staking_accounts`, and until it exists the user has no staking at
 * all: the sweep only refreshes accounts it finds, and every read answers `no_staking_account`. So
 * the alta lives here, in one function, and the two callers that need it — provisioning a wallet and
 * the sweep's discovery pass — share it rather than each building the row their own way. Two writers
 * of the same row is how the `rewardAddress` of one and the `stakeCredentialHex` of the other end up
 * derived by different rules.
 *
 * The row is created neutral: `state` is `awaiting_consent` and `preference.enabled` is `false`.
 * Creating it makes the position visible and decides nothing. Opting in is the user's, and a row
 * written as enabled would enrol somebody who never agreed to the terms.
 *
 * Nothing here derives an address. Both credentials come from what `users.wallets[]` already holds,
 * and the staking credential the key produces is checked against the one the wallet's own base
 * address carries. A reward address built from a different key is well formed and belongs to an
 * account this user has nothing to do with: it reads as empty forever and a withdrawal against it is
 * refused, both of which look exactly like "no rewards yet".
 */

import { Logger } from '../../helpers/loggerHelper';
import CardanoStakingAccount, {
  type ICardanoStakingAccount
} from '../../models/cardanoStakingAccountModel';
import type { IUser, IUserWallet } from '../../models/userModel';
import { decodeCardanoAddress, rewardAddress, stakeCredentialHex } from './cardanoAddressService';

/** Why a wallet did not get an account. */
export type StakingAccountRefusal =
  /** The entry is not a Cardano wallet. */
  | 'not_cardano'
  /** The entry carries no chain id, so which network it belongs to is unknown. */
  | 'no_chain_id'
  /** The entry carries no address. */
  | 'no_address'
  /** The address does not decode as a base address, so it has no staking part. */
  | 'address_not_base'
  /** The entry carries no staking public key, so the reward account cannot be named. */
  | 'no_stake_public_key'
  /** The staking key does not produce the credential the address carries. */
  | 'credential_mismatch'
  /** Another account on this network already holds this staking credential. */
  | 'credential_taken';

export type StakingAccountOutcome =
  | { ok: true; created: boolean; account: ICardanoStakingAccount }
  | { ok: false; refusal: StakingAccountRefusal; detail: string };

/**
 * The two credentials a staking account is keyed by, read off one wallet entry.
 *
 * @param wallet - The entry from `users.wallets[]`.
 * @returns The address, the reward address and the staking credential, or why the entry cannot have
 *   an account.
 */
function credentialsOf(
  wallet: IUserWallet
): { walletAddress: string; reward: string; credential: string } | StakingAccountRefusal {
  if (wallet.address_type !== 'cardano_base') return 'not_cardano';
  if (typeof wallet.chain_id !== 'number') return 'no_chain_id';

  const walletAddress = wallet.wallet_proxy || wallet.wallet_eoa || '';
  if (walletAddress === '') return 'no_address';

  const decoded = decodeCardanoAddress(walletAddress);
  if (decoded === null || decoded.stakeCredentialHex === undefined) return 'address_not_base';

  const stakePublicKey = wallet.cardano_stake_public_key ?? '';
  if (stakePublicKey === '') return 'no_stake_public_key';

  let credential: string;
  let reward: string;
  try {
    credential = stakeCredentialHex(stakePublicKey);
    reward = rewardAddress(stakePublicKey, decoded.network);
  } catch {
    // A key of the wrong size. Unusable and indistinguishable from a key belonging to somebody else,
    // so it is refused rather than worked around.
    return 'credential_mismatch';
  }

  // The network comes from the address rather than from the chain id: the address is what the funds
  // are at, and a row keyed to the other network would name a reward account on a chain the user has
  // nothing on.
  if (credential !== decoded.stakeCredentialHex) return 'credential_mismatch';

  return { walletAddress, reward, credential };
}

/**
 * The staking account of one wallet, creating it when it does not exist yet.
 *
 * Idempotent, and safe to call on every operation: an account that exists is returned untouched. The
 * write is an upsert with `$setOnInsert`, so a concurrent caller that got there first wins and this
 * one reads what they wrote — which is the same row either way, since every field is derived.
 *
 * @param user - The wallet's owner.
 * @param wallet - The `cardano_base` entry from `users.wallets[]`.
 * @returns The account, or why the wallet cannot have one.
 */
export async function ensureStakingAccount(
  user: IUser,
  wallet: IUserWallet
): Promise<StakingAccountOutcome> {
  const credentials = credentialsOf(wallet);
  if (typeof credentials === 'string') {
    return { ok: false, refusal: credentials, detail: `wallet ${wallet.wallet_proxy ?? '(none)'}` };
  }

  const chainId = wallet.chain_id;
  const userId = user._id;
  const existing = await CardanoStakingAccount.findOne({ userId, chainId }).exec();
  if (existing !== null) return { ok: true, created: false, account: existing };

  // The collection's other unique index is `{ chainId, stakeCredentialHex }`. Two accounts sharing a
  // credential would both claim the same deposit and both try to register it, so the collision is
  // reported with whose account holds it rather than surfacing as a duplicate-key error nobody can
  // act on.
  const holder = await CardanoStakingAccount.findOne({
    chainId,
    stakeCredentialHex: credentials.credential
  }).exec();
  if (holder !== null && String(holder.userId) !== String(userId)) {
    return {
      ok: false,
      refusal: 'credential_taken',
      detail: `credential held by account ${String(holder._id)}`
    };
  }

  const now = new Date();
  await CardanoStakingAccount.updateOne(
    { userId, chainId },
    {
      $setOnInsert: {
        userId,
        chainId,
        walletAddress: credentials.walletAddress,
        rewardAddress: credentials.reward,
        stakeCredentialHex: credentials.credential,
        termsConsent: null,
        preference: { enabled: false, version: 0, updatedAt: now },
        optOut: null,
        state: 'awaiting_consent',
        onChain: {
          registered: false,
          poolId: null,
          governanceDelegation: null,
          depositLovelace: null,
          registrationOrigin: 'unknown',
          withdrawableRewardsLovelace: '0',
          pendingRewardsLovelace: '0',
          lifetimeRewardsLovelace: '0',
          historicalCompleteness: 'partial',
          asOf: null
        },
        depositEconomicOwner: 'user',
        financingMode: null,
        currentLifecycleId: null,
        lastPositiveBalanceAt: null,
        lastObservedAt: null,
        lastSyncAt: null,
        lastError: null,
        autoEnrollSuspendedReason: null
      }
    },
    { upsert: true }
  ).exec();

  const account = await CardanoStakingAccount.findOne({ userId, chainId }).exec();
  if (account === null) {
    // The upsert reported no error and the row is not there. Nothing sensible follows from that, and
    // inventing a return value would hand the caller an account that does not exist.
    return { ok: false, refusal: 'credential_taken', detail: 'the account could not be read back' };
  }

  Logger.log(
    'ensureStakingAccount',
    `Cardano staking account created for ${user.phone_number} on ${chainId}: ${credentials.reward}`
  );
  return { ok: true, created: true, account };
}

/**
 * Creates the staking account of a wallet without ever failing the caller.
 *
 * For the paths whose job is something else — provisioning a wallet, running a transfer. Staking is
 * not what they were asked to do, and a row that could not be written is a reason to log, not a
 * reason to fail an operation the user is waiting on. The next call creates it.
 *
 * @param user - The wallet's owner.
 * @param wallet - The `cardano_base` entry.
 * @returns Whether an account was created.
 */
export async function ensureStakingAccountQuietly(
  user: IUser,
  wallet: IUserWallet
): Promise<boolean> {
  try {
    const outcome = await ensureStakingAccount(user, wallet);
    if (!outcome.ok) {
      Logger.warn(
        'ensureStakingAccountQuietly',
        `No staking account for ${user.phone_number}: ${outcome.refusal} (${outcome.detail})`
      );
      return false;
    }
    return outcome.created;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    Logger.error(
      'ensureStakingAccountQuietly',
      `Could not create the staking account for ${user.phone_number}: ${detail}`
    );
    return false;
  }
}

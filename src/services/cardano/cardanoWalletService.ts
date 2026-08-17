/**
 * Cardano wallets: derived, then remembered.
 *
 * The derivation is the source of truth and the database is a cache of it. That inversion is not
 * how the EVM side works, and it is what Cardano's account model buys: an address is a pure
 * function of a public key (CIP-19), so it exists and can receive funds before anything is written
 * anywhere. Nothing here performs a chain call, and provisioning a wallet costs one Mongo write and
 * no gas.
 *
 * The practical consequence is the one that matters for transfers: **a recipient who has never used
 * Cardano still has a Cardano address**, so sending to a phone number works the first time, without
 * asking them to do anything first.
 *
 * @see CARDANO_INTEGRATION_PLAN.md §6.1
 */

import { getCardanoConfig } from '../../config/cardanoConfig';
import { getPhoneNumberFormatted } from '../../helpers/formatHelper';
import { Logger } from '../../helpers/loggerHelper';
import { type IUser, type IUserWallet, UserModel } from '../../models/userModel';
import type { CardanoAccount } from '../../types/cardanoType';
import { getUserWalletByChainId } from '../userService';
import { cardanoSignerService, derivationFingerprint } from './cardanoSignerService';

/** A user's Cardano wallet, as the rest of the code needs it. */
export interface CardanoWallet {
  /** Bech32 address on the configured network. */
  address: string;
  /** Raw Ed25519 public key, hex with `0x`. */
  publicKey: string;
  /** Whether this call is what persisted it. */
  wasCreated: boolean;
}

/**
 * The Cardano account a phone number resolves to, without touching the database.
 *
 * @param phoneNumber - The user's phone number, in any accepted format.
 * @returns The derived account.
 */
export function deriveCardanoAccount(phoneNumber: string): CardanoAccount {
  const { network, chainId } = getCardanoConfig();
  return cardanoSignerService.getAccount(phoneNumber, network, chainId);
}

/**
 * Builds the `wallets[]` entry for a Cardano account.
 *
 * `wallet_proxy` and `wallet_eoa` both carry the bech32 address on purpose. There is no proxy and
 * no EOA here — but every existing reader in the product (bot, dashboard, balance, notifications)
 * reaches for `wallet_proxy`, and giving them an address they can display is what keeps this from
 * being a change that ripples through all of them.
 *
 * @param account - The derived account.
 * @param chainId - Internal chain id of the Cardano network.
 * @returns The wallet entry to persist.
 */
function walletEntryFor(account: CardanoAccount, chainId: number): IUserWallet {
  return {
    wallet_proxy: account.address,
    wallet_eoa: account.address,
    created_with_chatterpay_proxy_address: '',
    created_with_factory_address: '',
    chain_id: chainId,
    status: 'active',
    address_type: 'cardano_base',
    cardano_public_key: account.publicKey,
    cardano_stake_public_key: account.stakePublicKey
  };
}

/**
 * The Cardano wallet of an existing user, provisioning it on first use.
 *
 * Idempotent, and safe to call on every transfer: the address is derived either way, so the write
 * only records what was already true.
 *
 * @param user - The user document. Mutated and saved when a wallet is added.
 * @returns The wallet.
 * @throws Error `CARDANO_ADDRESS_MISMATCH` when the stored address is not the one this deployment's
 *   keys derive. That means the seed changed, or the row was written by a different deployment —
 *   either way the funds are at an address these keys cannot sign for, and continuing would build a
 *   transaction nobody can authorise.
 */
export async function ensureCardanoWalletForUser(user: IUser): Promise<CardanoWallet> {
  const { chainId, network } = getCardanoConfig();
  const account = deriveCardanoAccount(user.phone_number);
  const existing = getUserWalletByChainId(user.wallets, chainId);

  if (existing) {
    if (existing.wallet_proxy !== account.address) {
      // The fingerprint is what makes this actionable: the address is a pure function of the
      // derivation inputs, so a mismatch means one of them changed, and naming them turns "why is
      // this address different" into one line instead of a bisection.
      throw new Error(
        `CARDANO_ADDRESS_MISMATCH: stored ${existing.wallet_proxy}, derived ${account.address}, ` +
          `inputs ${derivationFingerprint()} network(${network}) chainId(${chainId})`
      );
    }
    return { address: account.address, publicKey: account.publicKey, wasCreated: false };
  }

  // An atomic append rather than `user.save()`.
  //
  // The document handed to this function is often minutes old by the time it gets here: a transfer
  // loads the user, then takes the operation lock and runs the security gate, and both of those
  // write. Saving the stale copy fails Mongoose's optimistic concurrency check with a `VersionError`
  // — which is what a transfer used to die on, after having already opened the lock.
  //
  // The filter is the idempotency: if a concurrent request added the wallet first, it matches
  // nothing and nothing happens, which is the same outcome as the branch above. There is no
  // conflict to resolve because the value being written is derived, so both writers would have
  // written the same entry.
  const entry = walletEntryFor(account, chainId);
  await UserModel.updateOne(
    { phone_number: user.phone_number, 'wallets.chain_id': { $ne: chainId } },
    { $push: { wallets: entry } }
  );
  // The caller keeps using this document, so the in-memory copy has to agree with the database.
  if (!getUserWalletByChainId(user.wallets, chainId)) user.wallets.push(entry);

  Logger.log(
    'ensureCardanoWalletForUser',
    `Cardano wallet provisioned for ${user.phone_number}: ${account.address}`
  );

  return { address: account.address, publicKey: account.publicKey, wasCreated: true };
}

/**
 * The Cardano wallet of a phone number, creating the user when there is none.
 *
 * The user this creates carries only what Cardano needs. It is deliberately not routed through
 * `createUserWithWallet`, which computes an ERC-4337 proxy address and registers it with Alchemy:
 * a Cardano-only recipient has no EVM wallet to provision, and doing it anyway would create an
 * account on a network they never asked for.
 *
 * @param phoneNumber - The recipient's phone number.
 * @returns The user and their Cardano wallet.
 */
export async function getOrCreateCardanoWallet(
  phoneNumber: string
): Promise<{ user: IUser; wallet: CardanoWallet }> {
  const formatted = getPhoneNumberFormatted(phoneNumber);
  let user = await UserModel.findOne({ phone_number: formatted });

  if (!user) {
    const { chainId } = getCardanoConfig();
    const account = deriveCardanoAccount(formatted);
    Logger.log(
      'getOrCreateCardanoWallet',
      `Phone ${formatted} not registered, creating with Cardano wallet ${account.address}`
    );
    user = new UserModel({
      phone_number: formatted,
      wallets: [walletEntryFor(account, chainId)],
      creationDate: new Date()
    });
    await user.save();
    return {
      user,
      wallet: { address: account.address, publicKey: account.publicKey, wasCreated: true }
    };
  }

  return { user, wallet: await ensureCardanoWalletForUser(user) };
}

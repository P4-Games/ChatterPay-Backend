/**
 * Whether this deployment can actually sign for a stake credential, and with which keys.
 *
 * The distinction this module exists to make is between an operation the *protocol* would accept and
 * one this backend can *produce*. They are not the same question, and conflating them is how a user
 * gets offered a button that cannot work.
 *
 * On Cardano a credential belongs to a key, not to whoever is reading it. A wallet can therefore be
 * registered, delegated, earning rewards and perfectly legible — every read succeeds, the snapshot
 * is complete, the ledger rules are satisfied — while the keys that control it exist nowhere this
 * process can reach. That is not an exotic case: it is any address a user brought from another
 * wallet. Addresses here are derived from the user's phone number under a deployment secret, so the
 * only credentials this backend can witness are the ones it derived itself.
 *
 * So reading is unconditional and mutating is not. An external wallet is observed, displayed and
 * reasoned about like any other; what it does not get is an executable plan. The alternative —
 * deciding an action is available because the chain would allow it, then discovering at signing time
 * that there is no key — fails after an operation row exists, after inputs are claimed and possibly
 * after a fee budget is charged, and it fails identically every time it is retried.
 *
 * Nothing here signs. It answers whether signing is possible and hands back the material a signer
 * needs, so that the check is made once, early, and in one place.
 */

import { getCardanoConfig } from '../../config/cardanoConfig';
import { getCardanoFeeConfig } from '../../config/cardanoFeeConfig';
import type { ICardanoStakingAccount } from '../../models/cardanoStakingAccountModel';
import type { IUser } from '../../models/userModel';
import type { CardanoAccount } from '../../types/cardanoType';
import { stakeCredentialHex } from './cardanoAddressService';
import { cardanoSignerService } from './cardanoSignerService';

/** Why this deployment cannot sign for a credential. */
export type StakingSignerUnavailableReason =
  /** The Cardano family is off, so no key material is resolvable at all. */
  | 'cardano_disabled'
  /** The account belongs to a different network than this deployment serves. */
  | 'network_mismatch'
  /** Derivation failed outright — a missing or unusable secret. */
  | 'derivation_failed'
  /**
   * The keys derive a different address than the account records.
   *
   * The address is a pure function of the phone number and the deployment secret, so this means one
   * of them changed or the row was written elsewhere. Either way the funds sit at an address these
   * keys do not control.
   */
  | 'address_mismatch'
  /**
   * The address matches and the stake credential does not.
   *
   * Only reachable for a row written by hand or by an older derivation, and worth its own reason
   * because the certificates address the credential while the inputs come from the address: half a
   * match produces a transaction that spends correctly and certifies nothing.
   */
  | 'credential_mismatch';

/** The keys a staking transaction is witnessed by, when they exist. */
export interface StakingSignerMaterial {
  /** The user's derived account: payment key, stake key, address and address bytes. */
  user: CardanoAccount;
  /** The phone number the derivation is bound to, for the signer that needs it again. */
  phoneNumber: string;
}

export type StakingSignerAvailability =
  | { available: true; material: StakingSignerMaterial }
  | { available: false; reason: StakingSignerUnavailableReason; detail: string };

/** Why the sponsor cannot pay, when it cannot. */
export type StakingSponsorUnavailableReason =
  /** Sponsorship is switched off, or no sponsor wallet is configured. */
  | 'sponsor_disabled'
  /** The sponsor account could not be derived. */
  | 'derivation_failed';

export type StakingSponsorAvailability =
  | { available: true; account: CardanoAccount; walletId: string }
  | { available: false; reason: StakingSponsorUnavailableReason; detail: string };

/**
 * Whether this deployment holds the keys for an account's credential.
 *
 * Read-only and cheap: three derivations and two comparisons, no chain and no database. Meant to be
 * called on the way into any mutating path, and deliberately not called on a read path.
 *
 * @param account - The staking account, carrying the address and credential as recorded.
 * @param user - The user it belongs to, whose phone number the derivation is bound to.
 * @returns Availability, with the reason and a diagnosable detail when it refuses.
 */
export function stakingSignerFor(
  account: ICardanoStakingAccount,
  user: IUser
): StakingSignerAvailability {
  const config = getCardanoConfig();
  if (!config.enabled) {
    return {
      available: false,
      reason: 'cardano_disabled',
      detail: config.disabledReason || 'disabled'
    };
  }

  // Checked before deriving anything. The derivation is bound to a chain id, so deriving against
  // this deployment's network and comparing with an account on another one would compare two
  // unrelated credentials and report a mismatch that says nothing.
  if (account.chainId !== config.chainId) {
    return {
      available: false,
      reason: 'network_mismatch',
      detail: `account chainId ${account.chainId}, deployment ${config.chainId}`
    };
  }

  let derived: CardanoAccount;
  try {
    derived = cardanoSignerService.getAccount(user.phone_number, config.network, config.chainId);
  } catch (error) {
    return {
      available: false,
      reason: 'derivation_failed',
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  if (derived.address !== account.walletAddress) {
    // The two addresses stay out of the detail. They are diagnosable from the account row and the
    // user row, and this string travels into refusals that reach a user.
    return {
      available: false,
      reason: 'address_mismatch',
      detail: 'derived address does not match the address on the account'
    };
  }

  if (stakeCredentialHex(derived.stakePublicKey) !== account.stakeCredentialHex) {
    return {
      available: false,
      reason: 'credential_mismatch',
      detail: 'derived stake credential does not match the credential on the account'
    };
  }

  return { available: true, material: { user: derived, phoneNumber: user.phone_number } };
}

/**
 * The sponsor account that pays the network fee, when there is one.
 *
 * Separate from the user's signer because the two fail independently and for unrelated reasons: a
 * user's keys can be absent while the sponsor is perfectly healthy, and a sponsor can be switched
 * off across a deployment that signs for every user it has.
 *
 * @returns Availability, with the derived account when it is usable.
 */
export function stakingSponsorFor(): StakingSponsorAvailability {
  const config = getCardanoConfig();
  const feeConfig = getCardanoFeeConfig();

  if (!config.enabled) {
    return {
      available: false,
      reason: 'sponsor_disabled',
      detail: config.disabledReason || 'disabled'
    };
  }
  if (!feeConfig.sponsorNetworkFee) {
    return {
      available: false,
      reason: 'sponsor_disabled',
      detail: feeConfig.disabledReason || 'sponsorship off'
    };
  }

  try {
    const account = cardanoSignerService.getSponsorAccount(
      feeConfig.sponsorWalletId,
      config.network,
      config.chainId
    );
    return { available: true, account, walletId: feeConfig.sponsorWalletId };
  } catch (error) {
    return {
      available: false,
      reason: 'derivation_failed',
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * A signer over the user's payment and stake keys plus the sponsor's payment key.
 *
 * Built from material this module has already verified, so it cannot be constructed for a credential
 * this deployment does not control. Every staking transaction needs at least the stake key — the
 * certificates address that credential — and every sponsored one needs the sponsor's payment key;
 * the user's payment key is needed whenever the transaction spends one of their outputs, which is
 * all of them except a pure withdrawal paid entirely by the sponsor.
 *
 * Witnesses are returned for every key that could be required rather than only the ones a given body
 * turns out to need. A superfluous witness is accepted by the ledger; a missing one is not, and the
 * fee was already computed from a witness count.
 *
 * @param material - The user's verified derivation.
 * @param sponsorWalletId - The sponsor wallet, or `null` when the transaction is unsponsored.
 * @returns A signer for {@link executeStakingOperation}.
 */
export function stakingSignerOver(
  material: StakingSignerMaterial,
  sponsorWalletId: string | null
): { witnessesFor(transactionId: string): { publicKey: string; signature: string }[] } {
  const { network, chainId } = getCardanoConfig();

  return {
    witnessesFor(transactionId: string) {
      const witnesses = [
        {
          publicKey: material.user.publicKey,
          signature: cardanoSignerService.sign(
            material.phoneNumber,
            network,
            chainId,
            transactionId
          )
        },
        {
          publicKey: material.user.stakePublicKey,
          signature: cardanoSignerService.signAsStake(
            material.phoneNumber,
            network,
            chainId,
            transactionId
          )
        }
      ];

      if (sponsorWalletId !== null) {
        const sponsor = cardanoSignerService.getSponsorAccount(sponsorWalletId, network, chainId);
        witnesses.push({
          publicKey: sponsor.publicKey,
          signature: cardanoSignerService.signAsSponsor(
            sponsorWalletId,
            network,
            chainId,
            transactionId
          )
        });
      }

      return witnesses;
    }
  };
}

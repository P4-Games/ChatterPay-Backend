/**
 * Polymarket Account Service
 *
 * Manages Polymarket account lifecycle: creation, terms acceptance, and status.
 *
 * @see https://docs.polymarket.com/api-reference/authentication
 */

import { POLYMARKET_TERMS_VERSION } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import { PolymarketTermsModel } from '../../models/polymarketModel';
import type { IUser } from '../../models/userModel';
import { UserModel } from '../../models/userModel';
import { encryptApiCredentials, getOrCreateApiCredentials } from './polymarketClientService';
import { deployDepositWallet, setupDepositWalletApprovals } from './polymarketRelayerService';

const LOG_PREFIX = 'polymarketAccountService';

// ============================================================================
// Account Creation
// ============================================================================

/**
 * Create a Polymarket account for a user.
 * Derives the Polygon address from the user's EOA key,
 * creates CLOB API credentials, encrypts them, and stores in MongoDB.
 *
 * Also sets up gasless trading via the Polymarket Relayer:
 * - Deploys a Safe wallet for the user (if not already deployed)
 * - Approves USDC.e for CTF Exchange and Neg Risk CTF Exchange
 *
 * @param user - User document
 * @param privateKey - User's EOA private key
 * @returns Updated user document
 */
export async function createPolymarketAccount(
  user: IUser,
  privateKey: string,
  logKey: string
): Promise<IUser> {
  const fnLog = `[${LOG_PREFIX}:createPolymarketAccount]`;

  if (user.polymarket_account) {
    Logger.log('info', fnLog, `${logKey} User already has a Polymarket account`);
    return user;
  }

  try {
    Logger.log('info', fnLog, `${logKey} Creating Polymarket account`);

    // 1. Deploy deposit wallet and set approvals (gasless, no MATIC/POL required)
    const { address: depositWalletAddress } = await deployDepositWallet(privateKey, logKey);
    await setupDepositWalletApprovals(privateKey, depositWalletAddress, logKey);

    // 2. Create/derive API credentials — signed by EOA (L1), not the deposit wallet
    const credentials = await getOrCreateApiCredentials(privateKey);

    // 3. Encrypt credentials
    const encryptedCreds = encryptApiCredentials(credentials);

    // Update user document
    const updatedUser = await UserModel.findByIdAndUpdate(
      user._id,
      {
        $set: {
          polymarket_account: {
            polygon_address: depositWalletAddress,
            api_credentials_encrypted: encryptedCreds,
            terms_accepted_version: 0,
            terms_accepted_at: null,
            created_at: new Date(),
            wallet_type: 'deposit'
          }
        }
      },
      { new: true }
    );

    if (!updatedUser) {
      throw new Error('Failed to update user with Polymarket account');
    }

    Logger.log('info', fnLog, `${logKey} Polymarket account created for ${depositWalletAddress}`);
    return updatedUser;
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to create Polymarket account: ${String(error)}`);
  }
}

// ============================================================================
// Account Status
// ============================================================================

/**
 * Get the status of a user's Polymarket account.
 */
export function getAccountStatus(user: IUser): {
  has_account: boolean;
  polygon_address: string | null;
  terms_accepted: boolean;
  terms_current_version: number;
  terms_accepted_version: number | null;
} {
  const currentVersion = POLYMARKET_TERMS_VERSION;
  const account = user.polymarket_account;

  if (!account) {
    return {
      has_account: false,
      polygon_address: null,
      terms_accepted: false,
      terms_current_version: currentVersion,
      terms_accepted_version: null
    };
  }

  return {
    has_account: true,
    polygon_address: account.polygon_address,
    terms_accepted: account.terms_accepted_version >= currentVersion,
    terms_current_version: currentVersion,
    terms_accepted_version: account.terms_accepted_version
  };
}

// ============================================================================
// Terms & Conditions
// ============================================================================

/**
 * Accept the current terms version.
 */
export async function acceptTerms(user: IUser, version: number, logKey: string): Promise<IUser> {
  const fnLog = `[${LOG_PREFIX}:acceptTerms]`;

  if (!user.polymarket_account) {
    throw new Error('User does not have a Polymarket account');
  }

  if (version !== POLYMARKET_TERMS_VERSION) {
    throw new Error(`Terms version mismatch: expected ${POLYMARKET_TERMS_VERSION}, got ${version}`);
  }

  try {
    const updatedUser = await UserModel.findByIdAndUpdate(
      user._id,
      {
        $set: {
          'polymarket_account.terms_accepted_version': version,
          'polymarket_account.terms_accepted_at': new Date()
        }
      },
      { new: true }
    );

    if (!updatedUser) {
      throw new Error('Failed to update terms acceptance');
    }

    Logger.log('info', fnLog, `${logKey} Terms v${version} accepted`);
    return updatedUser;
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to accept terms: ${String(error)}`);
  }
}

/**
 * Check if user has accepted the current terms version.
 */
export function hasAcceptedCurrentTerms(user: IUser): boolean {
  if (!user.polymarket_account) return false;
  return user.polymarket_account.terms_accepted_version >= POLYMARKET_TERMS_VERSION;
}

/**
 * Get the current terms content from DB.
 */
export async function getCurrentTerms(logKey: string): Promise<{
  version: number;
  content: string;
  effective_date: Date;
} | null> {
  const fnLog = `[${LOG_PREFIX}:getCurrentTerms]`;

  try {
    const terms = await PolymarketTermsModel.findOne({ version: POLYMARKET_TERMS_VERSION });

    if (!terms) {
      Logger.log('warn', fnLog, `${logKey} No terms found for version ${POLYMARKET_TERMS_VERSION}`);
      return null;
    }

    return {
      version: terms.version,
      content: terms.content,
      effective_date: terms.effective_date
    };
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to fetch terms: ${String(error)}`);
  }
}

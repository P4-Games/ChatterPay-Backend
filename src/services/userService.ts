import { Logger } from '../helpers/loggerHelper';
import { User, IUser, IUserWallet } from '../models/user';
import { ConcurrentOperationsEnum } from '../types/common';
import { getPhoneNumberFormatted } from '../helpers/formatHelper';
import { ComputedAddress, computeProxyAddressFromPhone } from './predictWalletService';
import { DEFAULT_CHAIN_ID, SETTINGS_NOTIFICATION_LANGUAGE_DFAULT } from '../config/constants';
import { subscribeToPushChannel, sendWalletCreationNotification } from './notificationService';

/**
 * Creates a new user and wallet for the given phone number.
 * @param {string} phoneNumber - The phone number to create the wallet for.
 * @param {string} chatterpayImplementation - The chatterpay Smart Contract Address.
 * @returns {Promise<IUser>} The user with the newly created wallet.
 */
export const createUserWithWallet = async (
  phoneNumber: string,
  chatterpayImplementation: string
): Promise<IUser> => {
  const predictedWallet: ComputedAddress = await computeProxyAddressFromPhone(phoneNumber);
  const formattedPhoneNumber = getPhoneNumberFormatted(phoneNumber);

  const user = new User({
    phone_number: formattedPhoneNumber,
    wallets: [
      {
        wallet_proxy: predictedWallet.proxyAddress,
        wallet_eoa: predictedWallet.EOAAddress,
        sk_hashed: predictedWallet.privateKey,
        chatterpay_implementation_address: chatterpayImplementation,
        chain_id: DEFAULT_CHAIN_ID,
        status: 'active'
      }
    ],
    creationDate: new Date(),
    code: null,
    photo: '/assets/images/avatars/generic_user.jpg',
    email: null,
    name: null,
    settings: {
      notifications: {
        language: SETTINGS_NOTIFICATION_LANGUAGE_DFAULT
      }
    },
    operations_in_progress: {
      transfer: 0,
      swap: 0,
      mint_nft: 0,
      mint_nft_copy: 0,
      withdraw_all: 0
    }
  });

  await user.save();

  Logger.log('Push protocol', phoneNumber, predictedWallet.EOAAddress);
  await subscribeToPushChannel(predictedWallet.privateKeyNotHashed, predictedWallet.EOAAddress);
  sendWalletCreationNotification(predictedWallet.EOAAddress, phoneNumber); // avoid await

  return user;
};

/**
 * Adds a new wallet to an existing user for a given chain_id.
 * @param {string} phoneNumber - The phone number of the user to add the wallet to.
 * @param {number} chainId - The chain_id to associate with the new wallet.
 * @param {string} chatterpayImplementationAddress - The address of the chatterpay implementation Contract.
 * @returns {Promise<{ user: IUser, newWallet: any } | null>} The updated user with the new wallet and the newly created wallet object.
 */
export const addWalletToUser = async (
  phoneNumber: string,
  chainId: number,
  chatterpayImplementationAddress: string
): Promise<{ user: IUser; newWallet: IUserWallet } | null> => {
  // Generate wallet details based on phone number
  const predictedWallet: ComputedAddress = await computeProxyAddressFromPhone(phoneNumber);
  const formattedPhoneNumber = getPhoneNumberFormatted(phoneNumber);

  // Find the user by phone number
  const user = await User.findOne({ phone_number: formattedPhoneNumber });

  if (!user) {
    Logger.error(`User not found for phone number: ${phoneNumber}`);
    return null;
  }

  // Check if the wallet for the given chain_id already exists
  const existingWallet = user.wallets.find((wallet) => wallet.chain_id === chainId);
  if (existingWallet) {
    Logger.log(`Wallet already exists for chain_id ${chainId} for user ${phoneNumber}`);
    return { user, newWallet: existingWallet };
  }

  // Create a new wallet object
  const newWallet = {
    wallet_proxy: predictedWallet.proxyAddress,
    wallet_eoa: predictedWallet.EOAAddress,
    sk_hashed: predictedWallet.privateKey,
    chatterpay_implementation_address: chatterpayImplementationAddress,
    chain_id: chainId,
    status: 'active'
  };

  // Add the new wallet to the user's wallet array
  user.wallets.push(newWallet);

  // Save the updated user
  await user.save();

  Logger.log(`New wallet added for user ${phoneNumber} with chain_id ${chainId}`);

  return { user, newWallet };
};

/**
 * Filters wallets by chain_id and returns the first match.
 *
 * @param wallets - The array of wallet objects to filter.
 * @param chainId - The chain_id to filter the wallets by.
 * @returns The first wallet that matches the given chain_id, or null if not found.
 */
export const getUserWalletByChainId = (
  wallets: IUserWallet[],
  chainId: number
): IUserWallet | null => {
  const wallet = wallets.find((w) => w.chain_id === chainId);
  return wallet || null;
};

/**
 * Retrieves the first user that has the specified wallet address for the given chain_id.
 * @param {string} wallet - The wallet address to search for.
 * @param {number} chainId - The chain_id to filter the wallet.
 * @returns {Promise<IUser | null>} The user who owns the wallet on the specified chain, or null if no user is found.
 */
export const getUserByWalletAndChainid = async (
  wallet: string,
  chainId: number
): Promise<IUser | null> => {
  // Find a user who has the provided wallet and chain_id inside the 'wallets' array
  const user: IUser | null = await User.findOne({
    'wallets.wallet_proxy': wallet, // Ensure the wallet search is case-insensitive
    'wallets.chain_id': chainId // Filter by chain_id to find the correct user
  });
  return user;
};

/**
 * Get a wallet from a user based on their phone number and chain_id.
 *
 * @param phoneNumber - The phone number of the user.
 * @param chainId - The chain_id of the wallet to be retrieved.
 * @returns A wallet object if found, or null if not found.
 */
export const getUserWallet = async (
  phoneNumber: string,
  chainId: number
): Promise<IUserWallet | null> => {
  const user: IUser | null = await User.findOne({
    phone_number: getPhoneNumberFormatted(phoneNumber)
  });

  if (!user) {
    return null;
  }

  const wallet = user.wallets.find((w) => w.chain_id === chainId);

  return wallet || null;
};

/**
 * Gets user based on the phone number.
 */
export const getUser = async (phoneNumber: string): Promise<IUser | null> => {
  const user: IUser | null = await User.findOne({
    phone_number: getPhoneNumberFormatted(phoneNumber)
  });
  return user;
};

/**
 * Gets or creates a user based on the phone number.
 */
export const getOrCreateUser = async (
  phoneNumber: string,
  chatterpayImplementation: string
): Promise<IUser> => {
  const user = await getUser(phoneNumber);

  if (user) return user;
  Logger.log(`Phone number ${phoneNumber} not registered in ChatterPay, registering...`);

  const newUser: IUser = await createUserWithWallet(phoneNumber, chatterpayImplementation);
  Logger.log(
    `Phone number ${phoneNumber} registered with the wallet ${newUser.wallets[0].wallet_proxy}`
  );

  return newUser;
};

export const hasPhoneOperationInProgress = async (
  phoneNumber: string,
  operation: ConcurrentOperationsEnum
): Promise<number> => {
  const user = await User.findOne({ phone_number: getPhoneNumberFormatted(phoneNumber) });
  return user?.operations_in_progress?.[operation] || 0;
};

export const hasUserOperationInProgress = (
  user: IUser,
  operation: ConcurrentOperationsEnum
): boolean => (user.operations_in_progress?.[operation] || 0) > 0;

export const openOperation = (
  phoneNumber: string,
  operation: ConcurrentOperationsEnum
): Promise<void> => updateOperationCount(phoneNumber, operation, 1);

export const closeOperation = (
  phoneNumber: string,
  operation: ConcurrentOperationsEnum
): Promise<void> => updateOperationCount(phoneNumber, operation, -1);

const updateOperationCount = async (
  phoneNumber: string,
  operation: ConcurrentOperationsEnum,
  increment: number
): Promise<void> => {
  const user: IUser | null = await User.findOne({
    phone_number: getPhoneNumberFormatted(phoneNumber)
  });

  if (user && user.operations_in_progress) {
    const currentCount = user.operations_in_progress[operation] || 0;
    user.operations_in_progress[operation] = Math.max(currentCount + increment, 0);
    await user.save();
  }
};

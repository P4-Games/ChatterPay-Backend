import { Logger } from '../helpers/loggerHelper';
import { User, IUser, IUserWallet } from '../models/user';
import { ConcurrentOperationsEnum } from '../types/common';
import { getPhoneNumberFormatted } from '../helpers/formatHelper';
import { ComputedAddress, computeProxyAddressFromPhone } from './predictWalletService';
import { DEFAULT_CHAIN_ID, SETTINGS_NOTIFICATION_LANGUAGE_DFAULT } from '../config/constants';
import { subscribeToPushChannel, sendWalletCreationNotification } from './notificationService';

/**
 * Creates a new user with a wallet for the given phone number.
 * This function handles user creation, wallet generation, and push notifications.
 *
 * @param {string} phoneNumber - The phone number to create the wallet for.
 * @param {string} chatterpayImplementation - The address of the chatterpay smart contract.
 * @returns {Promise<IUser>} The newly created user with the wallet.
 */
export const createUserWithWallet = async (
  phoneNumber: string,
  chatterpayImplementation: string
): Promise<IUser> => {
  const formattedPhoneNumber = getPhoneNumberFormatted(phoneNumber); // Format phone number
  const predictedWallet: ComputedAddress = await computeProxyAddressFromPhone(formattedPhoneNumber); // Generate wallet based on phone number

  // Create new user with a single wallet
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
        language: SETTINGS_NOTIFICATION_LANGUAGE_DFAULT // Set default notification language
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

  // Save the user to the database
  await user.save();

  Logger.log('createUserWithWallet', 'Push protocol', phoneNumber, predictedWallet.EOAAddress);
  await subscribeToPushChannel(predictedWallet.privateKeyNotHashed, predictedWallet.EOAAddress); // Subscribe to push notifications
  sendWalletCreationNotification(predictedWallet.EOAAddress, phoneNumber); // Send notification about wallet creation (no need to await)

  return user; // Return the newly created user
};

/**
 * Adds a new wallet to an existing user for a given chain_id.
 * This function creates a new wallet and adds it to the user's wallet list if not already present.
 *
 * @param {string} phoneNumber - The phone number of the user to add the wallet to.
 * @param {number} chainId - The chain_id to associate with the new wallet.
 * @param {string} chatterpayImplementationAddress - The address of the chatterpay smart contract.
 * @returns {Promise<{ user: IUser, newWallet: IUserWallet } | null>} The updated user with the new wallet or null if the wallet already exists.
 */
export const addWalletToUser = async (
  phoneNumber: string,
  chainId: number,
  chatterpayImplementationAddress: string
): Promise<{ user: IUser; newWallet: IUserWallet } | null> => {
  const formattedPhoneNumber = getPhoneNumberFormatted(phoneNumber); // Format the phone number
  const predictedWallet: ComputedAddress = await computeProxyAddressFromPhone(formattedPhoneNumber); // Generate wallet for phone number

  // Find the user by phone number
  const user = await User.findOne({ phone_number: formattedPhoneNumber });

  if (!user) {
    Logger.error('addWalletToUser', `User not found for phone number: ${phoneNumber}`);
    return null; // Return null if the user does not exist
  }

  // Check if the user already has a wallet for the given chain_id
  const existingWallet = user.wallets.find((wallet) => wallet.chain_id === chainId);
  if (existingWallet) {
    Logger.log(
      'addWalletToUser',
      `Wallet already exists for chain_id ${chainId} for user ${phoneNumber}`
    );
    return { user, newWallet: existingWallet }; // Return the existing wallet if it exists
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

  // Add the new wallet to the user's wallet list
  user.wallets.push(newWallet);

  // Save the updated user
  await user.save();

  Logger.log(
    'addWalletToUser',
    `New wallet added for user ${phoneNumber} with chain_id ${chainId}`
  );

  return { user, newWallet }; // Return the updated user and new wallet
};

/**
 * Filters wallets by chain_id and returns the first matching wallet.
 *
 * @param wallets - The array of wallet objects to filter.
 * @param chainId - The chain_id to filter the wallets by.
 * @returns The first wallet matching the given chain_id, or null if no match is found.
 */
export const getUserWalletByChainId = (
  wallets: IUserWallet[],
  chainId: number
): IUserWallet | null => {
  const wallet = wallets.find((w) => w.chain_id === chainId);
  return wallet || null; // Return the wallet if found, or null if not found
};

/**
 * Retrieves a user based on the wallet address and chain_id.
 * This function finds a user who has the specified wallet address for the given chain_id.
 *
 * @param {string} wallet - The wallet address to search for.
 * @param {number} chainId - The chain_id to filter the wallet.
 * @returns {Promise<IUser | null>} The user owning the wallet, or null if no user is found.
 */
export const getUserByWalletAndChainid = async (
  wallet: string,
  chainId: number
): Promise<IUser | null> => {
  // Find a user whose wallet matches the provided wallet address and chain_id
  const user: IUser | null = await User.findOne({
    'wallets.wallet_proxy': wallet, // Case-insensitive search for wallet address
    'wallets.chain_id': chainId // Filter by chain_id
  });
  return user; // Return the user, or null if no match is found
};

/**
 * Retrieves a wallet for a given phone number and chain_id.
 * This function finds the wallet associated with the given phone number and chain_id.
 *
 * @param phoneNumber - The phone number of the user.
 * @param chainId - The chain_id of the wallet to retrieve.
 * @returns A wallet object if found, or null if not found.
 */
export const getUserWallet = async (
  phoneNumber: string,
  chainId: number
): Promise<IUserWallet | null> => {
  const user: IUser | null = await User.findOne({
    phone_number: getPhoneNumberFormatted(phoneNumber) // Search by formatted phone number
  });

  if (!user) {
    return null; // Return null if the user does not exist
  }

  // Find and return the wallet that matches the given chain_id
  const wallet = user.wallets.find((w) => w.chain_id === chainId);
  return wallet || null; // Return the wallet, or null if not found
};

/**
 * Retrieves a user based on the phone number.
 * This function finds the user by phone number.
 */
export const getUser = async (phoneNumber: string): Promise<IUser | null> => {
  const user: IUser | null = await User.findOne({
    phone_number: getPhoneNumberFormatted(phoneNumber) // Search by formatted phone number
  });
  return user; // Return the user, or null if not found
};

/**
 * Retrieves or creates a user based on the phone number.
 * This function checks if the user exists and creates one if necessary.
 */
export const getOrCreateUser = async (
  phoneNumber: string,
  chatterpayImplementation: string
): Promise<IUser> => {
  const user = await getUser(phoneNumber);

  if (user) return user; // Return the existing user if found

  // If the user doesn't exist, create a new one
  Logger.log(
    'addWalletToUser',
    `Phone number ${phoneNumber} not registered in ChatterPay, registering...`
  );
  const newUser: IUser = await createUserWithWallet(phoneNumber, chatterpayImplementation);

  Logger.log(
    'addWalletToUser',
    `Phone number ${phoneNumber} registered with the wallet ${newUser.wallets[0].wallet_proxy}`
  );

  return newUser; // Return the newly created user
};

/**
 * Checks if a user has a specific operation in progress.
 * This function returns the number of operations of the specified type in progress for the given phone number.
 */
export const hasPhoneOperationInProgress = async (
  phoneNumber: string,
  operation: ConcurrentOperationsEnum
): Promise<number> => {
  const user = await User.findOne({ phone_number: getPhoneNumberFormatted(phoneNumber) });
  return user?.operations_in_progress?.[operation] || 0; // Return the count of operations, defaulting to 0
};

/**
 * Checks if a specific operation is in progress for a user.
 * This function checks the operations_in_progress field for the given operation type.
 */
export const hasUserOperationInProgress = (
  user: IUser,
  operation: ConcurrentOperationsEnum
): boolean => (user.operations_in_progress?.[operation] || 0) > 0; // Return true if the operation is in progress

/**
 * Opens an operation for the user (increments operation count).
 */
export const openOperation = (
  phoneNumber: string,
  operation: ConcurrentOperationsEnum
): Promise<void> => updateOperationCount(phoneNumber, operation, 1);

/**
 * Closes an operation for the user (decrements operation count).
 */
export const closeOperation = (
  phoneNumber: string,
  operation: ConcurrentOperationsEnum
): Promise<void> => updateOperationCount(phoneNumber, operation, -1);

/**
 * Updates the operation count for the user by the specified increment.
 * This function modifies the count of operations in progress.
 */
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
    user.operations_in_progress[operation] = Math.max(currentCount + increment, 0); // Ensure count doesn't go below 0
    await user.save(); // Save the updated user
  }
};

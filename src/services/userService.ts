import { getUser } from './mongoService';
import { Logger } from '../helpers/loggerHelper';
import { ConcurrentOperationsEnum } from '../types/common';
import { getPhoneNumberFormatted } from '../helpers/formatHelper';
import { IUser, UserModel, IUserWallet } from '../models/userModel';
import { ComputedAddress, computeProxyAddressFromPhone } from './predictWalletService';
import { DEFAULT_CHAIN_ID, SETTINGS_NOTIFICATION_LANGUAGE_DFAULT } from '../config/constants';
import { subscribeToPushChannel, sendWalletCreationNotification } from './notificationService';

/**
 * Updates the operation count for the user by the specified increment.
 * This function modifies the count of operations in progress.
 *
 * @param {string} phoneNumber - The phone number of the user.
 * @param {ConcurrentOperationsEnum} operation - The type of operation to update.
 * @param {number} increment - The value to increment or decrement the operation count by.
 * @returns {Promise<void>} A promise that resolves when the operation count is updated.
 */
const updateOperationCount = async (
  phoneNumber: string,
  operation: ConcurrentOperationsEnum,
  increment: number
): Promise<void> => {
  const user: IUser | null = await UserModel.findOne({
    phone_number: getPhoneNumberFormatted(phoneNumber)
  });

  if (user && user.operations_in_progress) {
    const currentCount = user.operations_in_progress[operation] || 0;
    user.operations_in_progress[operation] = Math.max(currentCount + increment, 0); // Ensure count doesn't go below 0
    await user.save(); // Save the updated user
  }
};

/**
 * Creates a new user with a wallet for the given phone number.
 * This function handles user creation, wallet generation, and push notifications.
 *
 * @param {string} phoneNumber - The phone number to create the wallet for.
 * @param {string} chatterpayImplementation - The address of the ChatterPay smart contract.
 * @returns {Promise<IUser>} The newly created user with the wallet.
 */
export const createUserWithWallet = async (
  phoneNumber: string,
  chatterpayImplementation: string
): Promise<IUser> => {
  const formattedPhoneNumber = getPhoneNumberFormatted(phoneNumber);
  const predictedWallet: ComputedAddress = await computeProxyAddressFromPhone(formattedPhoneNumber);

  const user = new UserModel({
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

  Logger.log('createUserWithWallet', 'Push protocol', phoneNumber, predictedWallet.EOAAddress);
  await subscribeToPushChannel(predictedWallet.privateKeyNotHashed, predictedWallet.EOAAddress);
  sendWalletCreationNotification(predictedWallet.EOAAddress, phoneNumber);

  return user;
};

/**
 * Adds a new wallet to an existing user for a given chain_id.
 * This function creates a new wallet and adds it to the user's wallet list if not already present.
 *
 * @param {string} phoneNumber - The phone number of the user to add the wallet to.
 * @param {number} chainId - The chain_id to associate with the new wallet.
 * @param {string} chatterpayImplementationAddress - The address of the ChatterPay smart contract.
 * @returns {Promise<{ user: IUser, newWallet: IUserWallet } | null>} The updated user with the new wallet or null if the wallet already exists.
 */
export const addWalletToUser = async (
  phoneNumber: string,
  chainId: number,
  chatterpayImplementationAddress: string
): Promise<{ user: IUser; newWallet: IUserWallet } | null> => {
  const formattedPhoneNumber = getPhoneNumberFormatted(phoneNumber);
  const predictedWallet: ComputedAddress = await computeProxyAddressFromPhone(formattedPhoneNumber);

  const user = await UserModel.findOne({ phone_number: formattedPhoneNumber });

  if (!user) {
    Logger.error('addWalletToUser', `User not found for phone number: ${phoneNumber}`);
    return null;
  }

  const existingWallet = user.wallets.find((wallet) => wallet.chain_id === chainId);
  if (existingWallet) {
    Logger.log(
      'addWalletToUser',
      `Wallet already exists for chain_id ${chainId} for user ${phoneNumber}`
    );
    return { user, newWallet: existingWallet };
  }

  const newWallet = {
    wallet_proxy: predictedWallet.proxyAddress,
    wallet_eoa: predictedWallet.EOAAddress,
    sk_hashed: predictedWallet.privateKey,
    chatterpay_implementation_address: chatterpayImplementationAddress,
    chain_id: chainId,
    status: 'active'
  };

  user.wallets.push(newWallet);
  await user.save();

  Logger.log(
    'addWalletToUser',
    `New wallet added for user ${phoneNumber} with chain_id ${chainId}`
  );

  return { user, newWallet };
};

/**
 * Filters wallets by chain_id and returns the first matching wallet.
 *
 * @param {IUserWallet[]} wallets - The array of wallet objects to filter.
 * @param {number} chainId - The chain_id to filter the wallets by.
 * @returns {IUserWallet | null} The first wallet matching the given chain_id, or null if no match is found.
 */
export const getUserWalletByChainId = (
  wallets: IUserWallet[],
  chainId: number
): IUserWallet | null => {
  const wallet = wallets.find((w) => w.chain_id === chainId);
  return wallet || null;
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
  const user: IUser | null = await UserModel.findOne({
    'wallets.wallet_proxy': wallet,
    'wallets.chain_id': chainId
  });
  return user;
};

/**
 * Retrieves a wallet for a given phone number and chain_id.
 * This function finds the wallet associated with the given phone number and chain_id.
 *
 * @param {string} phoneNumber - The phone number of the user.
 * @param {number} chainId - The chain_id of the wallet to retrieve.
 * @returns {Promise<IUserWallet | null>} A wallet object if found, or null if not found.
 */
export const getUserWallet = async (
  phoneNumber: string,
  chainId: number
): Promise<IUserWallet | null> => {
  const user: IUser | null = await UserModel.findOne({
    phone_number: getPhoneNumberFormatted(phoneNumber)
  });

  if (!user) {
    return null;
  }

  const wallet = user.wallets.find((w) => w.chain_id === chainId);
  return wallet || null;
};

/**
 * Retrieves or creates a user based on the phone number.
 * This function checks if the user exists and creates one if necessary.
 *
 * @param {string} phoneNumber - The phone number of the user.
 * @param {string} chatterpayImplementation - The address of the ChatterPay smart contract.
 * @returns {Promise<IUser>} The user object, either existing or newly created.
 */
export const getOrCreateUser = async (
  phoneNumber: string,
  chatterpayImplementation: string
): Promise<IUser> => {
  const user = await getUser(phoneNumber);

  if (user) return user;

  Logger.log(
    'addWalletToUser',
    `Phone number ${phoneNumber} not registered in ChatterPay, registering...`
  );
  const newUser: IUser = await createUserWithWallet(phoneNumber, chatterpayImplementation);

  Logger.log(
    'addWalletToUser',
    `Phone number ${phoneNumber} registered with the wallet ${newUser.wallets[0].wallet_proxy}`
  );

  return newUser;
};

/**
 * Checks if a user has a specific operation in progress.
 * This function returns the number of operations of the specified type in progress for the given phone number.
 *
 * @param {string} phoneNumber - The phone number of the user.
 * @param {ConcurrentOperationsEnum} operation - The operation type to check.
 * @returns {Promise<number>} The number of operations in progress, or 0 if none.
 */
export const hasPhoneOperationInProgress = async (
  phoneNumber: string,
  operation: ConcurrentOperationsEnum
): Promise<number> => {
  const user = await UserModel.findOne({ phone_number: getPhoneNumberFormatted(phoneNumber) });
  return user?.operations_in_progress?.[operation] || 0;
};

/**
 * Checks if a specific operation is in progress for a user.
 * This function checks the operations_in_progress field for the given operation type.
 *
 * @param {IUser} user - The user object.
 * @param {ConcurrentOperationsEnum} operation - The operation type to check.
 * @returns {boolean} True if the operation is in progress, otherwise false.
 */
export const hasUserOperationInProgress = (
  user: IUser,
  operation: ConcurrentOperationsEnum
): boolean => (user.operations_in_progress?.[operation] || 0) > 0;

/**
 * Opens an operation for the user (increments operation count).
 *
 * @param {string} phoneNumber - The phone number of the user.
 * @param {ConcurrentOperationsEnum} operation - The operation type to open.
 * @returns {Promise<void>} A promise that resolves when the operation is opened.
 */
export const openOperation = (
  phoneNumber: string,
  operation: ConcurrentOperationsEnum
): Promise<void> => updateOperationCount(phoneNumber, operation, 1);

/**
 * Closes an operation for the user (decrements operation count).
 *
 * @param {string} phoneNumber - The phone number of the user.
 * @param {ConcurrentOperationsEnum} operation - The operation type to close.
 * @returns {Promise<void>} A promise that resolves when the operation is closed.
 */
export const closeOperation = (
  phoneNumber: string,
  operation: ConcurrentOperationsEnum
): Promise<void> => updateOperationCount(phoneNumber, operation, -1);

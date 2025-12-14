import { DEFAULT_CHAIN_ID, PUSH_ENABLED } from '../config/constants';
import { formatIdentifierWithOptionalName, getPhoneNumberFormatted } from '../helpers/formatHelper';
import { Logger } from '../helpers/loggerHelper';
import { type IUser, type IUserWallet, UserModel } from '../models/userModel';
import type { ComputedAddress, ConcurrentOperationsEnum } from '../types/commonType';
import { walletProvisioningService } from './alchemy/walletProvisioningService';
import { mongoCountryService } from './mongo/mongoCountryService';
import { mongoUserService } from './mongo/mongoUserService';
import { pushService } from './push/pushService';
import { computeWallet } from './web3/rpc/rpcService';

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
    if (increment > 0) {
      user.lastOperationDate = new Date();
    }
    await user.save(); // Save the updated user
  }
};

/**
 * Attempts to register a wallet with Alchemy and update the user document accordingly.
 *
 * @param user - The user document to update
 * @param walletProxy - The wallet proxy address
 * @param chainId - The chain ID
 */
async function registerWalletWithAlchemy(
  user: IUser,
  walletProxy: string,
  chainId: number
): Promise<void> {
  try {
    const success = await walletProvisioningService.onWalletCreated(walletProxy, chainId);

    if (success) {
      const wallet = user.wallets.find((w) => w.wallet_proxy === walletProxy);
      if (wallet) {
        wallet.alchemy_registered = true;
        await user.save();
        Logger.info('registerWalletWithAlchemy', `Wallet marked as Alchemy-registered`, {
          userId: user.phone_number,
          walletProxy
        });
      }
    } else {
      Logger.warn('registerWalletWithAlchemy', `Alchemy Wallet registration skipped or failed`, {
        userId: user.phone_number,
        walletProxy
      });
    }
  } catch (error) {
    Logger.error('registerWalletWithAlchemy', `Unexpected error during Alchemy registration`, {
      userId: user.phone_number,
      walletProxy,
      error
    });
  }
}

/**
 * Creates a new user with a wallet for the given phone number.
 * This function handles user creation, wallet generation, and push notifications.
 *
 * @param {string} phoneNumber - The phone number to create the wallet for.
 * @param {string} chatterpayProxyAddress - The address of the ChatterPay Proxy smart contract.
 * @param {string} factoryAddress - The address of the Factory smart contract.
 * @returns {Promise<IUser>} The newly created user with the wallet.
 */
export const createUserWithWallet = async (
  phoneNumber: string,
  chatterpayProxyAddress: string,
  factoryAddress: string
): Promise<IUser> => {
  const formattedPhoneNumber = getPhoneNumberFormatted(phoneNumber);
  const predictedWallet: ComputedAddress = await computeWallet(formattedPhoneNumber);
  const detectedNotificationLng =
    await mongoCountryService.getNotificationLanguageByPhoneNumber(formattedPhoneNumber);

  Logger.log(
    'createUserWithWallet',
    `Creating user with wallet for ${phoneNumber}, wallet: ${predictedWallet.proxyAddress}, lng: ${detectedNotificationLng}`
  );

  const user = new UserModel({
    phone_number: formattedPhoneNumber,
    wallets: [
      {
        wallet_proxy: predictedWallet.proxyAddress,
        wallet_eoa: predictedWallet.EOAAddress,
        created_with_chatterpay_proxy_address: chatterpayProxyAddress,
        created_with_factory_address: factoryAddress,
        chain_id: DEFAULT_CHAIN_ID,
        status: 'active'
      }
    ],
    creationDate: new Date(),
    code: null,
    photo: '/assets/images/avatars/generic-user.png',
    email: null,
    name: null,
    settings: {
      notifications: {
        language: detectedNotificationLng
      }
    },
    lastOperationDate: null,
    operations_in_progress: {
      transfer: 0,
      swap: 0,
      mint_nft: 0,
      mint_nft_copy: 0,
      withdraw_all: 0
    },
    level: 'L1',
    operations_counters: {
      transfer: {},
      swap: {},
      mint_nft: {},
      mint_nft_copy: {}
    },
    manteca_user_id: ''
  });

  await user.save();

  user.manteca_user_id = `user-${user._id}`;
  await user.save();

  if (PUSH_ENABLED) {
    Logger.log('createUserWithWallet', 'Push protocol', phoneNumber, predictedWallet.EOAAddress);
    await pushService.subscribeToPushChannel(predictedWallet.data, predictedWallet.EOAAddress);
  } else {
    Logger.info(
      'createUserWithWallet',
      `Skipped adding new wallet to the push channel because push notifications are disabled.`
    );
  }

  // Register wallet with Alchemy webhook system
  await registerWalletWithAlchemy(user, predictedWallet.proxyAddress, DEFAULT_CHAIN_ID);

  return user;
};

/**
 * Adds a new wallet to an existing user for a given chain_id.
 * This function creates a new wallet and adds it to the user's wallet list if not already present.
 *
 * @param {string} phoneNumber - The phone number of the user to add the wallet to.
 * @param {number} chainId - The chain_id to associate with the new wallet.
 * @param {string} chatterpayProxyAddress - The address of the ChatterPay Proxy smart contract.
 * @param {string} factoryAddress - The address of the Factory smart contract.
 * @returns {Promise<{ user: IUser, newWallet: IUserWallet } | null>} The updated user with the new wallet or null if the wallet already exists.
 */
export const addWalletToUser = async (
  phoneNumber: string,
  chainId: number,
  chatterpayProxyAddress: string,
  factoryAddress: string
): Promise<{ user: IUser; newWallet: IUserWallet } | null> => {
  const formattedPhoneNumber = getPhoneNumberFormatted(phoneNumber);
  const predictedWallet: ComputedAddress = await computeWallet(formattedPhoneNumber);

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
    created_with_chatterpay_proxy_address: chatterpayProxyAddress,
    created_with_factory_address: factoryAddress,
    chain_id: chainId,
    status: 'active'
  };

  user.wallets.push(newWallet);
  await user.save();

  // Register wallet with Alchemy webhook system
  await registerWalletWithAlchemy(user, predictedWallet.proxyAddress, chainId);

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
 * @param {string} chatterpayProxyAddress - The address of the ChatterPay Proxy smart contract.
 * @param {string} factoryAddress - The address of the Factory smart contract.
 * @returns {Promise<IUser>} The user object, either existing or newly created.
 */
export const getOrCreateUser = async (
  phoneNumber: string,
  chatterpayProxyAddress: string,
  factoryAddress: string
): Promise<IUser> => {
  const user = await mongoUserService.getUser(phoneNumber);

  if (user) return user;

  Logger.log(
    'addWalletToUser',
    `Phone number ${phoneNumber} not registered in ChatterPay, registering...`
  );
  const newUser: IUser = await createUserWithWallet(
    phoneNumber,
    chatterpayProxyAddress,
    factoryAddress
  );

  Logger.log(
    'addWalletToUser',
    `Phone number ${phoneNumber} registered with the wallet ${newUser.wallets[0].wallet_proxy}`
  );

  return newUser;
};

/**
 * Checks if a user exists based on their phone number.
 *
 * @param {string} phoneNumber - The phone number to check.
 * @returns {Promise<boolean>} True if the user exists, false otherwise.
 */
export const getUser = async (phoneNumber: string): Promise<IUser | null> => {
  const user: IUser | null = await mongoUserService.getUser(phoneNumber);
  return user;
};

/**
 * Checks if a user exists based on their telegram id.
 *
 * @param {string} telegramId - The telegram Id to check.
 * @returns {Promise<boolean>} True if the user exists, false otherwise.
 */
export const getUserByTelegramId = async (telegramId: string): Promise<IUser | null> => {
  const user: IUser | null = await mongoUserService.getUserByTelegramId(telegramId);
  return user;
};

/**
 * Checks if a user has any operation in progress.
 * Verifies if any field in the `operations_in_progress` object has a value greater than 0.
 *
 * @param {IUser} user - The user object to check.
 * @returns {boolean} True if the user has at least one operation in progress, false otherwise.
 */
export const hasUserAnyOperationInProgress = (user: IUser): boolean =>
  Object.values(user.operations_in_progress || {}).some((operation) => operation > 0);

/**
 * Checks if a user has any operation in progress by phone number.
 * This function returns true if any operation in the `operations_in_progress` field has a value greater than 0.
 *
 * @param {string} phoneNumber - The phone number of the user to check.
 * @returns {Promise<boolean>} True if the user has any operation in progress, false otherwise.
 */
export const hasPhoneAnyOperationInProgress = async (phoneNumber: string): Promise<boolean> => {
  const user: IUser | null = await UserModel.findOne({
    phone_number: getPhoneNumberFormatted(phoneNumber)
  });
  if (!user) return false;
  return hasUserAnyOperationInProgress(user);
};

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

/**
 *
 * @param {string} phoneNumber - The phone number of the user.
 * @returns
 */
export const getDisplayUserLabel = async (phoneNumber: string): Promise<string> => {
  const user: IUser | null = await UserModel.findOne({
    phone_number: getPhoneNumberFormatted(phoneNumber)
  });
  if (!user) return phoneNumber;

  const wallet: IUserWallet | null = await getUserWallet(phoneNumber, DEFAULT_CHAIN_ID);
  return formatIdentifierWithOptionalName(
    wallet?.wallet_proxy || '0x0000000000000000000000000000000000000000',
    user.name,
    true
  );
};

/**
 * Sets the `telegram_id` for a user identified by phone number.
 * Delegates to `mongoUserService.setTelegramIdByPhone`.
 *
 * @param {string} phoneNumber - User's phone number.
 * @param {string} telegramId - Telegram user ID as string (digits only).
 * @returns {Promise<IUser | null>} The updated user or null if not found or validation fails.
 */
export const setUserTelegramIdByPhone = async (
  phoneNumber: string,
  telegramId: string
): Promise<IUser | null> => mongoUserService.setTelegramIdByPhone(phoneNumber, telegramId);

// --- Verification code wrappers (userService) ---

/**
 * Generates and stores a new 6-digit verification code for the user.
 * Delegates to `mongoUserService.setUserVerificationCode`.
 *
 * @param {string} phoneNumber - Any-format phone number (will be normalized).
 * @returns {Promise<number | null>} The newly generated code, or null if user not found/invalid.
 */
export const setUserVerificationCode = async (phoneNumber: string): Promise<number | null> =>
  mongoUserService.setUserVerificationCode(phoneNumber);

/**
 * Retrieves the stored 6-digit verification code for the user, if any.
 * Delegates to `mongoUserService.getUserVerificationCode`.
 *
 * @param {string} phoneNumber - Any-format phone number (will be normalized).
 * @returns {Promise<number | null>} The stored code, or null if not set/not found/invalid.
 */
export const getUserVerificationCode = async (phoneNumber: string): Promise<number | null> =>
  mongoUserService.getUserVerificationCode(phoneNumber);

/**
 * Clears the stored verification code for the user (sets to null).
 * Delegates to `mongoUserService.clearUserVerificationCode`.
 *
 * @param {string} phoneNumber - Any-format phone number (will be normalized).
 * @returns {Promise<boolean>} True if a document was updated, false otherwise.
 */
export const clearUserVerificationCode = async (phoneNumber: string): Promise<boolean> =>
  mongoUserService.clearUserVerificationCode(phoneNumber);

import { User, IUser } from '../models/user';
import { Logger } from '../helpers/loggerHelper';
import { ConcurrentOperationsEnum } from '../types/common';
import { getPhoneNumberFormatted } from '../helpers/formatHelper';
import { SETTINGS_NOTIFICATION_LANGUAGE_DFAULT } from '../config/constants';
import { ComputedAddress, computeProxyAddressFromPhone } from './predictWalletService';
import { subscribeToPushChannel, sendWalletCreationNotification } from './notificationService';

/**
 * Creates a new wallet and user for the given phone number.
 * @param {string} phoneNumber - The phone number to create the wallet for.
 * @returns {Promise<string>} The proxy address of the created wallet.
 */
export const createUserWithWallet = async (phoneNumber: string): Promise<IUser> => {
  const predictedWallet: ComputedAddress = await computeProxyAddressFromPhone(phoneNumber);
  const formattedPhoneNumber = getPhoneNumberFormatted(phoneNumber);

  const user = new User({
    phone_number: formattedPhoneNumber,
    wallet: predictedWallet.proxyAddress,
    walletEOA: predictedWallet.EOAAddress,
    privateKey: predictedWallet.privateKey,
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
export const getOrCreateUser = async (phoneNumber: string): Promise<IUser> => {
  const user = await getUser(phoneNumber);

  if (user) return user;
  Logger.log(`Phone number ${phoneNumber} not registered in ChatterPay, registering...`);

  const newUser: IUser = await createUserWithWallet(phoneNumber);
  Logger.log(`Phone number ${phoneNumber} registered with the wallet ${newUser.wallet}`);

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

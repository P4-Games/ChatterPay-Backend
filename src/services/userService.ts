import { Logger } from '../utils/logger';
import { User, IUser } from '../models/user';
import { SETTINGS_NOTIFICATION_LANGUAGE_DFAULT } from '../constants/environment';
import { ComputedAddress, computeProxyAddressFromPhone } from './predictWalletService';
import { subscribeToPushChannel, sendWalletCreationNotification } from './notificationService';

/**
 * Creates a new wallet and user for the given phone number.
 * @param {string} phoneNumber - The phone number to create the wallet for.
 * @returns {Promise<string>} The proxy address of the created wallet.
 */
export const createUserWithWallet = async (phoneNumber: string): Promise<IUser> => {
  const predictedWallet: ComputedAddress = await computeProxyAddressFromPhone(phoneNumber);

  const user = new User({
    phone_number: phoneNumber,
    wallet: predictedWallet.proxyAddress,
    walletEOA: predictedWallet.EOAAddress,
    privateKey: predictedWallet.privateKey,
    code: null,
    photo: '/assets/images/avatars/generic_user.jpg',
    email: null,
    name: null,
    settings: {
      notifications: {
        language: SETTINGS_NOTIFICATION_LANGUAGE_DFAULT
      }
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
  const user: IUser | null = await User.findOne({ phone_number: phoneNumber });
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

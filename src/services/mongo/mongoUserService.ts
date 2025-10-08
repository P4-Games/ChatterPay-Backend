import { Logger } from '../../helpers/loggerHelper';
import { IUser, UserModel } from '../../models/userModel';
import { mongoCountryService } from './mongoCountryService';
import { getPhoneNumberFormatted } from '../../helpers/formatHelper';
import { NotificationLanguage, notificationLanguages } from '../../types/commonType';
import {
  RESET_USER_OPERATION_THRESHOLD_MINUTES,
  SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT
} from '../../config/constants';

export const mongoUserService = {
  /**
   * Retrieves a user based on the phone number.
   * This function finds the user by phone number.
   *
   * @param {string} phoneNumber - The phone number of the user to retrieve.
   * @returns {Promise<IUser | null>} The user object if found, or null if not found.
   */
  getUser: async (phoneNumber: string): Promise<IUser | null> => {
    const user: IUser | null = await UserModel.findOne({
      phone_number: getPhoneNumberFormatted(phoneNumber)
    });
    return user;
  },

  /**
   * Retrieves a user based on the Telegram ID.
   * This function finds the user by the numeric `telegram_id` field.
   *
   * @param {string} telegramId - Telegram user ID (numeric, integer).
   * @returns {Promise<IUser | null>} The user object if found, or null if not found.
   */
  getUserByTelegramId: async (telegramId: string): Promise<IUser | null> => {
    const id = (telegramId ?? '').trim();

    // Reject null, empty, whitespace-only, or non-numeric values
    if (id.length === 0 || !/^\d+$/.test(id)) {
      return null;
    }
    const user: IUser | null = await UserModel.findOne({ telegram_id: telegramId });
    return user;
  },

  /**
   * Retrieves all users with operations in progress.
   * This function searches the database for users where any field in `operations_in_progress` has the value `1`.
   *
   * @returns {Promise<IUser[]>} A list of users who have operations in progress.
   * @example
   * [
   *   {
   *     "name": "John Doe",
   *     "email": "johndoe@example.com",
   *     "phone_number": "+1234567890",
   *     "operations_in_progress": {
   *       "transfer": 1,
   *       "swap": 0,
   *       "mint_nft": 0,
   *       "mint_nft_copy": 0,
   *       "withdraw_all": 1
   *     }
   *   }
   * ]
   */
  getUsersWithOperationsInProgress: async (): Promise<
    Partial<Pick<IUser, 'phone_number' | 'operations_in_progress' | 'lastOperationDate'>>[]
  > => {
    const users = await UserModel.find(
      {
        $or: [
          { 'operations_in_progress.transfer': 1 },
          { 'operations_in_progress.swap': 1 },
          { 'operations_in_progress.mint_nft': 1 },
          { 'operations_in_progress.mint_nft_copy': 1 },
          { 'operations_in_progress.withdraw_all': 1 }
        ]
      },
      'phone_number lastOperationDate operations_in_progress'
    ).lean();

    return users;
  },

  /**
   * Updates all users to reset operations in progress.
   * This function sets all fields in `operations_in_progress` to `0` for every user in the database.
   *
   * @returns {Promise<number>} The number of users that were updated.
   * @example
   * // Before update:
   * {
   *   "operations_in_progress": {
   *     "transfer": 1,
   *     "swap": 1,
   *     "mint_nft": 1,
   *     "mint_nft_copy": 1,
   *     "withdraw_all": 1
   *   }
   * }
   *
   * // After update:
   * {
   *   "operations_in_progress": {
   *     "transfer": 0,
   *     "swap": 0,
   *     "mint_nft": 0,
   *     "mint_nft_copy": 0,
   *     "withdraw_all": 0
   *   }
   * }
   */
  resetUserOperationsCounter: async (): Promise<number> => {
    const result = await UserModel.updateMany(
      {
        $or: [
          { 'operations_in_progress.transfer': { $ne: 0 } },
          { 'operations_in_progress.swap': { $ne: 0 } },
          { 'operations_in_progress.mint_nft': { $ne: 0 } },
          { 'operations_in_progress.mint_nft_copy': { $ne: 0 } },
          { 'operations_in_progress.withdraw_all': { $ne: 0 } }
        ]
      },
      {
        $set: {
          'operations_in_progress.transfer': 0,
          'operations_in_progress.swap': 0,
          'operations_in_progress.mint_nft': 0,
          'operations_in_progress.mint_nft_copy': 0,
          'operations_in_progress.withdraw_all': 0
        }
      }
    );

    return result.modifiedCount;
  },

  /**
   * Resets operations in progress for users with active operations if their last operation date
   * is older than N minutes.
   *
   * @returns {Promise<number>} The number of users whose operations were reset.
   */
  resetUserOperationsCounterWithTimeCondition: async (): Promise<number> => {
    const thirtyMinutesAgo = new Date(
      Date.now() - RESET_USER_OPERATION_THRESHOLD_MINUTES * 60 * 1000
    );

    const result = await UserModel.updateMany(
      {
        $and: [
          {
            $or: [
              { 'operations_in_progress.transfer': { $ne: 0 } },
              { 'operations_in_progress.swap': { $ne: 0 } },
              { 'operations_in_progress.mint_nft': { $ne: 0 } },
              { 'operations_in_progress.mint_nft_copy': { $ne: 0 } },
              { 'operations_in_progress.withdraw_all': { $ne: 0 } }
            ]
          },
          { last_operation_date: { $lte: thirtyMinutesAgo } }
        ]
      },
      {
        $set: {
          'operations_in_progress.transfer': 0,
          'operations_in_progress.swap': 0,
          'operations_in_progress.mint_nft': 0,
          'operations_in_progress.mint_nft_copy': 0,
          'operations_in_progress.withdraw_all': 0
        }
      }
    );

    return result.modifiedCount;
  },

  /**
   * Updates the operation counter for a specific user and operation type.
   *
   * @param phoneNumber - User's phone number identifier
   * @param operationType - Type of operation (transfer, swap, nft, nftCopy)
   */
  updateUserOperationCounter: async (
    phoneNumber: string,
    operationType: 'transfer' | 'swap' | 'mint_nft' | 'mint_nft_copy'
  ): Promise<void> => {
    const currentDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    try {
      Logger.info(
        'updateUserOperationCounter',
        `Updating counter for ${operationType} on date ${currentDate} for user ${phoneNumber}`
      );

      await UserModel.updateOne(
        { phone_number: phoneNumber },
        { $inc: { [`operations_counters.${operationType}.${currentDate}`]: 1 } }
      );
    } catch (error) {
      Logger.error(
        'updateUserOperationCounter',
        `Error updating counter for ${operationType}`,
        (error as Error).message
      );
      // avoid throw error
    }
  },

  /**
   * Gets user's notification language, falling back to detection by phone prefix if needed.
   *
   * @param {string} phoneNumber - Full international phone number
   * @returns {NotificationLanguage} - The notification language in lowercase ('en' | 'es' | 'pt')
   */
  getUserSettingsLanguage: async (phoneNumber: string): Promise<NotificationLanguage> => {
    try {
      const user: IUser | null = await mongoUserService.getUser(phoneNumber);
      const rawLang = user?.settings?.notifications?.language?.toLowerCase();
      if (rawLang && notificationLanguages.includes(rawLang as NotificationLanguage)) {
        return rawLang as NotificationLanguage;
      }

      const detected = await mongoCountryService.getNotificationLanguageByPhoneNumber(phoneNumber);
      Logger.warn(
        'getUserSettingsLanguage',
        `No valid user language for ${phoneNumber}, falling back to detected: ${detected}`
      );
      return detected;
    } catch (error: unknown) {
      Logger.warn(
        'getUserSettingsLanguage',
        `Error getting user settings language for ${phoneNumber}, error: ${(error as Error).message}`
      );
      return SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT;
    }
  },

  /**
   * Reset the entire operations_counters field for a specific user.
   *
   * @param {string} phoneNumber - The user's phone number to identify them.
   * @returns {Promise<void>}
   */
  resetrUserOperationCounters: async (phoneNumber: string): Promise<void> => {
    try {
      Logger.info(
        'resetrUserOperationCounters',
        `Resetting operations_counters for user ${phoneNumber}`
      );

      await UserModel.updateOne(
        { phone_number: phoneNumber },
        {
          $set: {
            operations_counters: {
              transfer: {},
              swap: {},
              mint_nft: {},
              mint_nft_copy: {}
            }
          }
        }
      );
    } catch (error) {
      // avoid throw error
      Logger.error(
        'resetrUserOperationCounters',
        `Error Resetting operations_counters for user ${phoneNumber}`,
        (error as Error).message
      );
    }
  },

  /**
   * Sets the `telegram_id` for the user identified by phone number.
   * Creates the field if it does not exist.
   *
   * Validation:
   * - `phoneNumber` is normalized with `getPhoneNumberFormatted`.
   * - `telegramId` must be non-empty, trimmed, and numeric (digits only).
   * - If the `telegram_id` is already linked to another user, it will not overwrite and returns null.
   *
   * @param {string} phoneNumber - The user's phone number (any format; will be normalized).
   * @param {string} telegramId - Telegram user ID as string (digits only).
   * @returns {Promise<IUser | null>} The updated user or null if user not found or validation fails.
   */
  setTelegramIdByPhone: async (phoneNumber: string, telegramId: string): Promise<IUser | null> => {
    const formattedPhone = getPhoneNumberFormatted(phoneNumber);
    const id = (telegramId ?? '').trim();

    if (!formattedPhone) {
      Logger.warn('setTelegramIdByPhone', 'Empty or invalid phone number after formatting.');
      return null;
    }

    if (id.length === 0 || !/^\d+$/.test(id)) {
      Logger.warn(
        'setTelegramIdByPhone',
        `Invalid telegramId '${telegramId}' (must be digits only).`
      );
      return null;
    }

    // Prevent linking a telegram_id that already belongs to a different user
    const alreadyLinked = await UserModel.findOne({
      telegram_id: id,
      phone_number: { $ne: formattedPhone }
    }).lean();

    if (alreadyLinked) {
      Logger.warn(
        'setTelegramIdByPhone',
        `telegram_id '${id}' already linked to a different user (${alreadyLinked.phone_number}).`
      );
      return null;
    }

    const user: IUser | null = await UserModel.findOneAndUpdate(
      { phone_number: formattedPhone },
      { $set: { telegram_id: id } },
      { new: true }
    );

    if (!user) {
      Logger.warn('setTelegramIdByPhone', `User not found for phone ${formattedPhone}.`);
      return null;
    }

    Logger.info('setTelegramIdByPhone', `telegram_id set for ${formattedPhone} -> ${id}`);
    return user;
  },

  /**
   * Sets a new 6-digit verification code into `users.code`.
   *
   * - Normalizes the phone number.
   * - Generates a code in [100000, 999999].
   * - Persists it under `code`.
   *
   * @param {string} phoneNumber - Any-format phone number (will be normalized).
   * @returns {Promise<number | null>} The newly generated code, or null if user not found or invalid phone.
   */
  setUserVerificationCode: async (phoneNumber: string): Promise<number | null> => {
    const formattedPhone = getPhoneNumberFormatted(phoneNumber);

    if (!formattedPhone) {
      Logger.warn('setUserVerificationCode', 'Empty or invalid phone number after formatting.');
      return null;
    }

    const code: number = Math.floor(Math.random() * (999999 - 100000 + 1)) + 100000;

    try {
      const res = await UserModel.updateOne({ phone_number: formattedPhone }, { $set: { code } });

      if (res.matchedCount === 0) {
        Logger.warn('setUserVerificationCode', `User not found for phone ${formattedPhone}.`);
        return null;
      }

      Logger.info('setUserVerificationCode', `Code set for ${formattedPhone}.`);
      return code;
    } catch (error) {
      Logger.error(
        'setUserVerificationCode',
        `Error setting code for ${formattedPhone}`,
        (error as Error).message
      );
      return null; // avoid throw
    }
  },

  /**
   * Retrieves the 6-digit verification code from `users.code`.
   *
   * @param {string} phoneNumber - Any-format phone number (will be normalized).
   * @returns {Promise<number | null>} The stored code, or null if not found/empty/invalid phone.
   */
  getUserVerificationCode: async (phoneNumber: string): Promise<number | null> => {
    const formattedPhone = getPhoneNumberFormatted(phoneNumber);

    if (!formattedPhone) {
      Logger.warn('getUserVerificationCode', 'Empty or invalid phone number after formatting.');
      return null;
    }

    try {
      const user = await UserModel.findOne({ phone_number: formattedPhone }, { code: 1 }).lean<{
        code?: number | null;
      }>();

      const value = typeof user?.code === 'number' ? user.code : null;
      if (value === null) {
        Logger.info('getUserVerificationCode', `No code set for ${formattedPhone}.`);
      }
      return value;
    } catch (error) {
      Logger.error(
        'getUserVerificationCode',
        `Error reading code for ${formattedPhone}`,
        (error as Error).message
      );
      return null; // avoid throw
    }
  },

  /**
   * Clears the verification code by setting `users.code` to null.
   *
   * @param {string} phoneNumber - Any-format phone number (will be normalized).
   * @returns {Promise<boolean>} True if a document was updated, false otherwise.
   */
  clearUserVerificationCode: async (phoneNumber: string): Promise<boolean> => {
    const formattedPhone = getPhoneNumberFormatted(phoneNumber);

    if (!formattedPhone) {
      Logger.warn('clearUserVerificationCode', 'Empty or invalid phone number after formatting.');
      return false;
    }

    try {
      const res = await UserModel.updateOne(
        { phone_number: formattedPhone },
        { $set: { code: null } }
      );

      const updated = res.modifiedCount > 0 || res.matchedCount > 0;
      if (updated) {
        Logger.info('clearUserVerificationCode', `Code cleared for ${formattedPhone}.`);
      } else {
        Logger.warn('clearUserVerificationCode', `User not found for phone ${formattedPhone}.`);
      }
      return updated;
    } catch (error) {
      Logger.error(
        'clearUserVerificationCode',
        `Error clearing code for ${formattedPhone}`,
        (error as Error).message
      );
      return false; // avoid throw
    }
  },

  async getUserByWalletProxyInsensitive(address: string) {
    return UserModel.findOne({
      'wallets.wallet_proxy': { $regex: new RegExp(`^${address}$`, 'i') }
    }).lean();
  }
};

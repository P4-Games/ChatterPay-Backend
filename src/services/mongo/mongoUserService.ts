import { Logger } from '../../helpers/loggerHelper';
import { IUser, UserModel } from '../../models/userModel';
import { LanguageEnum } from '../../models/templateModel';
import { getPhoneNumberFormatted } from '../../helpers/formatHelper';
import {
  SETTINGS_NOTIFICATION_LANGUAGE_DFAULT,
  RESET_USER_OPERATION_THRESHOLD_MINUTES
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
   * Gets user language based on the phone number.
   *
   * @param phoneNumber
   * @returns
   */
  getUserSettingsLanguage: async (phoneNumber: string): Promise<LanguageEnum> => {
    let language: LanguageEnum = SETTINGS_NOTIFICATION_LANGUAGE_DFAULT as LanguageEnum;
    try {
      const user: IUser | null = await mongoUserService.getUser(phoneNumber);
      if (user && user.settings) {
        const userLanguage = user.settings.notifications.language;
        if (Object.values(LanguageEnum).includes(userLanguage as LanguageEnum)) {
          language = userLanguage as LanguageEnum;
        } else {
          Logger.warn(
            'getUserSettingsLanguage',
            `Invalid language detected for user ${phoneNumber}, defaulting to ${SETTINGS_NOTIFICATION_LANGUAGE_DFAULT}`
          );
        }
      }
    } catch (error: unknown) {
      // avoid throw error
      Logger.error(
        'getUserSettingsLanguage',
        `Error getting user settings language for ${phoneNumber}, error: ${(error as Error).message}`
      );
    }
    return language;
  }
};

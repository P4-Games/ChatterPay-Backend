import CountryModel from '../../models/countries';
import { Logger } from '../../helpers/loggerHelper';
import { NotificationLanguage } from '../../types/commonType';
import { SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT } from '../../config/constants';

export const mongoCountryService = {
  /**
   * Determines the notification language based on the phone number's country code.
   *
   * @param phoneNumber - The full international phone number, e.g. "+5491123456789"
   * @returns The notification language ('en' | 'es' | 'pt') if matched, or default if not
   */
  getNotificationLanguageByPhoneNumber: async (
    phoneNumber: string
  ): Promise<NotificationLanguage> => {
    const digits = phoneNumber.replace(/\D/g, '');

    try {
      const countries = await CountryModel.find(
        {},
        { phone_code: 1, notification_language: 1 }
      ).lean();

      const sorted = countries
        .map((c) => ({
          code: c.phone_code,
          lang: c.notification_language as NotificationLanguage
        }))
        .sort((a, b) => b.code.length - a.code.length);

      const match = sorted.find((entry) => digits.startsWith(entry.code));

      return match?.lang ?? SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT;
    } catch (err) {
      Logger.warn(
        'getNotificationLanguageByPhoneNumber',
        '[getNotificationLanguageByPhoneNumber] DB error:',
        err
      );
      return SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT;
    }
  }
};

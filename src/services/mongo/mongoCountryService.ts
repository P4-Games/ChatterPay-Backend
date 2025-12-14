import { SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import CountryModel, { type ICountry } from '../../models/countries';
import type { NotificationLanguage } from '../../types/commonType';

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
  },

  /**
   * Fetch all countries with basic fields (code, phone_code, languages)
   */
  getAllCountries: async (): Promise<
    Pick<ICountry, 'code' | 'phone_code' | 'notification_language'>[]
  > => {
    try {
      return await CountryModel.find(
        {},
        { code: 1, phone_code: 1, notification_language: 1 }
      ).lean();
    } catch (err) {
      Logger.error('mongoCountryService', 'getAllCountries DB error:', err);
      return [];
    }
  },

  /**
   * Find a country by its ISO code (e.g., 'AR')
   */
  getCountryByCode: async (code: string): Promise<ICountry | null> => {
    try {
      // @ts-expect-error
      return await CountryModel.findOne({ code: code.toLowerCase() }).lean();
    } catch (err) {
      Logger.error('mongoCountryService', 'getCountryByCode DB error:', err);
      return null;
    }
  },

  /**
   * Find a country by matching the start of a phone number with its phone_code.
   * E.g., '549115...' → Argentina
   */
  getCountryByPhoneNumber: async (phoneNumber: string): Promise<ICountry | null> => {
    const digits = phoneNumber.replace(/\D/g, '');
    try {
      const countries = await CountryModel.find({}, { code: 1, phone_code: 1 }).lean();
      const sorted = countries.sort((a, b) => b.phone_code.length - a.phone_code.length);
      // @ts-expect-error
      return sorted.find((c) => digits.startsWith(c.phone_code)) ?? null;
    } catch (err) {
      Logger.error('mongoCountryService', 'getCountryByPhoneNumber DB error:', err);
      return null;
    }
  }
};

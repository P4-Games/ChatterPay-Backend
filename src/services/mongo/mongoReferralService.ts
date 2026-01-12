import { getPhoneNumberFormatted } from '../../helpers/formatHelper';
import { Logger } from '../../helpers/loggerHelper';
import { UserModel } from '../../models/userModel';

export const mongoReferralService = {
  getReferralCodeByPhoneNumber: async (phoneNumber: string): Promise<string | null> => {
    const user = await UserModel.findOne(
      {
        phone_number: getPhoneNumberFormatted(phoneNumber)
      },
      'referral_code'
    ).lean();

    return user?.referral_code ?? null;
  },

  getReferralByCodeByPhoneNumber: async (phoneNumber: string): Promise<string | null> => {
    const user = await UserModel.findOne(
      {
        phone_number: getPhoneNumberFormatted(phoneNumber)
      },
      'referral_by_code'
    ).lean();

    // Important: Mongoose defaults are not applied on reads, so an existing user
    // may legitimately have this field missing. In that case, return empty string
    // (referral not set) instead of null (user not found).
    if (!user) return null;
    return user.referral_by_code ?? '';
  },

  setReferralCodeByPhoneNumber: async (
    phoneNumber: string,
    referralCode: string
  ): Promise<void> => {
    await UserModel.updateOne(
      {
        phone_number: getPhoneNumberFormatted(phoneNumber)
      },
      {
        $set: {
          referral_code: referralCode
        }
      }
    );
  },

  setReferralByCodeIfEmpty: async (
    phoneNumber: string,
    referralByCode: string
  ): Promise<boolean> => {
    try {
      const formattedPhoneNumber = getPhoneNumberFormatted(phoneNumber);
      const result = await UserModel.updateOne(
        {
          phone_number: formattedPhoneNumber,
          $or: [
            { referral_by_code: { $exists: false } },
            { referral_by_code: null },
            { referral_by_code: '' }
          ]
        },
        {
          $set: {
            referral_by_code: referralByCode
          }
        }
      );

      return (result.modifiedCount ?? 0) > 0;
    } catch (error) {
      Logger.warn('setReferralByCodeIfEmpty', `Failed to set referral_by_code`, {
        phoneNumber,
        error
      });
      return false;
    }
  },

  getPhoneNumberByReferralCode: async (referralCode: string): Promise<string | null> => {
    const code = (referralCode ?? '').trim();
    if (!code) return null;

    const user = await UserModel.findOne(
      {
        referral_code: code
      },
      'phone_number'
    ).lean();

    return user?.phone_number ?? null;
  },

  countUsersReferredByCode: async (referralCode: string): Promise<number> => {
    const code = (referralCode ?? '').trim();
    if (!code) return 0;

    return await UserModel.countDocuments({ referral_by_code: code });
  }
};

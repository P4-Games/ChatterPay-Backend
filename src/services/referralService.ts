import { generateReferralCode } from '../helpers/referralHelper';
import { mongoReferralService } from './mongo/mongoReferralService';
import { mongoUserService } from './mongo/mongoUserService';

export type SubmitReferrerCodeResult =
  | { status: 'ok'; updated: true }
  | { status: 'already_set'; updated: false }
  | { status: 'user_not_found' }
  | { status: 'referrer_code_not_found' }
  | { status: 'self_referral' };

export const referralService = {
  getOrGenerateReferralCode: async (phoneNumber: string): Promise<string | null> => {
    const user = await mongoUserService.getUser(phoneNumber);
    if (!user) return null;

    const existing = (await mongoReferralService.getReferralCodeByPhoneNumber(phoneNumber)) ?? '';
    if (existing && existing.trim().length > 0) return existing;

    const referralCode = generateReferralCode(user.phone_number);
    await mongoReferralService.setReferralCodeByPhoneNumber(phoneNumber, referralCode);
    return referralCode;
  },

  getReferralByCode: async (phoneNumber: string): Promise<string | null> => {
    const user = await mongoUserService.getUser(phoneNumber);
    if (!user) return null;

    return await mongoReferralService.getReferralByCodeByPhoneNumber(phoneNumber);
  },

  getReferralCodeWithUsageCount: async (
    phoneNumber: string
  ): Promise<{ referral_code: string; referred_users_count: number } | null> => {
    const referralCode = await referralService.getOrGenerateReferralCode(phoneNumber);
    if (!referralCode) return null;

    const referredUsersCount = await mongoReferralService.countUsersReferredByCode(referralCode);
    return { referral_code: referralCode, referred_users_count: referredUsersCount };
  },

  submitReferrerCode: async (
    phoneNumber: string,
    referrerReferralCode: string
  ): Promise<SubmitReferrerCodeResult> => {
    const user = await mongoUserService.getUser(phoneNumber);
    if (!user) return { status: 'user_not_found' };

    const code = (referrerReferralCode ?? '').trim();
    if (!code) return { status: 'referrer_code_not_found' };

    const referrerPhoneNumber = await mongoReferralService.getPhoneNumberByReferralCode(code);
    if (!referrerPhoneNumber) return { status: 'referrer_code_not_found' };

    const currentUserReferralCode = await referralService.getOrGenerateReferralCode(phoneNumber);
    if (currentUserReferralCode && currentUserReferralCode.trim() === code) {
      return { status: 'self_referral' };
    }

    const updated = await mongoReferralService.setReferralByCodeIfEmpty(phoneNumber, code);
    if (!updated) return { status: 'already_set', updated: false };

    return { status: 'ok', updated: true };
  }
};

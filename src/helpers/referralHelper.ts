/**
 * Generates a referral code based on phone number and randomness.
 */
export const generateReferralCode = (phoneNumber: string): string => {
  const phoneSuffix = phoneNumber.replace(/\D/g, '').slice(-4);
  const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();

  return `${phoneSuffix}${randomPart}`;
};

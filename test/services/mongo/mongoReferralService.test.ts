import { describe, expect, it } from 'vitest';

import { UserModel } from '../../../src/models/userModel';
import { mongoReferralService } from '../../../src/services/mongo/mongoReferralService';

describe('mongoReferralService.getReferralByCodeByPhoneNumber', () => {
  it('returns empty string when user exists but referral_by_code field is missing', async () => {
    // Insert raw doc to simulate legacy data where field was never set.
    await UserModel.collection.insertOne({
      phone_number: '1234567890'
    });

    const referralByCode = await mongoReferralService.getReferralByCodeByPhoneNumber('1234567890');
    expect(referralByCode).toBe('');
  });

  it('returns null when user does not exist', async () => {
    const referralByCode = await mongoReferralService.getReferralByCodeByPhoneNumber('9999999999');
    expect(referralByCode).toBeNull();
  });
});

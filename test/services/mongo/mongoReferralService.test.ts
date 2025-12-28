import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UserModel } from '../../../src/models/userModel';
import { mongoReferralService } from '../../../src/services/mongo/mongoReferralService';

describe('mongoReferralService.getReferralByCodeByPhoneNumber', () => {
  let mongoServer: MongoMemoryServer;

  beforeEach(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    await mongoose.disconnect();
    await mongoose.connect(uri, {});
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

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

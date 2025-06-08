import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { it, expect, describe, afterEach, beforeEach } from 'vitest';

import { IUser, UserModel, IUserWallet } from '../../src/models/userModel';
import { SETTINGS_NOTIFICATION_LANGUAGE_DFAULT } from '../../src/config/constants';

describe('User Model', () => {
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

  it('should create and save a User document successfully', async () => {
    const validUser: Partial<IUser> = {
      name: 'John Doe',
      email: 'john.doe@example.com',
      phone_number: '1234567890',
      photo: 'https://example.com/photo.jpg',
      code: 1234,
      wallets: [
        {
          wallet_proxy: '0xProxyAddress',
          wallet_eoa: '0xEoaAddress',
          sk_hashed: 'hashed-sk',
          created_with_chatterpay_proxy_address: '0xChatterpayProxyAddress',
          chain_id: 1,
          status: 'active'
        } as IUserWallet
      ],
      settings: {
        notifications: {
          language: 'en'
        }
      },
      operations_in_progress: {
        transfer: 1,
        swap: 2,
        mint_nft: 3,
        mint_nft_copy: 4,
        withdraw_all: 5
      }
    };

    const user = new UserModel(validUser);
    const savedUser = await user.save();

    expect(savedUser._id).toBeDefined();
    expect(savedUser.name).toBe(validUser.name);
    expect(savedUser.email).toBe(validUser.email);
    expect(savedUser.phone_number).toBe(validUser.phone_number);
    expect(savedUser.wallets[0].wallet_proxy).toBe(validUser.wallets?.[0]?.wallet_proxy);
    expect(savedUser.settings?.notifications.language).toBe(
      validUser.settings?.notifications.language
    );
  });

  it('should fail to save a User without a phone number', async () => {
    const invalidUser: Partial<IUser> = {
      name: 'John Doe',
      email: 'john.doe@example.com',
      photo: 'https://example.com/photo.jpg'
    };

    const user = new UserModel(invalidUser);

    await expect(user.save()).rejects.toThrow(mongoose.Error.ValidationError);
  });

  it('should apply default values to optional fields', async () => {
    const validUser: Partial<IUser> = {
      phone_number: '1234567890'
    };

    const user = new UserModel(validUser);
    const savedUser = await user.save();

    expect(savedUser.wallets.length).toBe(0); // Default value for wallets
    expect(savedUser.settings?.notifications.language).toBe(SETTINGS_NOTIFICATION_LANGUAGE_DFAULT); // Default language
    expect(savedUser.operations_in_progress?.transfer).toBe(0); // Default operation values
    expect(savedUser.operations_in_progress?.swap).toBe(0);
    expect(savedUser.operations_in_progress?.mint_nft).toBe(0);
    expect(savedUser.operations_in_progress?.mint_nft_copy).toBe(0);
    expect(savedUser.operations_in_progress?.withdraw_all).toBe(0);
  });

  it('should allow multiple wallets', async () => {
    const validUser: Partial<IUser> = {
      phone_number: '1234567890',
      wallets: [
        {
          wallet_proxy: '0xProxy1',
          wallet_eoa: '0xEoa1',
          sk_hashed: 'hashed-sk-1',
          created_with_chatterpay_proxy_address: '0xChatterpayProxyAddress1',
          chain_id: 1,
          status: 'active'
        } as IUserWallet,
        {
          wallet_proxy: '0xProxy2',
          wallet_eoa: '0xEoa2',
          sk_hashed: 'hashed-sk-2',
          created_with_chatterpay_proxy_address: '0xChatterpayProxyAddress2',
          chain_id: 2,
          status: 'inactive'
        } as IUserWallet
      ]
    };

    const user = new UserModel(validUser);
    const savedUser = await user.save();

    expect(savedUser.wallets.length).toBe(2);
    expect(savedUser.wallets[0].wallet_proxy).toBe('0xProxy1');
    expect(savedUser.wallets[1].status).toBe('inactive');
  });
});

//
// set MONGO_URI in env, then:
// bun run scripts/update_users_wallet_eoa.ts
//
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import mongoose from 'mongoose';

import { Logger } from '../src/helpers/loggerHelper';
import { DEFAULT_CHAIN_ID } from '../src/config/constants';
import { IUser, IUserWallet } from '../src/models/userModel';
import { generatePrivateKey } from '../src/helpers/SecurityHelper';
import { getUserWalletByChainId } from '../src/services/userService';

dotenv.config();

const MONGO_URI: string = process.env.MONGO_URI || 'mongodb://localhost:27017/your_database';
const DB_NAME: string = 'chatterpay-main';
const COLLECTION_NAME: string = 'users';
const justPrint = true;

const userSchema = new mongoose.Schema<IUser>(
  {
    name: String,
    email: String,
    phone_number: String,
    photo: String,
    code: { type: Number, default: null },
    settings: {
      notifications: {
        language: { type: String, default: 'en' }
      }
    },
    wallets: {
      type: [
        {
          wallet_proxy: String,
          wallet_eoa: String,
          sk_hashed: String,
          chatterpay_implementation_address: String,
          chain_id: Number,
          status: String
        }
      ],
      default: []
    }
  },
  { collection: COLLECTION_NAME }
);

const User = mongoose.model<IUser>('User', userSchema);

async function getUsers(): Promise<IUser[]> {
  try {
    const users = await User.find({}).lean<IUser>();
    // @ts-expect-error 'expected error'
    return users;
  } catch (error) {
    Logger.error('Error getting users', error);
    return [];
  }
}

function getUserData(phoneNumber: string): { pk: string; sk: string } {
  const sk = generatePrivateKey(phoneNumber);
  const wallet = new ethers.Wallet(sk);

  return {
    pk: wallet.address,
    sk
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processUser(user: IUser): Promise<void> {
  const phoneNumber = user.phone_number;
  if (!phoneNumber) {
    Logger.warn(`Skipping user without phone number: ${user._id}`);
    return;
  }

  try {
    const userWallet: IUserWallet | null = await getUserWalletByChainId(
      user.wallets,
      DEFAULT_CHAIN_ID
    );
    const { pk } = await getUserData(user.phone_number);

    if (!userWallet) {
      Logger.log(`User ${user.phone_number}, no wallet found for chain_id ${DEFAULT_CHAIN_ID} `);
      return;
    }

    Logger.log(
      `User ${user.phone_number}, currentEOA ${userWallet.wallet_eoa || 'empty'}, newEOA ${pk} `
    );
    if (!justPrint) {
      await User.updateOne({ _id: user._id }, { 'wallets.$.wallet_eoa': pk });
    }
  } catch (error) {
    Logger.error(`Error processing user ${user._id}:`, error);
  }
}

async function main(): Promise<void> {
  try {
    await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
    Logger.log('Connected to the database');

    const users = await getUsers();

    if (users) {
      // eslint-disable-next-line no-restricted-syntax
      for (const user of users) {
        // eslint-disable-next-line no-await-in-loop
        await processUser(user);
      }
    }
  } catch (error) {
    Logger.error('Error in main execution:', error);
  } finally {
    await mongoose.disconnect();
    Logger.log('Connection closed');
  }
}

main();

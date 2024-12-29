//
// set MONGO_URI in env, then:
// bun run scripts/update_users_wallet_eoa.ts
//
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import mongoose from 'mongoose';
import * as crypto from 'crypto';

import { IUser } from '../src/models/user';

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
    wallet: String,
    walletEOA: String,
    code: { type: Number, default: null },
    settings: {
      notifications: {
        language: { type: String, default: 'en' }
      }
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
    console.error('Error getting users', error);
    return [];
  }
}

function getUserData(phoneNumber: string): { pk: string; sk: string } {
  const PRIVATE_KEY_SEED = process.env.PRIVATE_KEY || '';
  if (!PRIVATE_KEY_SEED) {
    throw new Error('PRIVATE_KEY is not set in the environment variables');
  }

  const seed = PRIVATE_KEY_SEED + phoneNumber;
  const sk = `0x${crypto.createHash('sha256').update(seed).digest('hex')}`;
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
    console.warn(`Skipping user without phone number: ${user._id}`);
    return;
  }

  try {
    const { pk } = getUserData(phoneNumber);
    
    console.log(`User ${user.phone_number}, currentEOA ${user.walletEOA || 'empty'}, newEOA ${pk} `)
    if (!justPrint) {
      await User.updateOne({ _id: user._id }, { walletEOA: pk });
    }

  } catch (error) {
    console.error(`Error processing user ${user._id}:`, error);
  }
}

async function main(): Promise<void> {
  try {
    await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
    console.log('Connected to the database');

    const users = await getUsers();

    if (users) {
      // eslint-disable-next-line no-restricted-syntax
      for (const user of users) {
        // eslint-disable-next-line no-await-in-loop
        await processUser(user);
      }
    }
  } catch (error) {
    console.error('Error in main execution:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Connection closed');
  }
}

main();


//
// set MONGO_URI in env, then:
// bun run scripts/fund_users_wallets.ts
//
import axios from 'axios';
import { config } from 'dotenv';
import mongoose from 'mongoose';

import { IUser } from '../src/models/user';
import { Logger } from '../src/utils/logger';

config();

const MONGO_URI: string = process.env.MONGO_URI || 'mongodb://localhost:27017/your_database';
const DB_NAME: string = 'chatterpay-dev';
const COLLECTION_NAME: string = 'users';
const apiEndpoint = process.env.BACKEND_ENDPOINT || '';
const BEARER_TOKEN = process.env.CHATIZALO_TOKEN || '';

const userSchema = new mongoose.Schema<IUser>(
  {
    name: String,
    email: String,
    phone_number: String,
    photo: String,
    wallet: String,
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

// Helper function to introduce a delay
const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function getUsers(): Promise<IUser[]> {
  try {
    await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
    Logger.log('Connected to the database');

    const users = await User.find({}).lean<IUser>();

    // @ts-expect-error 'expected error'
    return users;
  } catch (error) {
    Logger.error('Error getting users', error);
    return [];
  } finally {
    await mongoose.disconnect();
    Logger.log('Connection closed');
  }
}

async function processWallets() {
  try {
    const users = await getUsers();

    if (users.length === 0) {
      Logger.log('No users found.');
      return;
    }

    // Process users in batches of 30
    const batchSize = 40;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);

      // Collect all requests for the current batch
      const requests = batch.map((user) =>
        axios
          .post(
            apiEndpoint,
            { address: user.wallet },
            {
              headers: {
                Authorization: `Bearer ${BEARER_TOKEN}`
              }
            }
          )
          .then((response) => {
            Logger.log(`Success for wallet ${user.wallet}:`, response.data);
          })
          .catch((error) => {
            Logger.error(`Error for wallet ${user.wallet}:`, error.message);
          })
      );

      // Process all requests in the batch concurrently
      Promise.all(requests)
        .then(() => {
          if (i + batchSize < users.length) {
            Logger.log(`Batch complete, waiting for 70 seconds before the next batch...`);
            delay(70000);
          }
        })
        .catch((error) => {
          Logger.error('Error in batch processing:', error.message);
        });
    }
  } catch (error) {
    // @ts-expect-error 'some error'
    Logger.error('General error:', error.message);
  }
}

processWallets();

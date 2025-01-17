import axios from 'axios';
import { config } from 'dotenv';
import mongoose from 'mongoose';

import { IUser } from '../src/models/userModel';
import { Logger } from '../src/helpers/loggerHelper';

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
    wallets: [
      {
        wallet_proxy: String,
        wallet_eoa: String,
        sk_hashed: String,
        chatterpay_implementation_address: String,
        chain_id: Number,
        status: { type: String, default: 'active' }
      }
    ],
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
    Logger.log('getUsers', 'Connected to the database');

    const users = await User.find({}).lean<IUser>();

    // @ts-expect-error 'expected error'
    return users;
  } catch (error) {
    Logger.error('getUsers', error);
    return [];
  } finally {
    await mongoose.disconnect();
    Logger.log('getUsers', 'Connection closed');
  }
}

async function processWallets() {
  try {
    const users = await getUsers();

    if (users.length === 0) {
      Logger.log('processWallets', 'No users found.');
      return;
    }

    // Process users in batches of 40
    const batchSize = 40;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);

      // Collect all requests for the current batch
      const requests = batch.map((user) =>
        // Process each user's wallets and send a request for each active wallet
        user.wallets.map((wallet) =>
          axios
            .post(
              apiEndpoint,
              { address: wallet.wallet_eoa }, // Use wallet_eoa for the request
              {
                headers: {
                  Authorization: `Bearer ${BEARER_TOKEN}`
                }
              }
            )
            .then((response) => {
              Logger.log(
                'processWallets',
                `Success for wallet ${wallet.wallet_eoa}:`,
                response.data
              );
            })
            .catch((error) => {
              Logger.error(
                'processWallets',
                `Error for wallet ${wallet.wallet_eoa}:`,
                error.message
              );
            })
        )
      );

      // Flatten the array of wallet requests and process them concurrently
      Promise.all(requests.flat())
        .then(() => {
          if (i + batchSize < users.length) {
            Logger.log(
              'processWallets',
              `Batch complete, waiting for 70 seconds before the next batch...`
            );
            delay(70000);
          }
        })
        .catch((error) => {
          Logger.error('processWallets', 'Error in batch processing:', error.message);
        });
    }
  } catch (error: unknown) {
    Logger.error('processWallets', 'General error:', (error as Error).message);
  }
}

processWallets();

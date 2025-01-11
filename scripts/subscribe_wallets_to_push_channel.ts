/* eslint-disable no-restricted-syntax */
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import mongoose from 'mongoose';
import * as PushAPI from '@pushprotocol/restapi';
import { ENV } from '@pushprotocol/restapi/src/lib/constants';

import { IUser } from '../src/models/user';
import { Logger } from '../src/helpers/loggerHelper';
import { generatePrivateKey } from '../src/helpers/SecurityHelper';

dotenv.config();

const MONGO_URI: string = process.env.MONGO_URI || 'mongodb://localhost:27017/your_database';
const DB_NAME: string = 'chatterpay-dev';
const COLLECTION_NAME: string = 'users';
const PUSH_NETWORK: string = process.env.PUSH_NETWORK || '11155111';
const PUSH_ENVIRONMENT: ENV = (process.env.PUSH_ENVIRONMENT as ENV) || ENV.DEV;
const PUSH_CHANNEL_ADDRESS: string =
  process.env.PUSH_CHANNEL_ADDRESS || '0x35dad65F60c1A32c9895BE97f6bcE57D32792E83';

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

/**
 * Get all users from the database
 * @returns Array of users
 */
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

/**
 * Get user data based on phone number
 * @param phoneNumber
 * @returns Object containing pk and sk
 */
function getUserData(phoneNumber: string): { pk: string; sk: string } {
  const sk = generatePrivateKey(phoneNumber);
  const wallet = new ethers.Wallet(sk);

  return {
    pk: wallet.address,
    sk
  };
}

/**
 * Check if the user is already subscribed to the Push protocol
 * @param pk - The public key of the user
 * @returns Boolean indicating whether the user is subscribed
 */
async function isUserSubscribed(pk: string): Promise<boolean> {
  try {
    const subscriptions = await PushAPI.user.getSubscriptions({
      user: `eip155:${PUSH_NETWORK}:${pk}`,
      env: PUSH_ENVIRONMENT
    });

    return subscriptions.some(
      (sub: { channel: string; env: string }) => sub.channel === PUSH_CHANNEL_ADDRESS
    );
  } catch (error) {
    Logger.error('Error checking subscription status:', error);
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Subscribe the user to the Push protocol
 * @param pn - The phone number of the user
 * @param sk - The private key of the user
 * @param pk - The public key of the user
 * @returns Boolean indicating whether the subscription was successful
 */
async function subscribeUser(pn: string, sk: string, pk: string): Promise<boolean> {
  const signer = new ethers.Wallet(sk);

  const channelAddress = `eip155:${PUSH_NETWORK}:${PUSH_CHANNEL_ADDRESS}`;
  const userAddress = `eip155:${PUSH_NETWORK}:${pk}`;
  const env = PUSH_ENVIRONMENT;

  Logger.log(`Subscribing ${userAddress} to ${env}.${channelAddress}`);

  const performSubscription = async (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      PushAPI.channels.subscribe({
        channelAddress,
        userAddress,
        signer,
        onSuccess: () => {
          Logger.log(`${pn}, ${pk}, Subscription successful.`);
          resolve(true);
        },
        onError: (error) => {
          Logger.error(`${pn}, ${pk}, Subscription error:`, error.message);
          resolve(false);
        },
        env
      });
    });

  const retrySubscription = async (attemptCount: number): Promise<boolean> => {
    if (attemptCount >= 2) {
      Logger.error(`${pn}, ${pk}, Subscription failed after maximum retries.`);
      return false;
    }

    const result = await performSubscription();
    if (result) {
      return true;
    }

    Logger.warn(`${pn}, ${pk}, Retrying subscription after delay (${attemptCount + 1}/5)...`);
    await delay(60000);

    return retrySubscription(attemptCount + 1);
  };

  return retrySubscription(0);
}

/**
 * Process each user, check their subscription status, and subscribe if necessary
 * @param user - The user object
 */
async function processUser(user: IUser): Promise<void> {
  const phoneNumber = user.phone_number;
  if (!phoneNumber) {
    Logger.warn(`Skipping user without phone number: ${user._id}`);
    return;
  }

  try {
    const { pk, sk } = getUserData(phoneNumber);

    const alreadySubscribed = await isUserSubscribed(pk);
    if (alreadySubscribed) {
      Logger.log(`${phoneNumber}, ${pk}, Already subscribed.`);
      return;
    }

    const subscribed = await subscribeUser(phoneNumber, sk, pk);
    if (!subscribed) {
      Logger.error(
        `${PUSH_NETWORK}, ${PUSH_ENVIRONMENT}, ${phoneNumber}, ${pk}, "Subscription failed after retries."`
      );
    }
  } catch (error) {
    Logger.error(`Error processing user ${user._id}:`, error);
  }
}

/**
 * Main function to execute the script
 */
async function main(): Promise<void> {
  try {
    const users = await getUsers();

    if (users) {
      for (const user of users) {
        // eslint-disable-next-line no-await-in-loop
        await processUser(user);
        Logger.log('Waiting 10 seconds before processing the next user...');
        // eslint-disable-next-line no-await-in-loop
        await delay(10000);
      }
    }
  } catch (error) {
    Logger.error('Error in main execution:', error);
  }
}

main();

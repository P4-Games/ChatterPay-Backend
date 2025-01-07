//
// set MONGO_URI in env, then:
// bun run scripts/subscribe_wallets_to_push_channel.ts
//
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import mongoose from 'mongoose';
import * as PushAPI from '@pushprotocol/restapi';
import { ENV } from '@pushprotocol/restapi/src/lib/constants';

import { IUser } from '../src/models/user';
import { Logger } from '../src/utils/logger';
import { generatePrivateKey } from '../src/utils/keyGenerator';

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

/**
 *
 * @returns
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
 * Get User Data
 * @param phoneNumber
 * @returns
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
 *
 * @param pk
 * @returns
 */
async function isUserSubscribed(pk: string): Promise<boolean> {
  try {
    const subscriptions = await PushAPI.user.getSubscriptions({
      user: `eip155:${PUSH_NETWORK}:${pk}`,
      env: PUSH_ENVIRONMENT
    });

    // sub.channel === channelAddress && sub.env === PUSH_ENVIRONMENT
    return subscriptions.some(
      (sub: { channel: string; env: string }) => sub.channel === PUSH_CHANNEL_ADDRESS
    );
  } catch (error) {
    Logger.error('Error checking subscription status:', error);
    return false;
  }
}

async function subscribeUser(pn: string, sk: string, pk: string): Promise<boolean> {
  const signer = new ethers.Wallet(sk);

  // Función para realizar el intento de suscripción
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

  // Función recursiva para manejar reintentos
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
    await delay(60000); // Esperar 1 minuto antes de reintentar

    return retrySubscription(attemptCount + 1); // Reintentar con un contador incrementado
  };

  // Iniciar reintentos desde el primer intento
  return retrySubscription(0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processUser(user: IUser): Promise<void> {
  const phoneNumber = user.phone_number;
  if (!phoneNumber) {
    Logger.warn(`Skipping user without phone number: ${user._id}`);
    return;
  }

  try {
    const { pk, sk } = getUserData(phoneNumber);

    // Check if user is already subscribed
    const alreadySubscribed = await isUserSubscribed(pk);
    if (alreadySubscribed) {
      Logger.log(`${phoneNumber}, ${pk}, Already subscribed.`);
      return;
    }

    const subscribed = await subscribeUser(phoneNumber, sk, pk);
    if (!subscribed) {
      Logger.error(
        `${PUSH_NETWORK}, ${PUSH_ENVIRONMENT}, ${phoneNumber}, ${pk}, "Subscription failed after retries.`
      );
    }
  } catch (error) {
    Logger.error(`Error processing user ${user._id}:`, error);
  }
}

async function main(): Promise<void> {
  try {
    const users = await getUsers();

    if (users) {
      // eslint-disable-next-line no-restricted-syntax
      for (const user of users) {
        // eslint-disable-next-line no-await-in-loop
        await processUser(user);

        Logger.log('Waiting 10 seconds before processing the next user...');
        // eslint-disable-next-line no-await-in-loop
        await delay(10000); // 10 segundos
      }
    }
  } catch (error) {
    Logger.error('Error in main execution:', error);
  }
}

main();

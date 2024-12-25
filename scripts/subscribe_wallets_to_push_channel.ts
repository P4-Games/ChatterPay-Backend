//
// set MONGO_URI in env, then:
// bun run scripts/subscribe_wallets_to_push_channel.ts
import dotenv from "dotenv";
import { ethers } from 'ethers';
import mongoose from "mongoose";
import * as crypto from 'crypto';
// 
import * as PushAPI from '@pushprotocol/restapi';
import { ENV } from '@pushprotocol/restapi/src/lib/constants';

import { IUser } from '../src/models/user';

dotenv.config();

const MONGO_URI: string = process.env.MONGO_URI || "mongodb://localhost:27017/your_database";
const DB_NAME: string = "chatterpay-dev";
const COLLECTION_NAME: string = "users";

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
                language: { type: String, default: "en" },
            },
        },
    },
    { collection: COLLECTION_NAME }
);

const User = mongoose.model<IUser>("User", userSchema);

async function getUsers(): Promise<IUser[]> {
    try {
        await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
        console.log("Connected to the database");
        
        const users = await User.find({}).lean<IUser>(); // Usamos lean y especificamos el tipo `IUser`

        // @ts-expect-error 'expected error'
        return users; 

    } catch (error) {
        console.error("Error getting users", error);
        return [];
    } finally {
        await mongoose.disconnect();
        console.log("Connection closed");
    }
}

function getUserData(phoneNumber: string): { pk: string; sk: string } {
    const PRIVATE_KEY_SEED = process.env.PRIVATE_KEY || "";
    if (!PRIVATE_KEY_SEED) {
        throw new Error("PRIVATE_KEY is not set in the environment variables");
    }

    const seed = PRIVATE_KEY_SEED + phoneNumber;
    const sk = `0x${crypto.createHash('sha256').update(seed).digest('hex')}`;
    const wallet = new ethers.Wallet(sk);

    return {
        pk: wallet.address,
        sk
    };
}

async function isUserSubscribed(pk: string): Promise<boolean> {
    try {
        const subscriptions = await PushAPI.user.getSubscriptions({
            user: `eip155:11155111:${pk}`,
            env: ENV.DEV,
        });

        const channelAddress = '0x35dad65F60c1A32c9895BE97f6bcE57D32792E83';
        return subscriptions.some((sub: { channel: string; }) => sub.channel === channelAddress);
    } catch (error) {
        console.error('Error checking subscription status:', error);
        return false;
    }
}

async function subscribeUser(pn: string, sk: string, pk: string): Promise<boolean> {
    const signer = new ethers.Wallet(sk);

    // Función para realizar el intento de suscripción
    const performSubscription = async (): Promise<boolean> => new Promise<boolean>((resolve) => {
            PushAPI.channels.subscribe({
                channelAddress: 'eip155:11155111:0x35dad65F60c1A32c9895BE97f6bcE57D32792E83',
                userAddress: `eip155:11155111:${pk}`,
                signer,
                onSuccess: () => {
                    console.log(`${pn}, ${pk}, Subscription successful.`);
                    resolve(true);
                },
                onError: (error) => {
                    console.error(`${pn}, ${pk}, Subscription error:`, error.message);
                    resolve(false);
                },
                env: ENV.DEV,
            });
        });

    // Función recursiva para manejar reintentos
    const retrySubscription = async (attemptCount: number): Promise<boolean> => {
        if (attemptCount >= 2) {
            console.error(`${pn}, ${pk}, Subscription failed after maximum retries.`);
            return false;
        }

        const result = await performSubscription();
        if (result) {
            return true;
        }

        console.warn(`${pn}, ${pk}, Retrying subscription after delay (${attemptCount + 1}/5)...`);
        await delay(60000); // Esperar 1 minuto antes de reintentar

        return retrySubscription(attemptCount + 1); // Reintentar con un contador incrementado
    };

    // Iniciar reintentos desde el primer intento
    return retrySubscription(0);
}


function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {setTimeout(resolve, ms)});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processUser(user: IUser): Promise<void> {
    const phoneNumber = user.phone_number;
    if (!phoneNumber) {
        console.warn(`Skipping user without phone number: ${user._id}`);
        return;
    }

    try {
        const { pk, sk } = getUserData(phoneNumber);

        // Check if user is already subscribed
        const alreadySubscribed = await isUserSubscribed(pk);
        if (alreadySubscribed) {
            console.log(`${phoneNumber}, ${pk}, Already subscribed.`);
            return;
        }

        const subscribed = await subscribeUser(phoneNumber, sk, pk);
        if (!subscribed) {
            console.error(`${phoneNumber}, ${pk}, Subscription failed after retries.`);
        }
    } catch (error) {
        console.error(`Error processing user ${user._id}:`, error);
    }
}

async function main(): Promise<void> {
    try {
        const users = await getUsers();

        // Map users to promises without `await` in the loop
        if (users) {
            const tasks = users.map((user: IUser) => processUser(user));
            // Wait for all tasks to complete
            await Promise.all(tasks);
        }
    } catch (error) {
        console.error('Error in main execution:', error);
    }
}

main();

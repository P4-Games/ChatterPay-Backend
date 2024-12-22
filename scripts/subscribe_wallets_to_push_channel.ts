//
// set MONGO_URI in env, then:
// bun run scripts/subscribe_wallets_to_push_channel.ts
// 
import * as PushAPI from '@pushprotocol/restapi';
import { ENV } from '@pushprotocol/restapi/src/lib/constants';
import * as crypto from 'crypto';
import dotenv from "dotenv";
import { ethers } from 'ethers';
import mongoose from "mongoose";

dotenv.config();

// MongoDB configuration
const MONGO_URI: string = process.env.MONGO_URI || "mongodb://localhost:27017/your_database";
const DB_NAME: string = "chatterpay-dev";
const COLLECTION_NAME: string = "users";

// User schema definition
const userSchema = new mongoose.Schema(
    {
        name: String,
        email: String,
        phone_number: String,
        photo: String,
        wallet: String,
        code: { type: String, default: null },
        settings: {
            notifications: {
                language: { type: String, default: "en" },
            },
        },
    },
    { collection: COLLECTION_NAME }
);

const User = mongoose.model("User", userSchema);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getUsers(): Promise<any[]> {
    try {
        await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
        console.log("Connected to the database");

        const users = await User.find({}); 
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
    const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
    if (!PRIVATE_KEY) {
        throw new Error("PRIVATE_KEY is not set in the environment variables");
    }

    const seed = PRIVATE_KEY + phoneNumber;
    const sk = `0x${crypto.createHash('sha256').update(seed).digest('hex')}`;
    const wallet = new ethers.Wallet(sk);

    return {
        pk: wallet.address,
        sk
    };
}

async function subscribeUser(pn: string, sk: string, pk: string): Promise<boolean> {
    try {
        const signer = new ethers.Wallet(sk);
        let result:boolean = false;

        await PushAPI.channels.subscribe({
            channelAddress: 'eip155:421614:0x35dad65F60c1A32c9895BE97f6bcE57D32792E83',
            userAddress: `eip155:421614:${pk}`,
            signer,
            onSuccess: () => {
                console.log(`${pn}, ${pk}, Subscription successful.`);
                result = true;
            },
            onError: (error) => {
                console.log(`${pn}, ${pk}, Subscription error!`, error.message);
                result = false;
            },
            env: ENV.DEV,
        });

        return result;
    } catch (error) {
        console.error('Error during subscription:', error);
        return false;
    }
}

function delay(ms: number): Promise<void> {
    // eslint-disable-next-line no-promise-executor-return
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    try {
        const users = await getUsers();

        users.map(async (user) => {
            const phoneNumber = user.phone_number;
            if (!phoneNumber) {
                console.warn(`Skipping user without phone number: ${user._id}`);
                return `${user._id}, , false`;
            }

            try {
                const { pk, sk } = getUserData(phoneNumber);

                // Add delay to prevent rate limit issues
                await delay(60000);

                const subscribed = await subscribeUser(phoneNumber, sk, pk);
                return `${phoneNumber}, ${user.wallet || ''}, ${subscribed}`;
            } catch (error) {
                console.error(`Error processing user ${user._id}:`, error);
                return `${phoneNumber}, ${user.wallet || ''}, false`;
            }
        })

    } catch (error) {
        console.error('Error in main execution:', error);
    }
}

main();

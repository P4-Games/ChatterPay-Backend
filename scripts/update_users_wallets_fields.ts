//
// set MONGO_URI in env, then:
// bun run scripts/update_users_wallets_fields.ts
//

import dotenv from 'dotenv';
import mongoose, { ObjectId } from 'mongoose';

import { Logger } from '../src/helpers/loggerHelper';

dotenv.config();

const MONGO_URI: string = process.env.MONGO_URI || 'mongodb://localhost:27017/chatterpay-dev';
const DB_NAME: string = 'chatterpay-dev';
const COLLECTION_NAME = 'users';
const justPrint = true;

const FACTORY_ADDRESS = '0xE17Ca047427557C3bdeD9d151a823D8e2B514e74';
const CHATTERPAY_PROXY_ADDRESS = '0xF07E2De1E32e8F5E43a8CA3BC2e0828F50154673';

interface Wallet {
  created_with_chatterpay_proxy_address?: string;
  created_with_factory_address?: string;
  chatterpay_implementation_address?: string;
  [key: string]: unknown;
}

interface UserDoc {
  _id: ObjectId;
  wallets?: Wallet[];
}

const userSchema = new mongoose.Schema(
  {
    wallets: { type: Array, default: [] }
  },
  { collection: COLLECTION_NAME }
);

const User = mongoose.model('User', userSchema);

async function main(): Promise<void> {
  try {
    await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
    Logger.log('✅ Connected to MongoDB');

    const users = (await User.find({}).lean()) as unknown as UserDoc[];

    const updatePromises = users.map((user) => {
      if (!Array.isArray(user.wallets)) return Promise.resolve();

      Logger.log(`Updating user ${user._id}`);

      if (!justPrint) {
        return User.updateOne(
          { _id: user._id },
          {
            $set: {
              'wallets.$[elem].created_with_chatterpay_proxy_address': CHATTERPAY_PROXY_ADDRESS,
              'wallets.$[elem].created_with_factory_address': FACTORY_ADDRESS
            },
            $unset: {
              'wallets.$[elem].chatterpay_implementation_address': ''
            }
          },
          {
            arrayFilters: [{}] // aplica a todos los wallets
          }
        );
      }

      Logger.log(
        '  SIMULATED $set:',
        JSON.stringify(
          {
            'wallets.$[elem].created_with_chatterpay_proxy_address': CHATTERPAY_PROXY_ADDRESS,
            'wallets.$[elem].created_with_factory_address': FACTORY_ADDRESS
          },
          null,
          2
        )
      );
      Logger.log('  SIMULATED $unset: { "wallets.$[elem].chatterpay_implementation_address": "" }');

      return Promise.resolve();
    });

    await Promise.all(updatePromises);
  } catch (err) {
    Logger.error('❌ Error during execution:', err);
  } finally {
    await mongoose.disconnect();
    Logger.log('🔌 Disconnected from MongoDB');
  }
}

main();

//
// set MONGO_URI in env, then:
// bun run scripts/update_users_wallet_data.ts
//
import dotenv from 'dotenv';
import mongoose, { Schema, Document } from 'mongoose';

import { Logger } from '../src/helpers/loggerHelper';

dotenv.config();

const MONGO_URI: string = process.env.MONGO_URI || 'mongodb://localhost:27017/your_database';
const DB_NAME: string = 'chatterpay-dev';

interface NotificationsSettings {
  language: string;
}

interface UserSettings {
  notifications: NotificationsSettings;
}

interface OperationsInProgress {
  transfer: number;
  swap: number;
  mint_nft: number;
  mint_nft_copy: number;
  withdraw_all: number;
}

interface Wallet {
  wallet_proxy: string;
  wallet_eoa: string;
  sk_hashed: string;
  chatterpay_implementation_address: string;
  chain_id: number;
  status: string;
}

interface User extends Document {
  name: string;
  email: string;
  phone_number: string;
  photo: string;
  code: string | null;
  wallets: Wallet[];
  settings: UserSettings;
  operations_in_progress: OperationsInProgress;
}

const WalletSchema = new Schema<Wallet>({
  wallet_proxy: { type: String, required: true, default: '' },
  wallet_eoa: { type: String, required: true, default: '' },
  sk_hashed: { type: String, required: true, default: '' },
  chatterpay_implementation_address: {
    type: String,
    required: true,
    default: '0xB8CEe9f4e71198d4E995aC4142DeDAc7f5BE1557'
  },
  chain_id: { type: Number, required: true, default: 421614 },
  status: { type: String, required: true, default: 'active' }
});

const UserSchema = new Schema<User>({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone_number: { type: String, required: true },
  photo: { type: String, required: false },
  code: { type: String, default: null },
  wallets: { type: [WalletSchema], default: [] },
  settings: {
    notifications: {
      language: { type: String, required: true, default: 'en' }
    }
  },
  operations_in_progress: {
    transfer: { type: Number, required: true, default: 0 },
    swap: { type: Number, required: true, default: 0 },
    mint_nft: { type: Number, required: true, default: 0 },
    mint_nft_copy: { type: Number, required: true, default: 0 },
    withdraw_all: { type: Number, required: true, default: 0 }
  }
});

const UserModel = mongoose.model<User>('User', UserSchema);

async function migrateWalletFields(): Promise<void> {
  try {
    await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
    Logger.log('Conectado a la base de datos');

    const updateResult = await UserModel.updateMany({}, [
      {
        $set: {
          wallets: {
            $concatArrays: [
              {
                $cond: {
                  if: {
                    $or: [
                      { $ne: ['$wallet', null] },
                      { $ne: ['$walletEOA', null] },
                      { $ne: ['$privateKey', null] }
                    ]
                  },
                  then: [
                    {
                      wallet_proxy: { $ifNull: ['$wallet', ''] },
                      wallet_eoa: { $ifNull: ['$walletEOA', ''] },
                      sk_hashed: { $ifNull: ['$privateKey', ''] },
                      chatterpay_implementation_address:
                        '0xB8CEe9f4e71198d4E995aC4142DeDAc7f5BE1557',
                      chain_id: 421614,
                      status: 'active'
                    }
                  ],
                  else: []
                }
              }
            ]
          }
        }
      },
      {
        $unset: ['wallet', 'walletEOA', 'privateKey']
      }
    ]);

    Logger.log(`Se actualizaron ${updateResult.modifiedCount} documentos.`);
  } catch (error) {
    Logger.error('Error actualizando documentos:', error);
  } finally {
    // Cerrar conexión
    await mongoose.disconnect();
    Logger.log('Conexión cerrada');
  }
}

// Ejecutar el script
migrateWalletFields();

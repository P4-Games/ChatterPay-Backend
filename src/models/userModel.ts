import { model, Schema, Document } from 'mongoose';

import { DEFAULT_CHAIN_ID, SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT } from '../config/constants';

export interface IUserWallet {
  wallet_proxy: string;
  wallet_eoa: string;
  created_with_chatterpay_proxy_address: string;
  created_with_factory_address: string;
  chain_id: number;
  status: string;
}

export interface IUser extends Document {
  name: string;
  email: string;
  phone_number: string;
  photo: string;
  code: number;
  creationDate?: Date;
  wallets: IUserWallet[];
  settings?: {
    notifications: {
      language: string;
    };
  };
  lastOperationDate?: Date;
  operations_in_progress?: {
    transfer: number;
    swap: number;
    mint_nft: number;
    mint_nft_copy: number;
    withdraw_all: number;
  };
  level: string;
  operations_counters?: {
    transfer: Record<string, number>;
    swap: Record<string, number>;
    mint_nft: Record<string, number>;
    mint_nft_copy: Record<string, number>;
  };
  manteca_user_id?: string;
  games_admin?: boolean;
}

const walletSchema = new Schema<IUserWallet>(
  {
    wallet_proxy: { type: String, required: true, default: '' },
    wallet_eoa: { type: String, required: true, default: '' },
    created_with_chatterpay_proxy_address: {
      type: String,
      required: false,
      default: ''
    },
    created_with_factory_address: {
      type: String,
      required: false,
      default: ''
    },
    chain_id: { type: Number, required: true, default: DEFAULT_CHAIN_ID },
    status: { type: String, required: true, default: 'active' }
  },
  { _id: false }
);

const userSchema = new Schema<IUser>({
  name: { type: String, required: false },
  email: { type: String, required: false },
  phone_number: { type: String, required: true },
  photo: { type: String, required: false },
  creationDate: { type: Date, required: false },
  code: { type: Number, required: false },
  wallets: { type: [walletSchema], default: [] },
  settings: {
    notifications: {
      language: { type: String, required: true, default: SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT }
    }
  },
  lastOperationDate: { type: Date, required: false },
  operations_in_progress: {
    transfer: { type: Number, required: false, default: 0 },
    swap: { type: Number, required: false, default: 0 },
    mint_nft: { type: Number, required: false, default: 0 },
    mint_nft_copy: { type: Number, required: false, default: 0 },
    withdraw_all: { type: Number, required: false, default: 0 }
  },
  level: { type: String, required: true, default: 'L1' },
  operations_counters: {
    transfer: { type: Map, of: Number, default: {} },
    swap: { type: Map, of: Number, default: {} },
    mint_nft: { type: Map, of: Number, default: {} },
    mint_nft_copy: { type: Map, of: Number, default: {} }
  },
  manteca_user_id: { type: String, required: false, default: '' },
  games_admin: { type: Boolean, required: false, default: false }
});

export const UserModel = model<IUser>('User', userSchema, 'users');

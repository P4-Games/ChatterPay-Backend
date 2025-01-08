import { model, Schema, Document } from 'mongoose';

import { DEFAULT_CHAIN_ID, SETTINGS_NOTIFICATION_LANGUAGE_DFAULT } from '../config/constants';

export interface IUserWallet {
  wallet_proxy: string;
  wallet_eoa: string;
  sk_hashed: string;
  chatterpay_implementation_address: string;
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
  operations_in_progress?: {
    transfer: number;
    swap: number;
    mint_nft: number;
    mint_nft_copy: number;
    withdraw_all: number;
  };
}

const walletSchema = new Schema<IUserWallet>({
  wallet_proxy: { type: String, required: true, default: '' },
  wallet_eoa: { type: String, required: true, default: '' },
  sk_hashed: { type: String, required: true, default: '' },
  chatterpay_implementation_address: {
    type: String,
    required: true,
    default: ''
  },
  chain_id: { type: Number, required: true, default: DEFAULT_CHAIN_ID },
  status: { type: String, required: true, default: 'active' }
});

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
      language: { type: String, required: true, default: SETTINGS_NOTIFICATION_LANGUAGE_DFAULT }
    }
  },
  operations_in_progress: {
    transfer: { type: Number, required: false, default: 0 },
    swap: { type: Number, required: false, default: 0 },
    mint_nft: { type: Number, required: false, default: 0 },
    mint_nft_copy: { type: Number, required: false, default: 0 },
    withdraw_all: { type: Number, required: false, default: 0 }
  }
});

export const User = model<IUser>('User', userSchema, 'users');

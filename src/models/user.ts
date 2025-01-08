import { model, Schema, Document } from 'mongoose';

import { SETTINGS_NOTIFICATION_LANGUAGE_DFAULT } from '../config/constants';

export interface IUser extends Document {
  name: string;
  email: string;
  phone_number: string;
  photo: string;
  wallet: string;
  walletEOA: string;
  code: number;
  privateKey: string;
  creationDate?: Date;
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

const userSchema = new Schema<IUser>({
  name: { type: String, required: false },
  email: { type: String, required: false },
  phone_number: { type: String, required: true },
  photo: { type: String, required: false },
  wallet: { type: String, required: true },
  walletEOA: { type: String, required: false },
  privateKey: { type: String, required: true },
  creationDate: { type: Date, required: true },
  code: { type: Number, required: false },
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

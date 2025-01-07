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
  settings?: {
    notifications: {
      language: string;
    };
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
  code: { type: Number, required: false },
  settings: {
    notifications: {
      language: { type: String, required: true, default: SETTINGS_NOTIFICATION_LANGUAGE_DFAULT }
    }
  }
});

export const User = model<IUser>('User', userSchema, 'users');

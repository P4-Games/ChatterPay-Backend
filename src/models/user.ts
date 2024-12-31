import { model, Schema, Document } from 'mongoose';

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
      language: { type: String, required: true, default: 'en' }
    }
  }
});

export const User = model<IUser>('User', userSchema, 'users');

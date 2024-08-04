import { Schema, model, Document } from 'mongoose';

export interface IUser extends Document {
  name: string;
  email: string;
  phone_number: string;
  photo: string;
  wallet: string;
  code: number;
  privateKey: string;
}

const userSchema = new Schema<IUser>({
  name: { type: String, required: false },
  email: { type: String, required: false },
  phone_number: { type: String, required: true },
  photo: { type: String, required: false },
  wallet: { type: String, required: true },
  privateKey: { type: String, required: true },
  code: { type: Number, required: false }
});

export const User = model<IUser>('User', userSchema, 'users');

export default User;

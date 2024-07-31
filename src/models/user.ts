import { Schema, model, Document } from 'mongoose';

export interface IUser extends Document {
  name: string;
  email: string;
  phone_number: string;
  photo: string;
  wallet: string;
  code: number;
}

const userSchema = new Schema<IUser>({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone_number: { type: String, required: true },
  photo: { type: String, required: true },
  wallet: { type: String, required: true },
  code: { type: Number, required: true }
});

const User = model<IUser>('User', userSchema, 'users');

export default User;

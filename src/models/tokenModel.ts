import { model, Schema, Document } from 'mongoose';

export interface IToken extends Document {
  name: string;
  chain_id: number;
  decimals: number;
  logo: string;
  address: string;
  symbol: string;
  type: string;
}

const tokenSchema = new Schema<IToken>({
  name: { type: String, required: true },
  chain_id: { type: Number, required: true },
  decimals: { type: Number, required: true },
  address: { type: String, required: true, unique: true },
  logo: { type: String, required: false },
  symbol: { type: String, required: true },
  type: { type: String, required: true }
});

const Token = model<IToken>('Token', tokenSchema, 'tokens');

export default Token;

import { model, Schema, Document } from 'mongoose';

export interface ITransaction extends Document {
  trx_hash: string;
  wallet_from: string;
  wallet_to: string;
  type: string;
  date: Date;
  status: string;
  amount: number;
  token: string;
}

const transactionSchema = new Schema<ITransaction>({
  trx_hash: { type: String, required: true },
  wallet_from: { type: String, required: true },
  wallet_to: { type: String, required: true },
  type: { type: String, required: true },
  date: { type: Date, required: true },
  status: { type: String, required: true },
  amount: { type: Number, required: true },
  token: { type: String, required: true }
});

transactionSchema.index(
  { trx_hash: 1, wallet_from: 1, wallet_to: 1 },
  { name: 'trx_hash_wallet_from_to', unique: true }
);

const Transaction = model<ITransaction>('Transaction', transactionSchema, 'transactions');

export default Transaction;

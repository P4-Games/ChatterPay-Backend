import { Schema, model, Document } from 'mongoose';

export interface IBlockchain extends Document {
  name: string;
  chain_id: number;
  rpc: string;
  logo: string;
  explorer: string;
}

const blockchainSchema = new Schema<IBlockchain>({
  name: { type: String, required: true },
  chain_id: { type: Number, required: true },
  rpc: { type: String, required: true },
  logo: { type: String, required: true },
  explorer: { type: String, required: true }
});

const Blockchain = model<IBlockchain>('Blockchain', blockchainSchema, 'blockchains');

export default Blockchain;

import { model, Schema, Document } from 'mongoose';

export interface IBlockchain extends Document {
  name: string;
  chain_id: number;
  rpc: string;
  logo: string;
  explorer: string;
  scan_apikey: string;
  marketplace_opensea_url: string;
  environment: string;
  contracts: {
    entryPoint: string;
    factoryAddress: string;
    chatterPayAddress: string;
    simpleSwapAddress: string;
    chatterNFTAddress: string;
    paymasterAddress?: string;
  };
}

const blockchainSchema = new Schema<IBlockchain>({
  name: { type: String, required: true },
  chain_id: { type: Number, required: true },
  rpc: { type: String, required: true },
  logo: { type: String, required: true },
  explorer: { type: String, required: true },
  scan_apikey: { type: String, required: true },
  environment: { type: String, required: true },
  contracts: {
    entryPoint: { type: String, required: false },
    factoryAddress: { type: String, required: false },
    chatterPayAddress: { type: String, required: false },
    simpleSwapAddress: { type: String, required: false },
    chatterNFTAddress: { type: String, required: false },
    paymasterAddress: { type: String, required: false }
  }
});

const Blockchain = model<IBlockchain>('Blockchain', blockchainSchema, 'blockchains');

export default Blockchain;

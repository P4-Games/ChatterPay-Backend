import { model, Schema, Document } from 'mongoose';

export interface IBlockchain extends Document {
  name: string;
  chain_id: number;
  rpc: string;
  bundlerUrl?: string;
  logo: string;
  explorer: string;
  scan_apikey: string;
  marketplace_opensea_url: string;
  environment: string;
  contracts: {
    entryPoint: string;
    factoryAddress: string;
    chatterPayAddress: string;
    chatterNFTAddress: string;
    paymasterAddress?: string;
    routerAddress?: string;
  };
}

const blockchainSchema = new Schema<IBlockchain>({
  name: { type: String, required: true },
  chain_id: { type: Number, required: true },
  rpc: { type: String, required: true },
  bundlerUrl: { type: String, required: false },
  logo: { type: String, required: true },
  explorer: { type: String, required: true },
  scan_apikey: { type: String, required: true },
  marketplace_opensea_url: { type: String, required: true },
  environment: { type: String, required: true },
  contracts: {
    entryPoint: { type: String, required: false },
    factoryAddress: { type: String, required: false },
    chatterPayAddress: { type: String, required: false },
    chatterNFTAddress: { type: String, required: false },
    paymasterAddress: { type: String, required: false },
    routerAddress: { type: String, required: false }
  }
});

const Blockchain = model<IBlockchain>('Blockchain', blockchainSchema, 'blockchains');

export default Blockchain;

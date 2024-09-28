import { model, Schema, Document } from 'mongoose';

export interface IBlockchain extends Document {
    name: string;
    chain_id: number;
    rpc: string;
    logo: string;
    explorer: string;
    signingKey: string;
    entryPoint: string;
    factoryAddress: string;
    chatterPayAddress: string;
    chatterPayBeaconAddress: string;
    chatterNFTAddress: string;
}

const blockchainSchema = new Schema<IBlockchain>({
    name: { type: String, required: true },
    chain_id: { type: Number, required: true },
    rpc: { type: String, required: true },
    logo: { type: String, required: true },
    explorer: { type: String, required: true },
    signingKey: { type: String, required: true },
    entryPoint: { type: String, required: true },
    factoryAddress: { type: String, required: true },
    chatterPayAddress: { type: String, required: true },
    chatterPayBeaconAddress: { type: String, required: true },
    chatterNFTAddress: { type: String, required: true },
});

const Blockchain = model<IBlockchain>('Blockchain', blockchainSchema, 'blockchains');

export default Blockchain;

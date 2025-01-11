import { model, Schema, Document } from 'mongoose';

export interface INFTMetadata {
  image_url: {
    gcp?: string;
    icp?: string;
    ipfs?: string;
  };
  description: string;
  geolocation?: {
    latitud: string;
    longitud: string;
  };
}

export interface INFT extends Document {
  channel_user_id: string;
  id: string;
  wallet: string;
  trxId: string;
  timestamp: Date;
  original: boolean;
  total_of_this: number;
  copy_of?: string;
  copy_order: number;
  copy_of_original?: string | null;
  copy_order_original: number;
  metadata: INFTMetadata;
}

const NFTSchema = new Schema<INFT>({
  channel_user_id: { type: String, required: true },
  id: { type: String, required: true },
  wallet: { type: String, required: true },
  trxId: { type: String, required: true },
  timestamp: { type: Date, required: true },
  original: { type: Boolean, required: true },
  total_of_this: { type: Number, required: true },
  copy_of: { type: String, required: false },
  copy_order: { type: Number, required: true },
  copy_of_original: { type: String, required: false },
  copy_order_original: { type: Number, required: true },
  metadata: {
    image_url: {
      type: new Schema(
        {
          gcp: { type: String, required: false },
          icp: { type: String, required: false },
          ipfs: { type: String, required: false }
        },
        { _id: false }
      ),
      required: true
    },
    description: { type: String, required: true },
    geolocation: {
      type: new Schema(
        {
          longitud: { type: String, required: false },
          latitud: { type: String, required: false }
        },
        { _id: false }
      ),
      required: false
    }
  }
});

const NFTModel = model<INFT>('NFTs', NFTSchema, 'nfts');

export default NFTModel;

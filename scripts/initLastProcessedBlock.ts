import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Alchemy, Network } from 'alchemy-sdk';

import { Logger } from '../src/helpers/loggerHelper';

dotenv.config();

const MONGODB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/your_database';
const NETWORK_NAME = 'ARBITRUM_SEPOLIA';

const settings = {
  apiKey: process.env.ALCHEMY_API_KEY,
  network: Network.ARB_SEPOLIA
};
const alchemy = new Alchemy(settings);

const LastProcessedBlockSchema = new mongoose.Schema({
  networkName: { type: String, required: true, unique: true },
  blockNumber: { type: Number, required: true },
  updatedAt: { type: Date, default: Date.now }
});

const LastProcessedBlock = mongoose.model('LastProcessedBlock', LastProcessedBlockSchema);

/**
 * Get Lastest Block Number
 * @returns
 */
async function getLatestBlockNumber(): Promise<number> {
  const latestBlock = await alchemy.core.getBlockNumber();
  return latestBlock;
}

/**
 * Initialize Last Processed Block
 */
async function initializeLastProcessedBlock() {
  try {
    await mongoose.connect(MONGODB_URI);
    Logger.log('initializeLastProcessedBlock', 'Conectado a MongoDB');

    const latestBlockNumber = await getLatestBlockNumber();
    Logger.log(
      'initializeLastProcessedBlock',
      `Last block number in network: ${latestBlockNumber}`
    );

    const result = await LastProcessedBlock.findOneAndUpdate(
      { networkName: NETWORK_NAME },
      {
        blockNumber: latestBlockNumber,
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    );

    Logger.log(
      'initializeLastProcessedBlock',
      `LastProcessedBlock actualizado/creado: ${JSON.stringify(result)}`
    );
  } catch (error) {
    Logger.error('initializeLastProcessedBlock', error);
  } finally {
    await mongoose.disconnect();
    Logger.log('initializeLastProcessedBlock', 'Desconectado de MongoDB');
  }
}

initializeLastProcessedBlock().catch((error) =>
  Logger.error('initializeLastProcessedBlock', error)
);

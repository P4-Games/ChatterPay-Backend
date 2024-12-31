import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Alchemy, Network } from 'alchemy-sdk';

import { Logger } from '../src/utils/logger';

dotenv.config();

const MONGODB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/your_database';
const NETWORK_NAME = 'ARBITRUM_SEPOLIA';

// Configuración de Alchemy
const settings = {
  apiKey: process.env.ALCHEMY_API_KEY,
  network: Network.ARB_SEPOLIA
};
const alchemy = new Alchemy(settings);

// Modelo de MongoDB
const LastProcessedBlockSchema = new mongoose.Schema({
  networkName: { type: String, required: true, unique: true },
  blockNumber: { type: Number, required: true },
  updatedAt: { type: Date, default: Date.now }
});

const LastProcessedBlock = mongoose.model('LastProcessedBlock', LastProcessedBlockSchema);

async function getLatestBlockNumber(): Promise<number> {
  const latestBlock = await alchemy.core.getBlockNumber();
  return latestBlock;
}

async function initializeLastProcessedBlock() {
  try {
    await mongoose.connect(MONGODB_URI);
    Logger.log('Conectado a MongoDB');

    const latestBlockNumber = await getLatestBlockNumber();
    Logger.log(`Último número de bloque en Arbitrum Sepolia: ${latestBlockNumber}`);

    const result = await LastProcessedBlock.findOneAndUpdate(
      { networkName: NETWORK_NAME },
      {
        blockNumber: latestBlockNumber,
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    );

    Logger.log(`LastProcessedBlock actualizado/creado: ${JSON.stringify(result)}`);
  } catch (error) {
    Logger.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    Logger.log('Desconectado de MongoDB');
  }
}

// Ejecutar el script
initializeLastProcessedBlock().catch(Logger.error);

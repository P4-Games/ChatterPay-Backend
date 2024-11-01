import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Alchemy, Network } from 'alchemy-sdk';

dotenv.config();

const MONGODB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/your_database';
const NETWORK_NAME = 'ARBITRUM_SEPOLIA';

// Configuración de Alchemy
const settings = {
    apiKey: process.env.ALCHEMY_API_KEY,
    network: Network.ARB_SEPOLIA,
};
const alchemy = new Alchemy(settings);

// Modelo de MongoDB
const LastProcessedBlockSchema = new mongoose.Schema({
    networkName: { type: String, required: true, unique: true },
    blockNumber: { type: Number, required: true },
    updatedAt: { type: Date, default: Date.now },
});

const LastProcessedBlock = mongoose.model('LastProcessedBlock', LastProcessedBlockSchema);

async function getLatestBlockNumber(): Promise<number> {
    const latestBlock = await alchemy.core.getBlockNumber();
    return latestBlock;
}

async function initializeLastProcessedBlock() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Conectado a MongoDB');

        const latestBlockNumber = await getLatestBlockNumber();
        console.log(`Último número de bloque en Arbitrum Sepolia: ${latestBlockNumber}`);

        const result = await LastProcessedBlock.findOneAndUpdate(
            { networkName: NETWORK_NAME },
            {
                blockNumber: latestBlockNumber,
                updatedAt: new Date(),
            },
            { upsert: true, new: true },
        );

        console.log(`LastProcessedBlock actualizado/creado: ${JSON.stringify(result)}`);
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Desconectado de MongoDB');
    }
}

// Ejecutar el script
initializeLastProcessedBlock().catch(console.error);

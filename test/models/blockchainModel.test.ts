import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { it, expect, describe, afterEach, beforeEach } from 'vitest';

import Blockchain, { IBlockchain } from '../../src/models/blockchainModel';

describe('Blockchain Model', () => {
  let mongoServer: MongoMemoryServer;

  beforeEach(async () => {
    // Inicia el servidor de MongoDB en memoria
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    // Conecta Mongoose al servidor en memoria
    await mongoose.disconnect(); // Asegúrate de desconectar cualquier conexión activa
    await mongoose.connect(uri, {});
  });

  afterEach(async () => {
    // Cierra la conexión después de cada prueba
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('should fail to save without required fields', async () => {
    const invalidBlockchain: Partial<IBlockchain> = {
      chain_id: 1,
      rpc: 'https://mainnet.infura.io/v3/YOUR-PROJECT-ID'
    };

    const blockchain = new Blockchain(invalidBlockchain);

    await expect(blockchain.save()).rejects.toThrow(mongoose.Error.ValidationError);
  });

  it('should create and save a blockchain document successfully', async () => {
    const validBlockchain: Partial<IBlockchain> = {
      name: 'Ethereum',
      chain_id: 1,
      rpc: 'https://mainnet.infura.io/v3/YOUR-PROJECT-ID',
      logo: 'https://ethereum.org/logo.png',
      explorer: 'https://etherscan.io',
      scan_apikey: 'example-api-key',
      marketplace_opensea_url: 'https://opensea.io',
      environment: 'production',
      contracts: {
        entryPoint: '0xEntryPointAddress',
        factoryAddress: '0xFactoryAddress',
        chatterPayAddress: '0xChatterPayAddress',
        chatterNFTAddress: '0xChatterNFTAddress'
      }
    };

    const blockchain = new Blockchain(validBlockchain);
    const savedBlockchain = await blockchain.save();

    expect(savedBlockchain._id).toBeDefined();
    expect(savedBlockchain.name).toBe(validBlockchain.name);
    expect(savedBlockchain.chain_id).toBe(validBlockchain.chain_id);
  });
});

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { it, expect, describe, afterEach, beforeEach } from 'vitest';

import NFTModel, { INFT } from '../../src/models/nftModel';

describe('NFT Model', () => {
  let mongoServer: MongoMemoryServer;

  beforeEach(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    await mongoose.disconnect();
    await mongoose.connect(uri, {});
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('should create and save an NFT document successfully', async () => {
    const validNFT: Partial<INFT> = {
      channel_user_id: 'user123',
      id: 'nft123',
      wallet: '0x1234567890abcdef1234567890abcdef12345678',
      trxId: 'trx123',
      timestamp: new Date(),
      original: true,
      total_of_this: 1,
      copy_order: 0,
      copy_order_original: 0,
      minted_contract_address: '0x',
      metadata: {
        image_url: { gcp: 'https://example.com/image.jpg' },
        description: 'Test NFT'
      }
    };

    const nft = new NFTModel(validNFT);
    const savedNFT = await nft.save();

    expect(savedNFT._id).toBeDefined();
    expect(savedNFT.channel_user_id).toBe(validNFT.channel_user_id);
    expect(savedNFT.metadata.description).toBe(validNFT.metadata?.description);
    expect(savedNFT.metadata.image_url.gcp).toBe(validNFT.metadata?.image_url?.gcp);
  });

  it('should fail to save without required fields', async () => {
    const invalidNFT: Partial<INFT> = {
      wallet: '0x1234567890abcdef1234567890abcdef12345678',
      trxId: 'trx123'
    };

    const nft = new NFTModel(invalidNFT);

    await expect(nft.save()).rejects.toThrow(mongoose.Error.ValidationError);
  });

  it('should allow optional fields to be empty', async () => {
    const validNFT: Partial<INFT> = {
      channel_user_id: 'user123',
      id: 'nft123',
      wallet: '0x1234567890abcdef1234567890abcdef12345678',
      trxId: 'trx123',
      timestamp: new Date(),
      original: true,
      total_of_this: 1,
      copy_order: 0,
      copy_order_original: 0,
      minted_contract_address: '0x',
      metadata: {
        image_url: { gcp: 'https://example.com/image.jpg' },
        description: 'Test NFT'
      }
    };

    const nft = new NFTModel(validNFT);
    const savedNFT = await nft.save();

    expect(savedNFT.copy_of).toBeUndefined();
    expect(savedNFT.copy_of_original).toBeUndefined();
    expect(savedNFT.metadata.geolocation).toBeUndefined();
  });

  it('should validate nested metadata fields', async () => {
    const validNFT: Partial<INFT> = {
      channel_user_id: 'user123',
      id: 'nft123',
      wallet: '0x1234567890abcdef1234567890abcdef12345678',
      trxId: 'trx123',
      timestamp: new Date(),
      original: true,
      total_of_this: 1,
      copy_order: 0,
      copy_order_original: 0,
      minted_contract_address: '0x',
      metadata: {
        image_url: { gcp: 'https://example.com/image.jpg', ipfs: 'ipfs://example' },
        description: 'Test NFT with metadata',
        geolocation: { latitud: '40.7128', longitud: '-74.0060' }
      }
    };

    const nft = new NFTModel(validNFT);
    const savedNFT = await nft.save();

    expect(savedNFT.metadata.geolocation?.latitud).toBe('40.7128');
    expect(savedNFT.metadata.geolocation?.longitud).toBe('-74.0060');
    expect(savedNFT.metadata.image_url.ipfs).toBe('ipfs://example');
  });
});

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Token, { type IToken } from '../../src/models/tokenModel';

describe('Token Model', () => {
  let mongoServer: MongoMemoryServer;

  beforeEach(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    await mongoose.disconnect();
    await mongoose.connect(uri, {});
    await Token.syncIndexes(); // Ensures unique indexes in the in-memory database
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('should create and save a Token document successfully with operations limits', async () => {
    const validToken: Partial<IToken> = {
      name: 'Wrapped Ether',
      chain_id: 1,
      decimals: 18,
      display_decimals: 2,
      display_symbol: 'ETH',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      logo: 'https://etherscan.io/token/images/weth_32.png',
      symbol: 'WETH',
      type: 'variable',
      ramp_enabled: false,
      operations_limits: {
        transfer: {
          L1: { min: 2, max: 1000 },
          L2: { min: 2, max: 1000 }
        },
        swap: {
          L1: { min: 2, max: 1000 },
          L2: { min: 2, max: 1000 }
        }
      }
    };

    const token = new Token(validToken);
    const savedToken = await token.save();

    expect(savedToken._id).toBeDefined();
    expect(savedToken.name).toBe(validToken.name);
    expect(savedToken.operations_limits.transfer.L1.min).toBe(2);
    expect(savedToken.operations_limits.transfer.L1.max).toBe(1000);
    expect(savedToken.operations_limits.swap.L2.min).toBe(2);
    expect(savedToken.operations_limits.swap.L2.max).toBe(1000);
  });

  it('should fail to save without required fields', async () => {
    const invalidToken: Partial<IToken> = {
      name: 'Missing Address',
      chain_id: 1,
      decimals: 18,
      logo: 'https://example.com/logo.png',
      symbol: 'MISS'
    };

    const token = new Token(invalidToken);

    await expect(token.save()).rejects.toThrow(mongoose.Error.ValidationError);
  });

  it('should allow the logo field to be empty', async () => {
    const validToken: Partial<IToken> = {
      name: 'No Logo Token',
      chain_id: 1,
      decimals: 6,
      display_decimals: 2,
      display_symbol: 'USDT',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      symbol: 'NOLOGO',
      type: 'stable',
      ramp_enabled: true,
      operations_limits: {
        transfer: {
          L1: { min: 2, max: 1000 },
          L2: { min: 2, max: 1000 }
        },
        swap: {
          L1: { min: 2, max: 1000 },
          L2: { min: 2, max: 1000 }
        }
      }
    };

    const token = new Token(validToken);
    const savedToken = await token.save();

    expect(savedToken.logo).toBeUndefined();
    expect(savedToken.symbol).toBe('NOLOGO');
  });

  it('should fail if address is not unique (duplicate address)', async () => {
    const tokenData: Partial<IToken> = {
      name: 'First Token',
      chain_id: 1,
      decimals: 18,
      display_decimals: 2,
      display_symbol: 'ETH',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      logo: 'https://example.com/logo1.png',
      symbol: 'TOKEN1',
      type: 'variable',
      ramp_enabled: false,
      operations_limits: {
        transfer: {
          L1: { min: 2, max: 1000 },
          L2: { min: 2, max: 1000 }
        },
        swap: {
          L1: { min: 2, max: 1000 },
          L2: { min: 2, max: 1000 }
        }
      }
    };

    const duplicateTokenData: Partial<IToken> = {
      name: 'Duplicate Token',
      chain_id: 1,
      decimals: 18,
      display_decimals: 2,
      display_symbol: 'ETH',
      address: '0x1234567890abcdef1234567890abcdef12345678', // Duplicate address
      logo: 'https://example.com/logo2.png',
      symbol: 'TOKEN2',
      type: 'variable',
      ramp_enabled: false,
      operations_limits: {
        transfer: {
          L1: { min: 2, max: 1000 },
          L2: { min: 2, max: 1000 }
        },
        swap: {
          L1: { min: 2, max: 1000 },
          L2: { min: 2, max: 1000 }
        }
      }
    };

    const token1 = new Token(tokenData);
    await token1.save();

    const token2 = new Token(duplicateTokenData);

    try {
      await token2.save();
    } catch (error: unknown) {
      if (error instanceof mongoose.mongo.MongoServerError) {
        // Verifies the duplicate key error
        expect(error.code).toBe(11000);
        expect(error.message).toContain('E11000 duplicate key error');
      } else {
        // Rethrow unexpected errors
        throw error;
      }
    }
  });
});

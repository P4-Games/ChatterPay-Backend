import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { it, expect, describe, afterEach, beforeEach } from 'vitest';

import Blockchain, { IBlockchain } from '../../src/models/blockchainModel';

describe('Blockchain Model', () => {
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

  it('should create and save a blockchain document successfully', async () => {
    const validBlockchain: Partial<IBlockchain> = {
      name: 'Ethereum',
      chainId: 1,
      rpc: 'https://mainnet.infura.io/v3/YOUR-PROJECT-ID',
      logo: 'https://ethereum.org/logo.png',
      explorer: 'https://etherscan.io',
      marketplaceOpenseaUrl: 'https://opensea.io',
      environment: 'production',
      contracts: {
        entryPoint: '0xEntryPointAddress',
        factoryAddress: '0xFactoryAddress',
        chatterPayAddress: '0xChatterPayAddress',
        routerAddress: '0xUniswapV3Address',
        chatterNFTAddress: '0xChatterNFTAddress'
      },
      gas: {
        operations: {
          transfer: {
            maxFeePerGas: '0.5',
            maxPriorityFeePerGas: '0.05',
            verificationGasLimit: 50000,
            callGasLimit: 149456,
            preVerificationGas: 50000
          },
          swap: {
            maxFeePerGas: '0.5',
            maxPriorityFeePerGas: '0.05',
            verificationGasLimit: 80000,
            callGasLimit: 200000,
            preVerificationGas: 50000
          }
        }
      },
      balances: {
        paymasterMinBalance: '0.05',
        paymasterTargetBalance: '0.1',
        backendSignerMinBalance: '0.01',
        userSignerMinBalance: '0.0008',
        userSignerBalanceToTransfer: '0.001'
      }
    };

    const blockchain = new Blockchain(validBlockchain);
    const savedBlockchain = await blockchain.save();

    expect(savedBlockchain._id).toBeDefined();
    expect(savedBlockchain.name).toBe(validBlockchain.name);
    expect(savedBlockchain.chainId).toBe(validBlockchain.chainId);
    expect(savedBlockchain.gas.operations.transfer.maxFeePerGas).toBe('0.5');
    expect(savedBlockchain.balances.paymasterMinBalance).toBe('0.05');
  });

  it('should fail to save without required fields', async () => {
    const invalidBlockchain: Partial<IBlockchain> = {
      chainId: 1,
      rpc: 'https://mainnet.infura.io/v3/YOUR-PROJECT-ID'
    };

    const blockchain = new Blockchain(invalidBlockchain);

    await expect(blockchain.save()).rejects.toThrow(mongoose.Error.ValidationError);
  });

  it('should allow optional contract fields to be empty', async () => {
    const blockchainData: Partial<IBlockchain> = {
      name: 'Polygon',
      chainId: 137,
      rpc: 'https://polygon-rpc.com',
      logo: 'https://polygon.technology/logo.png',
      explorer: 'https://polygonscan.com',
      marketplaceOpenseaUrl: 'https://opensea.io',
      environment: 'production',
      contracts: {
        entryPoint: '0xEntryPointAddress',
        factoryAddress: '',
        chatterPayAddress: '',
        routerAddress: '',
        chatterNFTAddress: ''
      },
      gas: {
        operations: {
          transfer: {
            maxFeePerGas: '0.5',
            maxPriorityFeePerGas: '0.05',
            verificationGasLimit: 50000,
            callGasLimit: 149456,
            preVerificationGas: 50000
          },
          swap: {
            maxFeePerGas: '0.5',
            maxPriorityFeePerGas: '0.05',
            verificationGasLimit: 80000,
            callGasLimit: 200000,
            preVerificationGas: 50000
          }
        }
      },
      balances: {
        paymasterMinBalance: '0.05',
        paymasterTargetBalance: '0.1',
        backendSignerMinBalance: '0.01',
        userSignerMinBalance: '0.0008',
        userSignerBalanceToTransfer: '0.001'
      }
    };

    const blockchain = new Blockchain(blockchainData);
    const savedBlockchain = await blockchain.save();

    expect(savedBlockchain.contracts.factoryAddress).toBe('');
    expect(savedBlockchain.contracts.paymasterAddress).toBeUndefined(); // Optional field
    expect(savedBlockchain.gas.operations.transfer.maxFeePerGas).toBe('0.5');
    expect(savedBlockchain.balances.userSignerMinBalance).toBe('0.0008');
  });
});

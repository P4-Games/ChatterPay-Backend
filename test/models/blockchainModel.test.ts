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

  it('should fail to save without required fields', async () => {
    const invalidBlockchain: Partial<IBlockchain> = {
      chainId: 1,
      rpc: 'https://mainnet.infura.io/v3/YOUR-PROJECT-ID'
    };

    const blockchain = new Blockchain(invalidBlockchain);
    await expect(blockchain.save()).rejects.toThrow(mongoose.Error.ValidationError);
  });

  it('should create and save a blockchain document successfully', async () => {
    const validBlockchain: IBlockchain = new Blockchain({
      name: 'Ethereum',
      manteca_name: 'ethereum',
      chainId: 1,
      rpc: 'https://mainnet.infura.io/v3/YOUR-PROJECT-ID',
      rpcBundler: 'https://mainnet.infura.io/v3/YOUR-PROJECT-ID',
      logo: 'https://ethereum.org/logo.png',
      explorer: 'https://etherscan.io',
      marketplaceOpenseaUrl: 'https://opensea.io',
      environment: 'production',
      supportsEIP1559: true,
      externalDeposits: {
        lastBlockProcessed: 123456,
        updatedAt: new Date()
      },
      contracts: {
        entryPoint: '0xEntryPointAddress',
        factoryAddress: '0xFactoryAddress',
        chatterPayAddress: '0xChatterPayAddress',
        chatterNFTAddress: '0xChatterNFTAddress',
        paymasterAddress: '0xPaymasterAddress',
        routerAddress: '0xRouterAddress'
      },
      gas: {
        useFixedValues: true,
        operations: {
          transfer: {
            perGasInitialMultiplier: 1.5,
            perGasIncrement: 1.1,
            callDataInitialMultiplier: 1.2,
            maxRetries: 5,
            timeoutMsBetweenRetries: 5000,
            maxFeePerGas: '0.5',
            maxPriorityFeePerGas: '0.05',
            verificationGasLimit: 50000,
            callGasLimit: 149456,
            preVerificationGas: 50000
          },
          swap: {
            perGasInitialMultiplier: 1.5,
            perGasIncrement: 1.1,
            callDataInitialMultiplier: 1.2,
            maxRetries: 5,
            timeoutMsBetweenRetries: 5000,
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
      },
      limits: {
        transfer: {
          L1: { D: 30 },
          L2: { D: 100 }
        },
        swap: {
          L1: { D: 30 },
          L2: { D: 100 }
        },
        mint_nft: {
          L1: { D: 10 },
          L2: { D: 40 }
        },
        mint_nft_copy: {
          L1: { D: 10 },
          L2: { D: 40 }
        }
      }
    });

    const savedBlockchain = await validBlockchain.save();

    expect(savedBlockchain._id).toBeDefined();
    expect(savedBlockchain.name).toBe(validBlockchain.name);
    expect(savedBlockchain.chainId).toBe(validBlockchain.chainId);
    expect(savedBlockchain.gas.operations.transfer.maxFeePerGas).toBe('0.5');
    expect(savedBlockchain.balances.paymasterMinBalance).toBe('0.05');
    expect(savedBlockchain.limits.transfer.L1.D).toBe(30);
    expect(savedBlockchain.limits.mint_nft.L2.D).toBe(40);
    expect(savedBlockchain.externalDeposits.lastBlockProcessed).toBe(123456);
    expect(savedBlockchain.externalDeposits.updatedAt).toBeInstanceOf(Date);
  });
});

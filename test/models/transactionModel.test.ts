import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { it, expect, describe, afterEach, beforeEach } from 'vitest';

import Transaction, { ITransaction } from '../../src/models/transactionModel';

describe('Transaction Model', () => {
  let mongoServer: MongoMemoryServer;

  beforeEach(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    await mongoose.disconnect();
    await mongoose.connect(uri, {});
    await Transaction.syncIndexes(); // Ensures unique indexes
  });

  afterEach(async () => {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  it('should create and save a Transaction document successfully', async () => {
    const validTransaction: Partial<ITransaction> = {
      trx_hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      wallet_from: '0xFromWallet',
      wallet_to: '0xToWallet',
      type: 'transfer',
      date: new Date(),
      status: 'completed',
      amount: 100.5,
      fee: 0.5,
      token: 'ETH',
      chain_id: 1
    };

    const transaction = new Transaction(validTransaction);
    const savedTransaction = await transaction.save();

    expect(savedTransaction._id).toBeDefined();
    expect(savedTransaction.trx_hash).toBe(validTransaction.trx_hash);
    expect(savedTransaction.wallet_from).toBe(validTransaction.wallet_from);
    expect(savedTransaction.wallet_to).toBe(validTransaction.wallet_to);
    expect(savedTransaction.type).toBe(validTransaction.type);
    expect(savedTransaction.date).toBeInstanceOf(Date);
    expect(savedTransaction.status).toBe(validTransaction.status);
    expect(savedTransaction.amount).toBe(validTransaction.amount);
    expect(savedTransaction.token).toBe(validTransaction.token);
    expect(savedTransaction.chain_id).toBe(validTransaction.chain_id);
  });

  it('should fail to save a Transaction without required fields', async () => {
    const invalidTransaction: Partial<ITransaction> = {
      wallet_from: '0xFromWallet',
      wallet_to: '0xToWallet',
      type: 'transfer'
      // Missing required fields: trx_hash, date, status, amount, token, chain_id
    };

    const transaction = new Transaction(invalidTransaction);

    await expect(transaction.save()).rejects.toThrow(mongoose.Error.ValidationError);
  });

  it('should fail if trx_hash is not unique', async () => {
    const transactionData: Partial<ITransaction> = {
      trx_hash: '0xUniqueHash',
      wallet_from: '0xFromWallet',
      wallet_to: '0xToWallet',
      type: 'transfer',
      date: new Date(),
      status: 'completed',
      amount: 50.0,
      fee: 0.5,
      token: 'ETH',
      chain_id: 1
    };

    const duplicateTransactionData: Partial<ITransaction> = {
      trx_hash: '0xUniqueHash', // Duplicate trx_hash
      wallet_from: '0xAnotherWallet',
      wallet_to: '0xAnotherWallet',
      type: 'transfer',
      date: new Date(),
      status: 'pending',
      amount: 75.0,
      fee: 0.5,
      token: 'BTC',
      chain_id: 1
    };

    const transaction1 = new Transaction(transactionData);
    await transaction1.save();

    const transaction2 = new Transaction(duplicateTransactionData);

    try {
      await transaction2.save();
    } catch (error: unknown) {
      if (error instanceof mongoose.mongo.MongoServerError) {
        // Assert that the error is due to a duplicate key
        expect(error.code).toBe(11000); // Duplicate key error code
        expect(error.message).toContain('E11000 duplicate key error');
      } else {
        throw error; // Re-throw unexpected errors
      }
    }
  });

  it('should allow a Transaction with a large amount', async () => {
    const validTransaction: Partial<ITransaction> = {
      trx_hash: '0xHashForLargeAmount',
      wallet_from: '0xLargeFromWallet',
      wallet_to: '0xLargeToWallet',
      type: 'transfer',
      date: new Date(),
      status: 'completed',
      amount: 1000000000.0, // Large amount
      fee: 0.5,
      token: 'USDT',
      chain_id: 1
    };

    const transaction = new Transaction(validTransaction);
    const savedTransaction = await transaction.save();

    expect(savedTransaction.amount).toBe(1000000000.0);
  });
});

#!/usr/bin/env bun

/**
 * Migration script to create database indices for Alchemy webhook system
 */

import { connect } from 'mongoose';
import { Logger } from '../src/helpers/loggerHelper';
import { MONGO_URI } from '../src/config/constants';
import { ExternalDepositModel } from '../src/models/externalDepositModel';
import { TokenWhitelistModel } from '../src/models/tokenWhitelistModel';

async function migrateAlchemyIndices(): Promise<void> {
  try {
    Logger.info('migrateAlchemyIndices', 'Starting database migration for Alchemy indices');

    // Connect to MongoDB
    await connect(MONGO_URI);
    Logger.info('migrateAlchemyIndices', 'Connected to MongoDB');

    // Create indices for ExternalDepositModel
    Logger.info('migrateAlchemyIndices', 'Creating indices for external_deposits collection');
    
    try {
      // Unique compound index for idempotency
      await ExternalDepositModel.collection.createIndex(
        { chainId: 1, txHash: 1, logIndex: 1 },
        { unique: true, name: 'uniq_chain_tx_log' }
      );
      Logger.info('migrateAlchemyIndices', 'Created unique index: uniq_chain_tx_log');

      // Query optimization indices
      await ExternalDepositModel.collection.createIndex(
        { to: 1, chainId: 1 },
        { name: 'idx_to_chain' }
      );
      Logger.info('migrateAlchemyIndices', 'Created index: idx_to_chain');

      await ExternalDepositModel.collection.createIndex(
        { observedAt: -1 },
        { name: 'idx_observed_at' }
      );
      Logger.info('migrateAlchemyIndices', 'Created index: idx_observed_at');

      await ExternalDepositModel.collection.createIndex(
        { status: 1 },
        { name: 'idx_status' }
      );
      Logger.info('migrateAlchemyIndices', 'Created index: idx_status');

    } catch (error: any) {
      if (error.code === 11000 || error.message?.includes('already exists')) {
        Logger.info('migrateAlchemyIndices', 'External deposits indices already exist');
      } else {
        throw error;
      }
    }

    // Create indices for TokenWhitelistModel
    Logger.info('migrateAlchemyIndices', 'Creating indices for token_whitelist collection');
    
    try {
      // Unique compound index
      await TokenWhitelistModel.collection.createIndex(
        { chainId: 1, token: 1 },
        { unique: true, name: 'uniq_chain_token' }
      );
      Logger.info('migrateAlchemyIndices', 'Created unique index: uniq_chain_token');

      // Query optimization indices
      await TokenWhitelistModel.collection.createIndex(
        { active: 1 },
        { name: 'idx_active' }
      );
      Logger.info('migrateAlchemyIndices', 'Created index: idx_active');

      await TokenWhitelistModel.collection.createIndex(
        { chainId: 1, active: 1 },
        { name: 'idx_chain_active' }
      );
      Logger.info('migrateAlchemyIndices', 'Created index: idx_chain_active');

    } catch (error: any) {
      if (error.code === 11000 || error.message?.includes('already exists')) {
        Logger.info('migrateAlchemyIndices', 'Token whitelist indices already exist');
      } else {
        throw error;
      }
    }

    // List all indices to verify
    Logger.info('migrateAlchemyIndices', 'Listing created indices:');
    
    const depositIndices = await ExternalDepositModel.collection.listIndexes().toArray();
    Logger.info('migrateAlchemyIndices', 'External deposits indices:', 
      depositIndices.map(idx => idx.name)
    );

    const whitelistIndices = await TokenWhitelistModel.collection.listIndexes().toArray();
    Logger.info('migrateAlchemyIndices', 'Token whitelist indices:', 
      whitelistIndices.map(idx => idx.name)
    );

    Logger.info('migrateAlchemyIndices', 'Database migration completed successfully');

  } catch (error) {
    Logger.error('migrateAlchemyIndices', 'Migration failed', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

// Run the migration if this script is executed directly
if (import.meta.main) {
  migrateAlchemyIndices();
}

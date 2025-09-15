#!/usr/bin/env bun

/**
 * Script to backfill existing wallets to Alchemy webhook variables
 * This should be run once after implementing the Alchemy webhook system
 */

import { connect } from 'mongoose';
import { Logger } from '../src/helpers/loggerHelper';
import { MONGO_URI, DEFAULT_CHAIN_ID } from '../src/config/constants';
import { UserModel } from '../src/models/userModel';
import { walletProvisioningHook } from '../src/services/alchemy/walletProvisioningHook';

async function backfillAlchemyWallets(): Promise<void> {
  try {
    Logger.info('backfillAlchemyWallets', 'Starting wallet backfill to Alchemy');

    // Connect to MongoDB
    await connect(MONGO_URI);
    Logger.info('backfillAlchemyWallets', 'Connected to MongoDB');

    // Get all users with active wallets
    const users = await UserModel.find({
      'wallets.status': 'active'
    }).select('wallets');

    Logger.info('backfillAlchemyWallets', `Found ${users.length} users with active wallets`);

    // Extract all wallet addresses by chain
    const walletsByChain: Record<number, string[]> = {};
    let totalWallets = 0;

    for (const user of users) {
      for (const wallet of user.wallets) {
        if (wallet.status === 'active' && wallet.wallet_proxy) {
          const chainId = wallet.chain_id || DEFAULT_CHAIN_ID;
          
          if (!walletsByChain[chainId]) {
            walletsByChain[chainId] = [];
          }
          
          walletsByChain[chainId].push(wallet.wallet_proxy);
          totalWallets++;
        }
      }
    }

    Logger.info('backfillAlchemyWallets', `Extracted ${totalWallets} active wallets across ${Object.keys(walletsByChain).length} chains`);

    // Backfill wallets for each chain
    for (const [chainIdStr, wallets] of Object.entries(walletsByChain)) {
      const chainId = parseInt(chainIdStr, 10);
      
      Logger.info('backfillAlchemyWallets', `Backfilling ${wallets.length} wallets for chain ${chainId}`);
      
      try {
        await walletProvisioningHook.backfillWallets(wallets);
        Logger.info('backfillAlchemyWallets', `Successfully backfilled chain ${chainId}`);
      } catch (error) {
        Logger.error('backfillAlchemyWallets', `Failed to backfill chain ${chainId}`, error);
      }
    }

    Logger.info('backfillAlchemyWallets', 'Wallet backfill completed successfully');

  } catch (error) {
    Logger.error('backfillAlchemyWallets', 'Backfill failed', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

// Run the backfill if this script is executed directly
if (import.meta.main) {
  backfillAlchemyWallets();
}

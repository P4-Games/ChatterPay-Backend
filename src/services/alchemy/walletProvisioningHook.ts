import { Logger } from '../../helpers/loggerHelper';
import { alchemyAdminService } from './alchemyAdminService';
import { DEPOSITS_PROVIDER } from '../../config/constants';

/**
 * Service for integrating wallet provisioning with Alchemy webhook variables
 */
export class WalletProvisioningHook {
  /**
   * Called after a new wallet is created to register it with Alchemy
   * @param walletAddress - The newly created wallet address
   * @param chainId - The chain ID where the wallet was created
   */
  public async onWalletCreated(walletAddress: string, chainId: number): Promise<void> {
    // Only process if Alchemy is the active deposits provider
    if (DEPOSITS_PROVIDER !== 'alchemy') {
      Logger.debug('WalletProvisioningHook', `Skipping Alchemy registration - provider is ${DEPOSITS_PROVIDER}`);
      return;
    }

    try {
      Logger.info('WalletProvisioningHook', `Registering new wallet with Alchemy`, {
        wallet: walletAddress,
        chainId
      });

      // Add wallet to both Alchemy variables (addresses and topics)
      await alchemyAdminService.addWallet(walletAddress);

      Logger.info('WalletProvisioningHook', `Successfully registered wallet with Alchemy`, {
        wallet: walletAddress,
        chainId
      });
    } catch (error) {
      // Don't throw - wallet creation should succeed even if Alchemy registration fails
      Logger.error('WalletProvisioningHook', `Failed to register wallet with Alchemy`, {
        wallet: walletAddress,
        chainId,
        error
      });
    }
  }

  /**
   * Called when a wallet is deactivated to remove it from Alchemy
   * @param walletAddress - The wallet address to deactivate
   * @param chainId - The chain ID
   */
  public async onWalletDeactivated(walletAddress: string, chainId: number): Promise<void> {
    if (DEPOSITS_PROVIDER !== 'alchemy') {
      Logger.debug('WalletProvisioningHook', `Skipping Alchemy deregistration - provider is ${DEPOSITS_PROVIDER}`);
      return;
    }

    try {
      Logger.info('WalletProvisioningHook', `Deregistering wallet from Alchemy`, {
        wallet: walletAddress,
        chainId
      });

      await alchemyAdminService.removeWallet(walletAddress);

      Logger.info('WalletProvisioningHook', `Successfully deregistered wallet from Alchemy`, {
        wallet: walletAddress,
        chainId
      });
    } catch (error) {
      Logger.error('WalletProvisioningHook', `Failed to deregister wallet from Alchemy`, {
        wallet: walletAddress,
        chainId,
        error
      });
    }
  }

  /**
   * Batch backfill existing wallets to Alchemy variables
   * @param wallets - Array of wallet addresses to register
   */
  public async backfillWallets(wallets: string[]): Promise<void> {
    if (DEPOSITS_PROVIDER !== 'alchemy') {
      Logger.debug('WalletProvisioningHook', `Skipping Alchemy backfill - provider is ${DEPOSITS_PROVIDER}`);
      return;
    }

    if (wallets.length === 0) {
      Logger.info('WalletProvisioningHook', `No wallets to backfill`);
      return;
    }

    try {
      Logger.info('WalletProvisioningHook', `Starting wallet backfill to Alchemy`, {
        count: wallets.length
      });

      // Batch register all wallets
      await Promise.all([
        alchemyAdminService.appendWallets(wallets),
        alchemyAdminService.appendWalletTopics(wallets)
      ]);

      Logger.info('WalletProvisioningHook', `Successfully backfilled ${wallets.length} wallets to Alchemy`);
    } catch (error) {
      Logger.error('WalletProvisioningHook', `Failed to backfill wallets to Alchemy`, {
        count: wallets.length,
        error
      });
      throw error;
    }
  }

  /**
   * Health check for Alchemy integration
   * @returns True if Alchemy is healthy, false otherwise
   */
  public async healthCheck(): Promise<boolean> {
    if (DEPOSITS_PROVIDER !== 'alchemy') {
      return true; // Not using Alchemy, so it's "healthy"
    }

    try {
      return await alchemyAdminService.healthCheck();
    } catch (error) {
      Logger.error('WalletProvisioningHook', `Alchemy health check failed`, error);
      return false;
    }
  }
}

// Export singleton instance
export const walletProvisioningHook = new WalletProvisioningHook();

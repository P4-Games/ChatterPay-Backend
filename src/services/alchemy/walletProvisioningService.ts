import {
  EXTERNAL_DEPOSITS_PROVIDER,
  EXTERNAL_DEPOSITS_PROVIDER_IS_ALCHEMY
} from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import { alchemyAdminService } from './alchemyAdminService';

type WalletAction = 'register' | 'deregister' | 'backfill';

/**
 * Internal helper to handle common Alchemy-related wallet actions.
 * Returns true if the operation succeeded, false otherwise.
 */
async function handleAlchemyAction<T>(
  action: WalletAction,
  task: () => Promise<T>,
  context: Record<string, unknown>
): Promise<boolean> {
  if (!EXTERNAL_DEPOSITS_PROVIDER_IS_ALCHEMY) {
    Logger.info(
      'walletProvisioningService',
      `Skipping Alchemy ${action} — provider is ${EXTERNAL_DEPOSITS_PROVIDER}`
    );
    return false;
  }

  try {
    Logger.info('walletProvisioningService', `Starting Alchemy ${action}`, context);
    await task();
    Logger.info('walletProvisioningService', `Successfully completed Alchemy ${action}`, context);
    return true;
  } catch (error) {
    Logger.error('walletProvisioningService', `Failed to ${action} wallet(s) with Alchemy`, {
      ...context,
      error
    });

    // Only rethrow errors for batch operations (backfill)
    if (action === 'backfill') throw error;

    return false;
  }
}

/**
 * Service responsible for wallet registration, deactivation, and backfill in Alchemy.
 */
export const walletProvisioningService = {
  /**
   * Registers a newly created wallet in Alchemy.
   * Returns true if successful, false otherwise.
   */
  async onWalletCreated(walletAddress: string, chainId: number): Promise<boolean> {
    return handleAlchemyAction('register', () => alchemyAdminService.addWallet(walletAddress), {
      walletAddress,
      chainId
    });
  },

  /**
   * Deregisters a wallet from Alchemy.
   * Returns true if successful, false otherwise.
   */
  async onWalletDeactivated(walletAddress: string, chainId: number): Promise<boolean> {
    return handleAlchemyAction(
      'deregister',
      () => alchemyAdminService.removeWallet(walletAddress),
      { walletAddress, chainId }
    );
  },

  /**
   * Performs a batch re-registration of wallets in Alchemy.
   * Used for resync or recovery operations.
   */
  async backfillWallets(wallets: string[]): Promise<void> {
    if (wallets.length === 0) {
      Logger.info('walletProvisioningService', 'No wallets to backfill');
      return;
    }

    await handleAlchemyAction(
      'backfill',
      async () => {
        await Promise.allSettled([
          alchemyAdminService.appendWallets(wallets),
          alchemyAdminService.appendWalletTopics(wallets)
        ]);
      },
      { count: wallets.length }
    );
  },

  /**
   * Verifies connectivity and permissions to Alchemy Admin API.
   */
  async healthCheck(): Promise<boolean> {
    if (!EXTERNAL_DEPOSITS_PROVIDER_IS_ALCHEMY) return true;
    try {
      return await alchemyAdminService.healthCheck();
    } catch (error) {
      Logger.error('walletProvisioningService', 'Alchemy health check failed', error);
      return false;
    }
  }
};

import { ethers } from 'ethers';
import { DEFAULT_CHAIN_ID } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import type {
  AlchemyAddressActivity,
  AlchemyLog,
  AlchemyWebhookPayload
} from '../../types/alchemyTypes';
import { mongoTokenWhitelistService } from '../mongo/mongoTokenWhitelistService';
import { alchemyAdminService } from './alchemyAdminService';

// Factory event signatures
const TOKEN_WHITELISTED_SIGNATURE = '0x'; // no emitted by chatterpay contract.
const FACTORY_DEFAULT_TOKENS_UPDATED_SIGNATURE = `0x${ethers.utils.id('DefaultTokensUpdated(address[],address[])')}`;

/**
 * Functional service for syncing token whitelist from factory contract events
 */
export const tokenWhitelistSyncService = {
  chainId: DEFAULT_CHAIN_ID,

  /**
   * Processes factory webhook payload and syncs whitelist changes
   */
  async processFactoryWebhook(payload: AlchemyWebhookPayload): Promise<number> {
    try {
      Logger.info('WhitelistSyncService', `Processing factory webhook payload ${payload.id}`, {
        type: payload.type,
        webhookId: payload.webhookId
      });

      const logs: AlchemyLog[] = [];

      // Case 1: legacy format
      const { data } = payload.event;
      if (data?.logs?.length) {
        logs.push(...data.logs);
      }

      // Case 2: ADDRESS_ACTIVITY format (some activity entries may contain logs)
      const { activity } = payload.event;
      if (Array.isArray(activity)) {
        activity.forEach((act: AlchemyAddressActivity) => {
          if (act.log) logs.push(act.log);
        });
      }

      if (logs.length === 0) {
        Logger.debug('WhitelistSyncService', 'No factory logs found in payload');
        return 0;
      }

      const results = await Promise.all(
        logs.map((log) => tokenWhitelistSyncService.processFactoryLog(log))
      );

      const processedEvents = results.filter(Boolean).length;

      Logger.info(
        'WhitelistSyncService',
        `Processed ${processedEvents} factory events from payload ${payload.id}`
      );
      return processedEvents;
    } catch (error) {
      Logger.error(
        'WhitelistSyncService',
        `Failed to process factory webhook payload ${payload.id}`,
        error
      );
      throw error;
    }
  },
  /**
   * Processes a single factory contract log
   */
  async processFactoryLog(log: AlchemyLog): Promise<boolean> {
    try {
      const eventSignature = log.topics[0];

      switch (eventSignature) {
        case TOKEN_WHITELISTED_SIGNATURE:
          await tokenWhitelistSyncService.processTokenWhitelistedEvent(log);
          return true;

        case FACTORY_DEFAULT_TOKENS_UPDATED_SIGNATURE:
          await tokenWhitelistSyncService.processDefaultTokensUpdatedEvent(log);
          return true;

        default:
          Logger.debug(
            'WhitelistSyncService',
            `Unknown factory event signature: ${eventSignature}`
          );
          return false;
      }
    } catch (error) {
      Logger.error('WhitelistSyncService', 'Failed to process factory log', { log, error });
      return false;
    }
  },

  /**
   * Processes TokenWhitelisted event
   */
  async processTokenWhitelistedEvent(log: AlchemyLog): Promise<void> {
    try {
      const tokenAddress = ethers.utils.defaultAbiCoder
        .decode(['address'], log.topics[1])[0]
        .toLowerCase();
      const [status] = ethers.utils.defaultAbiCoder.decode(['bool'], log.data);

      Logger.info('WhitelistSyncService', 'Processing TokenWhitelisted event', {
        token: tokenAddress,
        status,
        txHash: log.transactionHash
      });

      await tokenWhitelistSyncService.updateTokenWhitelistStatus(tokenAddress, status);

      if (status) {
        await alchemyAdminService.appendTokensWhitelist([tokenAddress]);
      } else {
        await alchemyAdminService.removeTokensWhitelist([tokenAddress]);
      }

      Logger.info('WhitelistSyncService', 'Successfully processed TokenWhitelisted event', {
        token: tokenAddress,
        status
      });
    } catch (error) {
      Logger.error('WhitelistSyncService', 'Failed to process TokenWhitelisted event', {
        log,
        error
      });
      throw error;
    }
  },

  /**
   * Processes DefaultTokensUpdated event
   */
  async processDefaultTokensUpdatedEvent(log: AlchemyLog): Promise<void> {
    try {
      const [tokens, priceFeeds] = ethers.utils.defaultAbiCoder.decode(
        ['address[]', 'address[]'],
        log.data
      );

      const normalizedTokens = tokens.map((token: string) => token.toLowerCase());
      const normalizedFeeds = priceFeeds.map((feed: string) => feed.toLowerCase());

      Logger.info('WhitelistSyncService', 'Processing DefaultTokensUpdated event', {
        tokensCount: normalizedTokens.length,
        feedsCount: normalizedFeeds.length,
        txHash: log.transactionHash
      });

      await tokenWhitelistSyncService.updateDefaultTokens(normalizedTokens, normalizedFeeds);
      await tokenWhitelistSyncService.resyncAlchemyWhitelist();

      Logger.info('WhitelistSyncService', 'Successfully processed DefaultTokensUpdated event', {
        tokensCount: normalizedTokens.length
      });
    } catch (error) {
      Logger.error('WhitelistSyncService', 'Failed to process DefaultTokensUpdated event', {
        log,
        error
      });
      throw error;
    }
  },

  /**
   * Updates token whitelist status in database
   */
  async updateTokenWhitelistStatus(tokenAddress: string, active: boolean): Promise<void> {
    try {
      await mongoTokenWhitelistService.updateTokenWhitelistStatus(
        tokenWhitelistSyncService.chainId,
        tokenAddress,
        active
      );

      Logger.debug('WhitelistSyncService', 'Updated token whitelist status', {
        token: tokenAddress,
        active,
        chainId: tokenWhitelistSyncService.chainId
      });
    } catch (error) {
      Logger.error('WhitelistSyncService', 'Failed to update token whitelist status', {
        token: tokenAddress,
        active,
        error
      });
      throw error;
    }
  },

  /**
   * Updates default tokens and their price feeds
   */
  async updateDefaultTokens(tokens: string[], priceFeeds: string[]): Promise<void> {
    try {
      await mongoTokenWhitelistService.updateDefaultTokens(
        tokenWhitelistSyncService.chainId,
        tokens,
        priceFeeds
      );

      Logger.debug('WhitelistSyncService', `Updated ${tokens.length} default tokens`);
    } catch (error) {
      Logger.error('WhitelistSyncService', 'Failed to update default tokens', { tokens, error });
      throw error;
    }
  },

  /**
   * Resyncs all active tokens with Alchemy whitelist variable
   */
  async resyncAlchemyWhitelist(): Promise<void> {
    try {
      Logger.info(
        'WhitelistSyncService',
        `Resyncing Alchemy whitelist for chain ${tokenWhitelistSyncService.chainId}`
      );

      const tokenAddresses = await mongoTokenWhitelistService.getActiveTokens(
        tokenWhitelistSyncService.chainId
      );

      await alchemyAdminService.setTokensWhitelist(tokenAddresses);

      Logger.info(
        'WhitelistSyncService',
        `Successfully resynced ${tokenAddresses.length} tokens with Alchemy`
      );
    } catch (error) {
      Logger.error('WhitelistSyncService', 'Failed to resync Alchemy whitelist', error);
      throw error;
    }
  },

  /**
   * Manual admin method to resync variables from DB to Alchemy
   */
  async manualResyncFromDatabase(): Promise<void> {
    try {
      Logger.info(
        'WhitelistSyncService',
        `Starting manual resync from database for chain ${tokenWhitelistSyncService.chainId}`
      );

      await tokenWhitelistSyncService.resyncAlchemyWhitelist();

      Logger.info('WhitelistSyncService', 'Manual resync completed successfully');
    } catch (error) {
      Logger.error('WhitelistSyncService', 'Manual resync failed', error);
      throw error;
    }
  },

  /**
   * Gets current whitelist status for debugging
   */
  async getWhitelistStatus(): Promise<{
    activeTokens: string[];
    inactiveTokens: string[];
    totalCount: number;
  }> {
    try {
      return await mongoTokenWhitelistService.getWhitelistStatus(tokenWhitelistSyncService.chainId);
    } catch (error) {
      Logger.error('WhitelistSyncService', 'Failed to get whitelist status', error);
      throw error;
    }
  }
};

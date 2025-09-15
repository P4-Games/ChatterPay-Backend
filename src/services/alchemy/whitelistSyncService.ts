import { ethers } from 'ethers';
import { Logger } from '../../helpers/loggerHelper';
import { TokenWhitelistModel, ITokenWhitelist } from '../../models/tokenWhitelistModel';
import { AlchemyLog, AlchemyWebhookPayload } from './depositIngestor';
import { alchemyAdminService } from './alchemyAdminService';
import { DEFAULT_CHAIN_ID } from '../../config/constants';

// Factory event signatures
export const TOKEN_WHITELISTED_SIG = '0x...'; // TODO: Add actual signature
export const DEFAULT_TOKENS_UPDATED_SIG = '0x...'; // TODO: Add actual signature

export interface TokenWhitelistedEvent {
  token: string;
  status: boolean;
  chainId: number;
  blockNumber: number;
  txHash: string;
  logIndex: number;
}

export interface DefaultTokensUpdatedEvent {
  tokens: string[];
  priceFeeds: string[];
  chainId: number;
  blockNumber: number;
  txHash: string;
  logIndex: number;
}

/**
 * Service for syncing token whitelist from factory contract events
 */
export class WhitelistSyncService {
  private readonly chainId: number;

  constructor(chainId?: number) {
    this.chainId = chainId || DEFAULT_CHAIN_ID;
  }

  /**
   * Processes factory webhook payload and syncs whitelist changes
   * @param payload - The webhook payload from Alchemy
   * @returns Number of processed events
   */
  public async processFactoryWebhook(payload: AlchemyWebhookPayload): Promise<number> {
    try {
      Logger.info('WhitelistSyncService', `Processing factory webhook payload ${payload.id}`, {
        type: payload.type,
        webhookId: payload.webhookId
      });

      let processedEvents = 0;
      const { data } = payload.event;

      if (data.logs) {
        for (const log of data.logs) {
          const processed = await this.processFactoryLog(log);
          if (processed) {
            processedEvents++;
          }
        }
      }

      Logger.info('WhitelistSyncService', `Processed ${processedEvents} factory events from payload ${payload.id}`);
      return processedEvents;
    } catch (error) {
      Logger.error('WhitelistSyncService', `Failed to process factory webhook payload ${payload.id}`, error);
      throw error;
    }
  }

  /**
   * Processes a single factory contract log
   * @param log - The log entry from Alchemy
   * @returns True if event was processed, false otherwise
   */
  private async processFactoryLog(log: AlchemyLog): Promise<boolean> {
    try {
      const eventSignature = log.topics[0];

      switch (eventSignature) {
        case TOKEN_WHITELISTED_SIG:
          await this.processTokenWhitelistedEvent(log);
          return true;
        
        case DEFAULT_TOKENS_UPDATED_SIG:
          await this.processDefaultTokensUpdatedEvent(log);
          return true;
        
        default:
          Logger.debug('WhitelistSyncService', `Unknown factory event signature: ${eventSignature}`);
          return false;
      }
    } catch (error) {
      Logger.error('WhitelistSyncService', `Failed to process factory log`, { log, error });
      return false;
    }
  }

  /**
   * Processes TokenWhitelisted event
   * @param log - The log entry
   */
  private async processTokenWhitelistedEvent(log: AlchemyLog): Promise<void> {
    try {
      // Decode the event data
      // topics[1] = token address, data contains status (bool)
      const tokenAddress = ethers.utils.defaultAbiCoder.decode(['address'], log.topics[1])[0].toLowerCase();
      const [status] = ethers.utils.defaultAbiCoder.decode(['bool'], log.data);

      Logger.info('WhitelistSyncService', `Processing TokenWhitelisted event`, {
        token: tokenAddress,
        status,
        txHash: log.transactionHash
      });

      // Update database
      await this.updateTokenWhitelistStatus(tokenAddress, status);

      // Sync with Alchemy variables
      if (status) {
        await alchemyAdminService.appendTokensWhitelist([tokenAddress]);
      } else {
        await alchemyAdminService.removeTokensWhitelist([tokenAddress]);
      }

      Logger.info('WhitelistSyncService', `Successfully processed TokenWhitelisted event`, {
        token: tokenAddress,
        status
      });
    } catch (error) {
      Logger.error('WhitelistSyncService', `Failed to process TokenWhitelisted event`, { log, error });
      throw error;
    }
  }

  /**
   * Processes DefaultTokensUpdated event
   * @param log - The log entry
   */
  private async processDefaultTokensUpdatedEvent(log: AlchemyLog): Promise<void> {
    try {
      // Decode the event data
      // data contains tokens[] and priceFeeds[]
      const [tokens, priceFeeds] = ethers.utils.defaultAbiCoder.decode(
        ['address[]', 'address[]'], 
        log.data
      );

      const normalizedTokens = tokens.map((token: string) => token.toLowerCase());
      const normalizedFeeds = priceFeeds.map((feed: string) => feed.toLowerCase());

      Logger.info('WhitelistSyncService', `Processing DefaultTokensUpdated event`, {
        tokensCount: normalizedTokens.length,
        feedsCount: normalizedFeeds.length,
        txHash: log.transactionHash
      });

      // Update database with new default tokens
      await this.updateDefaultTokens(normalizedTokens, normalizedFeeds);

      // Resync all active tokens with Alchemy
      await this.resyncAlchemyWhitelist();

      Logger.info('WhitelistSyncService', `Successfully processed DefaultTokensUpdated event`, {
        tokensCount: normalizedTokens.length
      });
    } catch (error) {
      Logger.error('WhitelistSyncService', `Failed to process DefaultTokensUpdated event`, { log, error });
      throw error;
    }
  }

  /**
   * Updates token whitelist status in database
   * @param tokenAddress - The token address
   * @param active - Whether the token is active
   */
  private async updateTokenWhitelistStatus(tokenAddress: string, active: boolean): Promise<void> {
    try {
      await TokenWhitelistModel.findOneAndUpdate(
        { 
          chainId: this.chainId, 
          token: tokenAddress 
        },
        {
          token: tokenAddress,
          chainId: this.chainId,
          active,
          updatedAt: new Date()
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true
        }
      );

      Logger.debug('WhitelistSyncService', `Updated token whitelist status`, {
        token: tokenAddress,
        active,
        chainId: this.chainId
      });
    } catch (error) {
      Logger.error('WhitelistSyncService', `Failed to update token whitelist status`, {
        token: tokenAddress,
        active,
        error
      });
      throw error;
    }
  }

  /**
   * Updates default tokens and their price feeds
   * @param tokens - Array of token addresses
   * @param priceFeeds - Array of price feed addresses
   */
  private async updateDefaultTokens(tokens: string[], priceFeeds: string[]): Promise<void> {
    try {
      // Create bulk operations
      const bulkOps = tokens.map((token, index) => ({
        updateOne: {
          filter: { chainId: this.chainId, token },
          update: {
            token,
            chainId: this.chainId,
            active: true,
            priceFeed: priceFeeds[index] || null,
            updatedAt: new Date()
          },
          upsert: true
        }
      }));

      if (bulkOps.length > 0) {
        await TokenWhitelistModel.bulkWrite(bulkOps);
      }

      Logger.debug('WhitelistSyncService', `Updated ${tokens.length} default tokens`);
    } catch (error) {
      Logger.error('WhitelistSyncService', `Failed to update default tokens`, { tokens, error });
      throw error;
    }
  }

  /**
   * Resyncs all active tokens with Alchemy whitelist variable
   */
  public async resyncAlchemyWhitelist(): Promise<void> {
    try {
      Logger.info('WhitelistSyncService', `Resyncing Alchemy whitelist for chain ${this.chainId}`);

      // Get all active tokens from database
      const activeTokens = await TokenWhitelistModel.find({
        chainId: this.chainId,
        active: true
      }).select('token');

      const tokenAddresses = activeTokens.map(t => t.token);

      // Update Alchemy variable with complete list
      await alchemyAdminService.setTokensWhitelist(tokenAddresses);

      Logger.info('WhitelistSyncService', `Successfully resynced ${tokenAddresses.length} tokens with Alchemy`);
    } catch (error) {
      Logger.error('WhitelistSyncService', `Failed to resync Alchemy whitelist`, error);
      throw error;
    }
  }

  /**
   * Manual admin method to resync variables from DB to Alchemy
   * Useful for recovering from sync issues
   */
  public async manualResyncFromDatabase(): Promise<void> {
    try {
      Logger.info('WhitelistSyncService', `Starting manual resync from database for chain ${this.chainId}`);

      await this.resyncAlchemyWhitelist();

      Logger.info('WhitelistSyncService', `Manual resync completed successfully`);
    } catch (error) {
      Logger.error('WhitelistSyncService', `Manual resync failed`, error);
      throw error;
    }
  }

  /**
   * Gets current whitelist status for debugging
   */
  public async getWhitelistStatus(): Promise<{
    activeTokens: string[];
    inactiveTokens: string[];
    totalCount: number;
  }> {
    try {
      const [activeTokens, inactiveTokens] = await Promise.all([
        TokenWhitelistModel.find({ chainId: this.chainId, active: true }).select('token'),
        TokenWhitelistModel.find({ chainId: this.chainId, active: false }).select('token')
      ]);

      return {
        activeTokens: activeTokens.map(t => t.token),
        inactiveTokens: inactiveTokens.map(t => t.token),
        totalCount: activeTokens.length + inactiveTokens.length
      };
    } catch (error) {
      Logger.error('WhitelistSyncService', `Failed to get whitelist status`, error);
      throw error;
    }
  }
}

// Export singleton instance
export const whitelistSyncService = new WhitelistSyncService();

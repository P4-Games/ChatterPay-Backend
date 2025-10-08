import { Logger } from '../../helpers/loggerHelper';
import { TokenWhitelistModel } from '../../models/tokenWhitelistModel';

/**
 * MongoDB service for managing the token whitelist collection.
 *
 * Handles all persistence operations related to token whitelist synchronization,
 * separated from business logic (Alchemy webhook, factory events, etc.).
 */
export const mongoTokenWhitelistService = {
  /**
   * Updates or inserts a single token whitelist status.
   *
   * @param chainId - The blockchain ID (e.g., 534352 for Scroll)
   * @param token - The token address (lowercased)
   * @param active - Whether the token is active or not
   */
  updateTokenWhitelistStatus: async (
    chainId: number,
    token: string,
    active: boolean
  ): Promise<void> => {
    try {
      await TokenWhitelistModel.findOneAndUpdate(
        { chainId, token },
        { token, chainId, active, updatedAt: new Date() },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      Logger.debug('mongoTokenWhitelistService', 'Updated token whitelist status', {
        chainId,
        token,
        active
      });
    } catch (err) {
      Logger.error('mongoTokenWhitelistService', 'updateTokenWhitelistStatus DB error:', {
        token,
        err
      });
      throw err;
    }
  },

  /**
   * Bulk updates or inserts default tokens with their price feeds.
   *
   * @param chainId - The blockchain ID
   * @param tokens - List of token addresses
   * @param priceFeeds - List of price feed addresses corresponding to tokens
   */
  updateDefaultTokens: async (
    chainId: number,
    tokens: string[],
    priceFeeds: string[]
  ): Promise<void> => {
    try {
      const bulkOps = tokens.map((token, index) => ({
        updateOne: {
          filter: { chainId, token },
          update: {
            token,
            chainId,
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

      Logger.debug(
        'mongoTokenWhitelistService',
        `Updated ${tokens.length} default tokens for chain ${chainId}`
      );
    } catch (err) {
      Logger.error('mongoTokenWhitelistService', 'updateDefaultTokens DB error:', {
        tokens,
        err
      });
      throw err;
    }
  },

  /**
   * Fetches all active tokens for a given chain.
   *
   * @param chainId - The blockchain ID
   * @returns List of token addresses that are active
   */
  getActiveTokens: async (chainId: number): Promise<string[]> => {
    try {
      const tokens = await TokenWhitelistModel.find({ chainId, active: true })
        .select('token')
        .lean();
      return tokens.map((t) => t.token);
    } catch (err) {
      Logger.error('mongoTokenWhitelistService', 'getActiveTokens DB error:', err);
      return [];
    }
  },

  /**
   * Fetches the current whitelist status (active/inactive tokens).
   *
   * @param chainId - The blockchain ID
   * @returns An object with active, inactive tokens and total count
   */
  getWhitelistStatus: async (
    chainId: number
  ): Promise<{
    activeTokens: string[];
    inactiveTokens: string[];
    totalCount: number;
  }> => {
    try {
      const [activeTokens, inactiveTokens] = await Promise.all([
        TokenWhitelistModel.find({ chainId, active: true }).select('token').lean(),
        TokenWhitelistModel.find({ chainId, active: false }).select('token').lean()
      ]);

      return {
        activeTokens: activeTokens.map((t) => t.token),
        inactiveTokens: inactiveTokens.map((t) => t.token),
        totalCount: activeTokens.length + inactiveTokens.length
      };
    } catch (err) {
      Logger.error('mongoTokenWhitelistService', 'getWhitelistStatus DB error:', err);
      return { activeTokens: [], inactiveTokens: [], totalCount: 0 };
    }
  }
};

import axios from 'axios';

import { Logger } from '../../helpers/loggerHelper';
import { cacheService } from '../cache/cacheService';
import { CacheNames, ConversionRates } from '../../types/commonType';
import { TOKEN_IDS, RESULT_CURRENCIES, COINGECKO_API_BASE_URL } from '../../config/constants';

/**
 * Generates a fallback response with zero values for all tokens and currencies.
 * @returns {object} A default response object with zero values.
 */
const getFallbackRates = (): Record<string, Record<string, number>> =>
  TOKEN_IDS.reduce<Record<string, Record<string, number>>>((acc, token) => {
    acc[token] = Object.fromEntries(RESULT_CURRENCIES.map((currency) => [currency, 0]));
    return acc;
  }, {});

/**
 * Fetches the latest conversion rates from the CoinGecko API.
 * @returns {Promise<object>} The conversion rates or fallback values in case of failure.
 */
export async function getCoingeckoConversionRates() {
  try {
    const url = `${COINGECKO_API_BASE_URL}?ids=${TOKEN_IDS.join(',')}&vs_currencies=${RESULT_CURRENCIES.join(',')}`;
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    Logger.warn('getCoingeckoConversionRates', 'Error fetching conversion rates:', error);
    return getFallbackRates();
  }
}

/**
 * Fetches data for a single token from the CoinGecko API.
 * @param tokenId The CoinGecko ID of the token
 * @returns {Promise<object>} The token data or null in case of failure
 */
export async function getCoingeckoTokenData(tokenId: string) {
  try {
    const url = `${COINGECKO_API_BASE_URL}?ids=${tokenId}&vs_currencies=${RESULT_CURRENCIES.join(',')}`;
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    Logger.warn('getCoingeckoTokenData', `Error fetching data for token ${tokenId}:`, error);
    return null;
  }
}

export const coingeckoService = {
  /**
   * Retrieves conversion rates from cache or fetches from CoinGecko if not cached.
   * @returns {Promise<object>} The conversion rates from cache or API.
   */
  getConversationRates: async (): Promise<ConversionRates> => {
    const cacheKey = `getConversationRates`;
    const fromCache = cacheService.get(CacheNames.COINGECKO, cacheKey);

    if (fromCache) {
      return fromCache as ConversionRates;
    }

    const result = await getCoingeckoConversionRates();
    cacheService.set(CacheNames.COINGECKO, cacheKey, result);
    return result;
  },

  /**
   * Retrieves data for a single token, using cache if available
   * @param tokenId The CoinGecko ID of the token
   * @returns {Promise<number>} The token price in USD or 0 if not found
   */
  getTokenPrice: async (tokenId: string): Promise<number> => {
    const cacheKey = `token_${tokenId}`;
    const fromCache = cacheService.get(CacheNames.COINGECKO, cacheKey);

    if (fromCache) {
      return fromCache as number;
    }

    const result = await getCoingeckoTokenData(tokenId);
    if (result?.[tokenId]?.usd) {
      const price = result[tokenId].usd;
      cacheService.set(CacheNames.COINGECKO, cacheKey, price);
      return price;
    }
    return 0;
  }
};

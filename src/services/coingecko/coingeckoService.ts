import axios from 'axios';
import NodeCache from 'node-cache';

import { Logger } from '../../helpers/loggerHelper';
import { ConversionRates } from '../../types/commonType';
import { TOKEN_IDS, RESULT_CURRENCIES, COINGECKO_API_BASE_URL } from '../../config/constants';

// Initialize the cache
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

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

export const coingeckoService = {
  /**
   * Retrieves conversion rates from cache or fetches from CoinGecko if not cached.
   * @returns {Promise<object>} The conversion rates from cache or API.
   */
  getConversationRates: async (): Promise<ConversionRates> => {
    const cacheKey = `getConversationRates`;
    const fromCache = cache.get(cacheKey);

    if (fromCache) {
      return fromCache as ConversionRates;
    }

    const result = await getCoingeckoConversionRates();
    cache.set(cacheKey, result);
    return result;
  }
};

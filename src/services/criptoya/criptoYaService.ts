import { FiatQuote } from '../../types/commonType';
import { Logger } from '../../helpers/loggerHelper';
import { CRIPTO_YA_URLS } from '../../config/constants';

/**
 * Fetches fiat quotes from external APIs
 * @returns {Promise<FiatQuote[]>} Array of fiat currency quotes
 */
export async function getFiatQuotes(): Promise<FiatQuote[]> {
  return Promise.all(
    CRIPTO_YA_URLS.map(async ([currency, url]) => {
      try {
        const response = await fetch(url);
        const data = await response.json();
        return { currency, rate: data.bid };
      } catch (error) {
        Logger.error('getFiatQuotes', `Error fetching ${currency} quote:`, error);
        return { currency, rate: 1 }; // Fallback to 1:1 rate
      }
    })
  );
}

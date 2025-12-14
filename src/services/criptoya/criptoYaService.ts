import { CRIPTO_YA_URL, FIAT_CURRENCIES } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import type { Currency, FiatQuote } from '../../types/commonType';

/**
 * Fetches fiat quotes from external APIs
 * @returns {Promise<FiatQuote[]>} Array of fiat currency quotes
 */
export async function getFiatQuotes(): Promise<FiatQuote[]> {
  return Promise.all(
    (FIAT_CURRENCIES as Currency[]).map(async (currency) => {
      const url = `${CRIPTO_YA_URL}/${currency}`;
      try {
        const response = await fetch(url);
        const data = await response.json();
        return { currency, rate: Number(data.bid) } as FiatQuote;
      } catch (error) {
        Logger.error('getFiatQuotes', `Error fetching ${currency} quote:`, error);
        return { currency, rate: 1 }; // Fallback to 1:1 rate
      }
    })
  );
}

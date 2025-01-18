import { Logger } from '../../helpers/loggerHelper';
import { CurrencyType, FiatQuoteType } from '../../types/commonType';

/**
 * API endpoints for fiat currency conversion rates
 */
const CRIPTO_YA_URLS: [CurrencyType, string][] = [
  ['UYU', 'https://criptoya.com/api/ripio/USDT/UYU'],
  ['ARS', 'https://criptoya.com/api/ripio/USDT/ARS'],
  ['BRL', 'https://criptoya.com/api/ripio/USDT/BRL']
];

/**
 * Fetches fiat quotes from external APIs
 * @returns {Promise<FiatQuoteType[]>} Array of fiat currency quotes
 */
export async function getFiatQuotes(): Promise<FiatQuoteType[]> {
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

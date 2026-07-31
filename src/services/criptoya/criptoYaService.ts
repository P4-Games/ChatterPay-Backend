import { CACHE_FIAT_TTL, CRIPTO_YA_URL, FIAT_CURRENCIES } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import { CacheNames, type Currency, type FiatQuote } from '../../types/commonType';
import { cacheService } from '../cache/cacheService';

// Persists the last successfully fetched rate per currency, with no expiry, so a
// transient criptoya failure/rate-limit can fall back to a real rate instead of
// silently rendering ARS/BRL/UYU 1:1 with USD.
const lastGoodKey = (currency: Currency): string => `${currency}:last-good`;

/**
 * Fetches fiat quotes from external APIs, cached to avoid hammering criptoya on
 * every balance request and to keep serving a real rate if a fetch fails.
 * @returns {Promise<FiatQuote[]>} Array of fiat currency quotes
 */
export async function getFiatQuotes(): Promise<FiatQuote[]> {
  return Promise.all(
    (FIAT_CURRENCIES as Currency[]).map(async (currency) => {
      const cached = cacheService.get<number>(CacheNames.FIAT, currency);
      if (cached !== undefined) return { currency, rate: cached } as FiatQuote;

      try {
        const response = await fetch(`${CRIPTO_YA_URL}/${currency}`);
        const data = await response.json();
        const rate = Number(data.bid);
        if (!rate) throw new Error(`Invalid bid for ${currency}: ${data.bid}`);

        cacheService.set(CacheNames.FIAT, currency, rate, CACHE_FIAT_TTL);
        cacheService.set(CacheNames.FIAT, lastGoodKey(currency), rate, 0); // no expiry
        return { currency, rate } as FiatQuote;
      } catch (error) {
        Logger.error('getFiatQuotes', `Error fetching ${currency} quote:`, error);
        const lastGood = cacheService.get<number>(CacheNames.FIAT, lastGoodKey(currency));
        return { currency, rate: lastGood ?? 1 }; // 1:1 only if we've never had a real rate
      }
    })
  );
}

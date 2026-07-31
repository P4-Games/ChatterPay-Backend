import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FIAT_CURRENCIES } from '../../../src/config/constants';
import { cacheService } from '../../../src/services/cache/cacheService';
import { getFiatQuotes } from '../../../src/services/criptoya/criptoYaService';
import { CacheNames } from '../../../src/types/commonType';

describe('criptoYaService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    cacheService.clearCache(CacheNames.FIAT);
  });

  it('fetches a quote per currency and returns its bid as the rate', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ bid: 1500 }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getFiatQuotes();

    expect(fetchMock).toHaveBeenCalledTimes(FIAT_CURRENCIES.length);
    expect(result).toEqual(FIAT_CURRENCIES.map((currency) => ({ currency, rate: 1500 })));

    vi.unstubAllGlobals();
  });

  it('reuses the cached rate instead of refetching', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ bid: 1500 }) });
    vi.stubGlobal('fetch', fetchMock);

    await getFiatQuotes();
    fetchMock.mockClear();
    const result = await getFiatQuotes();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(FIAT_CURRENCIES.map((currency) => ({ currency, rate: 1500 })));

    vi.unstubAllGlobals();
  });

  it('falls back to the last known good rate on fetch failure instead of 1:1', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ bid: 1500 }) });
    vi.stubGlobal('fetch', fetchMock);
    await getFiatQuotes();
    cacheService.remove(CacheNames.FIAT, 'ARS'); // expire the fresh cache, keep the last-good one

    fetchMock.mockRejectedValue(new Error('criptoya unavailable'));
    const result = await getFiatQuotes();

    const ars = result.find((q) => q.currency === 'ARS');
    expect(ars?.rate).toBe(1500);

    vi.unstubAllGlobals();
  });

  it('falls back to 1:1 only when no rate has ever been fetched', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('criptoya unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getFiatQuotes();

    expect(result).toEqual(FIAT_CURRENCIES.map((currency) => ({ currency, rate: 1 })));

    vi.unstubAllGlobals();
  });
});

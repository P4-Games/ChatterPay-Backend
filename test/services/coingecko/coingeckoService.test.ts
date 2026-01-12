import axios from 'axios';
import NodeCache from 'node-cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RESULT_CURRENCIES, TOKEN_IDS } from '../../../src/config/constants';
import { coingeckoService } from '../../../src/services/coingecko/coingeckoService';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn()
  }
}));

describe('coingeckoService', () => {
  const mockResponse = {
    bitcoin: { usd: 101790, ars: 106974834, brl: 594659 },
    dai: { usd: 0.999591, ars: 1049.89, brl: 5.84 },
    ethereum: { usd: 3256.6, ars: 3422468, brl: 19025.03 },
    tether: { usd: 0.999748, ars: 1049.7, brl: 5.84 },
    'usd-coin': { usd: 1, ars: 1049.87, brl: 5.84 },
    'wrapped-bitcoin': { usd: 101671, ars: 106849130, brl: 593960 }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    // Stub: force NodeCache.get() to return undefined
    vi.spyOn(NodeCache.prototype, 'get').mockReturnValue(undefined);

    // Stub: avoid TimeoutOverflowWarning by neutralizing .set()
    vi.spyOn(NodeCache.prototype, 'set').mockImplementation(() => true);
  });

  it('should fetch conversion rates from CoinGecko API', async () => {
    // @ts-expect-error test mock
    (axios.get as vi.Mock).mockResolvedValueOnce({ data: mockResponse });

    const result = await coingeckoService.getConversationRates();

    expect(axios.get).toHaveBeenCalled();
    expect(result).toEqual(mockResponse);
  });

  it('should return cached conversion rates if available', async () => {
    vi.spyOn(NodeCache.prototype, 'get').mockImplementation((key) => {
      if (key === 'getConversationRates') return mockResponse;
      return undefined;
    });

    const result = await coingeckoService.getConversationRates();

    expect(axios.get).not.toHaveBeenCalled();
    expect(Object.keys(result)).toEqual(Object.keys(mockResponse));
  });

  it('should return fallback values when API request fails', async () => {
    // @ts-expect-error test mock
    (axios.get as vi.Mock).mockRejectedValueOnce(new Error('API error'));

    const mockFallbackResponse = TOKEN_IDS.reduce<Record<string, Record<string, number>>>(
      (acc, token) => {
        acc[token] = Object.fromEntries(RESULT_CURRENCIES.map((currency) => [currency, 0]));
        return acc;
      },
      {}
    );

    vi.spyOn(coingeckoService, 'getConversationRates').mockResolvedValueOnce(mockFallbackResponse);

    const result = await coingeckoService.getConversationRates();
    expect(result).toEqual(mockFallbackResponse);
  });
});

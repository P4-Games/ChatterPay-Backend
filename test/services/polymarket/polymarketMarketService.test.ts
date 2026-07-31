import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getEvents,
  getMarketBySlug,
  getMarketPrice,
  getMarkets,
  searchEvents
} from '../../../src/services/polymarket/polymarketMarketService';

// Mock axios module
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    isAxiosError: vi.fn()
  }
}));

// Mock the clientService to return a mock CLOB client
const mockClobClient = {
  getPrice: vi.fn().mockResolvedValue('0.65'),
  getOrderBook: vi.fn().mockResolvedValue({
    market: 'test-market',
    asset_id: 'test-asset',
    bids: [{ price: '0.64', size: '100' }],
    asks: [{ price: '0.66', size: '50' }]
  }),
  getMarket: vi.fn().mockResolvedValue({
    condition_id: 'test-condition',
    minimum_tick_size: '0.01',
    neg_risk: false
  })
};

vi.mock('../../../src/services/polymarket/polymarketClientService', () => ({
  createPublicClobClient: () => mockClobClient
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
import axios from 'axios';

const mockedAxios = axios as unknown as {
  get: ReturnType<typeof vi.fn>;
};

// Mock Logger
vi.mock('../../../src/helpers/loggerHelper', () => ({
  Logger: {
    log: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  }
}));

// Mock constants
vi.mock('../../../src/config/constants', () => ({
  POLYMARKET_GAMMA_API_URL: 'https://gamma-api.polymarket.com',
  POLYMARKET_CLOB_API_URL: 'https://clob.polymarket.com',
  POLYMARKET_DATA_API_URL: 'https://data-api.polymarket.com',
  POLYMARKET_CHAIN_ID: 137,
  POLYMARKET_ENABLED: true,
  POLYMARKET_TERMS_VERSION: 1,
  CACHE_POLYMARKET_MARKETS_TTL: 300,
  CACHE_POLYMARKET_MARKETS_CHECK_PERIOD: 360,
  CACHE_POLYMARKET_PRICES_TTL: 60,
  CACHE_POLYMARKET_PRICES_CHECK_PERIOD: 120
}));

const mockMarket = {
  id: '1',
  question: 'Will Bitcoin reach $100k?',
  conditionId: '0xabc',
  slug: 'bitcoin-100k',
  category: 'Crypto',
  endDate: '2026-12-31',
  image: 'https://example.com/btc.png',
  icon: '',
  description: 'Market description',
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.65","0.35"]',
  volume: '1000000',
  liquidity: '500000',
  active: true,
  closed: false,
  marketType: 'binary',
  clobTokenIds: '["token1","token2"]',
  volume24hr: '1000',
  volumeNum: 1000000,
  liquidityNum: 500000,
  bestBid: 0.64,
  bestAsk: 0.66,
  spread: 0.02,
  lastTradePrice: 0.65,
  oneDayPriceChange: 0.01,
  negRiskOther: false
};

const mockEvent = {
  id: '1',
  title: 'Crypto Milestones',
  slug: 'crypto-milestones',
  description: 'Crypto price milestones',
  category: 'Crypto',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  image: 'https://example.com/crypto.png',
  icon: '',
  active: true,
  closed: false,
  volume: 2000000,
  liquidity: 1000000,
  markets: [mockMarket],
  enableNegRisk: false,
  commentCount: 42
};

describe('polymarketMarketService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set mock implementations that vi.clearAllMocks() clears
    mockClobClient.getPrice.mockResolvedValue('0.65');
  });

  describe('getMarkets', () => {
    it('should fetch markets from Gamma API', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: [mockMarket],
        status: 200,
        statusText: 'OK'
      } as AxiosResponse);

      const result = await getMarkets({ limit: 10, offset: 0 }, '[test]');

      expect(result).toHaveLength(1);
      expect(result[0].question).toBe('Will Bitcoin reach $100k?');
      expect(result[0].slug).toBe('bitcoin-100k');
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://gamma-api.polymarket.com/markets',
        expect.objectContaining({
          params: expect.objectContaining({
            limit: 10,
            offset: 0,
            enableOrderBook: true
          })
        })
      );
    });

    it('should pass filter parameters to API', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: [mockMarket],
        status: 200,
        statusText: 'OK'
      } as AxiosResponse);

      await getMarkets({ limit: 5, offset: 10, active: true, category: 'Crypto' }, '[test]');

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://gamma-api.polymarket.com/markets',
        expect.objectContaining({
          params: expect.objectContaining({
            limit: 5,
            offset: 10,
            active: true,
            category: 'Crypto',
            enableOrderBook: true
          })
        })
      );
    });

    it('should throw on API error', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('Network error'));

      await expect(getMarkets({}, '[test]')).rejects.toThrow('Failed to fetch Polymarket markets');
    });

    it('should filter out markets with zero volume when filterZeroVolume is true', async () => {
      const zeroVolumeMarket = { ...mockMarket, id: '2', volume24hr: '0' };
      mockedAxios.get.mockResolvedValueOnce({
        data: [mockMarket, zeroVolumeMarket],
        status: 200,
        statusText: 'OK'
      } as AxiosResponse);

      const result = await getMarkets({ limit: 10, offset: 0, filterZeroVolume: true }, '[test]');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });
  });

  describe('getMarketBySlug', () => {
    it('should fetch a single market by slug', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: [mockMarket],
        status: 200,
        statusText: 'OK'
      } as AxiosResponse);

      const result = await getMarketBySlug('bitcoin-100k', '[test]');

      expect(result).not.toBeNull();
      expect(result?.question).toBe('Will Bitcoin reach $100k?');
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://gamma-api.polymarket.com/markets',
        expect.objectContaining({
          params: { slug: 'bitcoin-100k' }
        })
      );
    });

    it('should return null if market not found', async () => {
      // First lookup (closed=false) and the closed-market retry both return empty.
      mockedAxios.get
        .mockResolvedValueOnce({
          data: [],
          status: 200,
          statusText: 'OK'
        } as AxiosResponse)
        .mockResolvedValueOnce({
          data: [],
          status: 200,
          statusText: 'OK'
        } as AxiosResponse);

      const result = await getMarketBySlug('nonexistent', '[test]');
      expect(result).toBeNull();
    });
  });

  describe('getEvents', () => {
    it('should fetch events from Gamma API', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: [mockEvent],
        status: 200,
        statusText: 'OK'
      } as AxiosResponse);

      const result = await getEvents({ limit: 10 }, '[test]');

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Crypto Milestones');
      expect(result[0].markets).toHaveLength(1);
    });

    it('should throw on API error', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('Timeout'));

      await expect(getEvents({}, '[test]')).rejects.toThrow('Failed to fetch Polymarket events');
    });

    it('should filter out events with zero volume when filterZeroVolume is true', async () => {
      const zeroVolumeEvent = { ...mockEvent, id: '2', volume24hr: '0', volume: 0 };
      mockedAxios.get.mockResolvedValueOnce({
        data: [mockEvent, zeroVolumeEvent],
        status: 200,
        statusText: 'OK'
      } as AxiosResponse);

      const result = await getEvents({ limit: 10, offset: 0, filterZeroVolume: true }, '[test]');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });
  });

  describe('searchEvents', () => {
    it('should search events via Gamma public-search endpoint with the q parameter', async () => {
      const events = [
        {
          id: '1',
          title: 'Will Bitcoin reach $100k?',
          slug: 'bitcoin-100k',
          volume: '1000000',
          volume24hr: '50000',
          active: true,
          markets: [{ clobTokenIds: '["111","222"]', outcomePrices: '["0.65","0.35"]' }]
        }
      ];

      mockedAxios.get.mockResolvedValueOnce({
        data: { events },
        status: 200,
        statusText: 'OK'
      } as AxiosResponse);

      const result = await searchEvents('bitcoin', 5, '[test]');

      expect(result).toHaveLength(1);
      expect(result[0].title).toContain('Bitcoin');
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://gamma-api.polymarket.com/public-search',
        expect.objectContaining({
          params: expect.objectContaining({ q: 'bitcoin', limit_per_type: 5 })
        })
      );
    });
  });

  describe('getMarketPrice', () => {
    it('should fetch price from CLOB client', async () => {
      const price = await getMarketPrice('test-token-id', '[test]');

      expect(price).toBe(0.65);
    });
  });
});

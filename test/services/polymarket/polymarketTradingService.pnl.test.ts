import type { AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pin the Polymarket API URLs used by this test to their defaults, isolated from
// .env overrides (e.g. POLYMARKET_DATA_API_URL pointing at a proxy in local dev).
vi.mock('../../../src/config/constants', () => ({
  POLYMARKET_DATA_API_URL: 'https://data-api.polymarket.com',
  POLYMARKET_GAMMA_API_URL: 'https://gamma-api.polymarket.com',
  POLYMARKET_USER_PNL_API_URL: 'https://user-pnl-api.polymarket.com',
  POLYMARKET_POLYGON_RPC_URL: 'https://polygon-rpc.com'
}));

import { getPnlHistory } from '../../../src/services/polymarket/polymarketTradingService';

// Mock axios module
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    isAxiosError: vi.fn()
  }
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

// Mock heavy service dependencies not used by getPnlHistory
vi.mock('../../../src/services/polymarket/polymarketClientService', () => ({
  getAuthenticatedClientForUser: vi.fn()
}));

vi.mock('../../../src/services/polymarket/polymarketRelayerService', () => ({
  ensureTokenApprovals: vi.fn(),
  setupDepositWalletApprovals: vi.fn()
}));

vi.mock('../../../src/services/polymarket/polymarketHistoryService', () => ({
  mapClobStatusToTxStatus: vi.fn()
}));

vi.mock('../../../src/services/mongo/mongoTransactionService', () => ({
  mongoTransactionService: {}
}));

vi.mock('../../../src/models/polymarketModel', () => ({
  PolymarketOrderModel: {}
}));

const USER_ADDRESS = '0x56687bf447db6ffa42ffe2204a05edaa20f55839';

const ok = <T>(data: T) => ({ data, status: 200, statusText: 'OK' }) as AxiosResponse;

describe('polymarketTradingService - getPnlHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should map user-pnl API points (epoch seconds → ISO, p → cumulativePnl)', async () => {
    mockedAxios.get.mockResolvedValueOnce(
      ok([
        { t: 1751414400, p: -5.25 },
        { t: 1751500800, p: 2.77 }
      ])
    );

    const result = await getPnlHistory(USER_ADDRESS, '[test]');

    expect(result).toEqual([
      { timestamp: new Date(1751414400 * 1000).toISOString(), cumulativePnl: -5.25 },
      { timestamp: new Date(1751500800 * 1000).toISOString(), cumulativePnl: 2.77 }
    ]);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://user-pnl-api.polymarket.com/user-pnl',
      expect.objectContaining({
        params: { user_address: USER_ADDRESS, interval: 'all', fidelity: '1d' }
      })
    );
  });

  it('should request the fidelity matching the interval', async () => {
    mockedAxios.get.mockResolvedValueOnce(ok([]));

    await getPnlHistory(USER_ADDRESS, '[test]', undefined, '1d');

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://user-pnl-api.polymarket.com/user-pnl',
      expect.objectContaining({
        params: expect.objectContaining({ interval: '1d', fidelity: '1h' })
      })
    );
  });

  it('should fall back to trade-based realized PNL when the user-pnl API fails', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('user-pnl down'));
    mockedAxios.get.mockResolvedValueOnce(
      ok([
        // Unsorted on purpose: SELL (newest) first, timestamps in epoch SECONDS
        {
          side: 'SELL',
          price: '0.8',
          size: '10',
          timestamp: 1751500800
        },
        {
          side: 'BUY',
          price: '0.5',
          size: '10',
          timestamp: 1751414400
        }
      ])
    );

    const result = await getPnlHistory(USER_ADDRESS, '[test]');

    expect(result).toEqual([
      {
        timestamp: new Date(1751414400 * 1000).toISOString(),
        cumulativePnl: -5,
        totalInvested: 5,
        totalProceeds: 0
      },
      {
        timestamp: new Date(1751500800 * 1000).toISOString(),
        cumulativePnl: 3,
        totalInvested: 5,
        totalProceeds: 8
      }
    ]);
    expect(mockedAxios.get).toHaveBeenNthCalledWith(
      2,
      'https://data-api.polymarket.com/trades',
      expect.objectContaining({
        params: { user: USER_ADDRESS, limit: 10000 }
      })
    );
  });

  it('should downsample to limit while keeping first and last points', async () => {
    const points = Array.from({ length: 50 }, (_, i) => ({
      t: 1751414400 + i * 3600,
      p: Math.sin(i) * 10
    }));
    mockedAxios.get.mockResolvedValueOnce(ok(points));

    const result = await getPnlHistory(USER_ADDRESS, '[test]', 10);

    expect(result).toHaveLength(10);
    expect(result[0].timestamp).toBe(new Date(points[0].t * 1000).toISOString());
    expect(result[9].timestamp).toBe(new Date(points[49].t * 1000).toISOString());
  });

  it('should throw when both the user-pnl API and the trades fallback fail', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('user-pnl down'));
    mockedAxios.get.mockRejectedValueOnce(new Error('trades down'));

    await expect(getPnlHistory(USER_ADDRESS, '[test]')).rejects.toThrow(
      'Failed to compute PNL history'
    );
  });
});

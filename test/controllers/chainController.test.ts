import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getChains } from '../../src/controllers/chainController';
import * as lifiService from '../../src/services/lifi/lifiService';

// Mock lifiService
vi.mock('../../src/services/lifi/lifiService', () => ({
  getLifiChains: vi.fn()
}));

// Mock helpers
vi.mock('../../src/helpers/requestHelper', () => ({
  returnSuccessResponse: vi.fn(
    (_reply: FastifyReply, message: string, data: Record<string, unknown>) => ({
      status: 'success',
      message,
      data
    })
  ),
  returnErrorResponse: vi.fn(
    (_method: string, _logKey: string, _reply: FastifyReply, code: number, message: string) => ({
      status: 'error',
      code,
      message
    })
  )
}));

describe('chainController', () => {
  const mockReply = {} as FastifyReply;
  const mockRequest = {} as FastifyRequest;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getChains', () => {
    it('should return list of chains with simplified format', async () => {
      const mockChains = [
        {
          key: 'eth',
          name: 'Ethereum',
          chainType: 'EVM',
          id: 1,
          mainnet: true,
          coin: 'ETH',
          logoURI: 'https://example.com/eth.png'
        },
        {
          key: 'arb',
          name: 'Arbitrum',
          chainType: 'EVM',
          id: 42161,
          mainnet: true,
          coin: 'ETH',
          logoURI: 'https://example.com/arb.png'
        },
        {
          key: 'sol',
          name: 'Solana',
          chainType: 'SVM',
          id: 1151111081099710,
          mainnet: true,
          coin: 'SOL',
          logoURI: 'https://example.com/sol.png'
        }
      ];

      vi.mocked(lifiService.getLifiChains).mockResolvedValueOnce(mockChains);

      const result = (await getChains(mockRequest, mockReply)) as {
        status: string;
        data: { chains: Array<{ key: string; name: string; chainType: string; chainId: number; coin: string }> };
      };

      expect(lifiService.getLifiChains).toHaveBeenCalledWith('[op:get-chains]');
      expect(result.status).toBe('success');
      expect(result.data.chains).toHaveLength(3);
      expect(result.data.chains[0]).toMatchObject({
        key: 'eth',
        name: 'ethereum',
        chainType: 'EVM',
        chainId: 1,
        coin: 'ETH'
      });
    });

    it('should convert chain names to lowercase', async () => {
      const mockChains = [{ key: 'eth', name: 'Ethereum', chainType: 'EVM', id: 1, mainnet: true, coin: 'ETH' }];

      vi.mocked(lifiService.getLifiChains).mockResolvedValueOnce(mockChains);

      const result = (await getChains(mockRequest, mockReply)) as {
        status: string;
        data: { chains: Array<{ name: string }> };
      };

      expect(result.data.chains[0].name).toBe('ethereum');
    });

    it('should return error on service failure', async () => {
      vi.mocked(lifiService.getLifiChains).mockRejectedValueOnce(new Error('API Error'));

      const result = (await getChains(mockRequest, mockReply)) as { status: string; code: number; message: string };

      expect(result.status).toBe('error');
      expect(result.code).toBe(500);
      expect(result.message).toBe('Failed to fetch chains');
    });
  });
});

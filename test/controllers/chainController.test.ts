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
  returnSuccessResponse: vi.fn((reply, message, data) => ({ status: 'success', message, data })),
  returnErrorResponse: vi.fn((method, logKey, reply, code, message) => ({ status: 'error', code, message }))
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
        { key: 'eth', name: 'Ethereum', chainType: 'EVM', id: 1, mainnet: true, coin: 'ETH', logoURI: 'https://example.com/eth.png' },
        { key: 'arb', name: 'Arbitrum', chainType: 'EVM', id: 42161, mainnet: true, coin: 'ETH', logoURI: 'https://example.com/arb.png' },
        { key: 'sol', name: 'Solana', chainType: 'SVM', id: 1151111081099710, mainnet: true, coin: 'SOL', logoURI: 'https://example.com/sol.png' }
      ];

      vi.mocked(lifiService.getLifiChains).mockResolvedValueOnce(mockChains);

      const result = await getChains(mockRequest, mockReply);

      expect(lifiService.getLifiChains).toHaveBeenCalledWith('[op:get-chains]');
      expect(result).toMatchObject({
        status: 'success',
        data: {
          chains: [
            { key: 'eth', name: 'ethereum', chainType: 'EVM', chainId: 1, coin: 'ETH' },
            { key: 'arb', name: 'arbitrum', chainType: 'EVM', chainId: 42161, coin: 'ETH' },
            { key: 'sol', name: 'solana', chainType: 'SVM', chainId: 1151111081099710, coin: 'SOL' }
          ]
        }
      });
    });

    it('should convert chain names to lowercase', async () => {
      const mockChains = [
        { key: 'eth', name: 'Ethereum', chainType: 'EVM', id: 1, mainnet: true, coin: 'ETH' }
      ];

      vi.mocked(lifiService.getLifiChains).mockResolvedValueOnce(mockChains);

      const result = await getChains(mockRequest, mockReply);

      expect(result.data.chains[0].name).toBe('ethereum');
    });

    it('should return error on service failure', async () => {
      vi.mocked(lifiService.getLifiChains).mockRejectedValueOnce(new Error('API Error'));

      const result = await getChains(mockRequest, mockReply);

      expect(result).toMatchObject({
        status: 'error',
        code: 500,
        message: 'Failed to fetch chains'
      });
    });
  });
});

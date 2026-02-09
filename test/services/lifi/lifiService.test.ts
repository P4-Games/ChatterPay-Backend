import type { AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getLifiChains,
  getLifiToken,
  validateAddressForChainType
} from '../../../src/services/lifi/lifiService';

// Mock axios module
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    isAxiosError: vi.fn()
  }
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
import axios from 'axios';

describe('lifiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('getLifiChains', () => {
    it('should fetch and filter mainnet chains', async () => {
      const mockChains = {
        chains: [
          { key: 'eth', name: 'Ethereum', chainType: 'EVM', id: 1, mainnet: true, coin: 'ETH' },
          { key: 'arb', name: 'Arbitrum', chainType: 'EVM', id: 42161, mainnet: true, coin: 'ETH' },
          { key: 'sol', name: 'Solana', chainType: 'SVM', id: 1151111081099710, mainnet: true, coin: 'SOL' },
          { key: 'gor', name: 'Goerli', chainType: 'EVM', id: 5, mainnet: false, coin: 'ETH' }
        ]
      };

      vi.mocked(axios.get).mockResolvedValueOnce({ data: mockChains } as AxiosResponse);

      const chains = await getLifiChains('[test]');

      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('/chains'),
        expect.objectContaining({
          params: { chainTypes: 'EVM,SVM,UTXO' }
        })
      );
      expect(chains).toHaveLength(3); // Only mainnet chains
      expect(chains.map((c) => c.key)).toEqual(['eth', 'arb', 'sol']);
    });

    it('should throw error on API failure', async () => {
      vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network error'));
      vi.mocked(axios.isAxiosError).mockReturnValue(false);

      await expect(getLifiChains('[test]')).rejects.toThrow('Li.Fi chains fetch failed');
    });
  });

  describe('getLifiToken', () => {
    it('should fetch token by symbol', async () => {
      const mockToken = {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        symbol: 'USDC',
        decimals: 6,
        chainId: 1
      };

      vi.mocked(axios.get).mockResolvedValueOnce({ data: mockToken } as AxiosResponse);

      const token = await getLifiToken('eth', 'USDC', '[test]');

      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('/token'),
        expect.objectContaining({
          params: { chain: 'eth', token: 'USDC' }
        })
      );
      expect(token?.symbol).toBe('USDC');
      expect(token?.address).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    });

    it('should try alias when token not found', async () => {
      const mockToken = {
        address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        symbol: 'USDT0',
        decimals: 6,
        chainId: 42161
      };

      // First call fails (USDT), second succeeds (USDT0)
      vi.mocked(axios.get).mockRejectedValueOnce({ response: { status: 404 } });
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      vi.mocked(axios.get).mockResolvedValueOnce({ data: mockToken } as AxiosResponse);

      const token = await getLifiToken('arb', 'USDT', '[test]');

      expect(axios.get).toHaveBeenCalledTimes(2);
      expect(token?.symbol).toBe('USDT0');
    });

    it('should return null when token and aliases not found', async () => {
      vi.mocked(axios.get).mockRejectedValue({ response: { status: 404 } });
      vi.mocked(axios.isAxiosError).mockReturnValue(true);

      const token = await getLifiToken('eth', 'INVALID', '[test]');

      expect(token).toBeNull();
    });
  });

  describe('validateAddressForChainType', () => {
    describe('EVM addresses', () => {
      it('should validate correct EVM address', () => {
        expect(validateAddressForChainType('0xf080d5b40C370a5148a9848A869eb3Aaf7d5E146', 'EVM')).toBe(true);
      });

      it('should reject invalid EVM address', () => {
        expect(validateAddressForChainType('invalid', 'EVM')).toBe(false);
        expect(validateAddressForChainType('0xinvalid', 'EVM')).toBe(false);
        expect(validateAddressForChainType('0x123', 'EVM')).toBe(false);
      });
    });

    describe('SVM (Solana) addresses', () => {
      it('should validate correct Solana address', () => {
        expect(validateAddressForChainType('BBahdTRW3vPYXkSZuXF2wJJoDrDK3gzSok4gqS4WFFsr', 'SVM')).toBe(true);
        expect(validateAddressForChainType('7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs', 'SVM')).toBe(true);
      });

      it('should reject invalid Solana address', () => {
        expect(validateAddressForChainType('0xf080d5b40C370a5148a9848A869eb3Aaf7d5E146', 'SVM')).toBe(false);
        expect(validateAddressForChainType('invalid', 'SVM')).toBe(false);
        expect(validateAddressForChainType('12345', 'SVM')).toBe(false);
      });
    });

    describe('UTXO (Bitcoin) addresses', () => {
      it('should validate correct Bitcoin addresses', () => {
        // P2PKH (legacy)
        expect(validateAddressForChainType('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'UTXO')).toBe(true);
        // P2SH
        expect(validateAddressForChainType('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'UTXO')).toBe(true);
        // Bech32 (native segwit)
        expect(validateAddressForChainType('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'UTXO')).toBe(true);
      });

      it('should reject invalid Bitcoin address', () => {
        expect(validateAddressForChainType('0xf080d5b40C370a5148a9848A869eb3Aaf7d5E146', 'UTXO')).toBe(false);
        expect(validateAddressForChainType('invalid', 'UTXO')).toBe(false);
      });
    });

    describe('unknown chain types', () => {
      it('should return false for unknown chain types (strict)', () => {
        expect(validateAddressForChainType('any_address', 'UNKNOWN')).toBe(false);
      });
    });
  });
});

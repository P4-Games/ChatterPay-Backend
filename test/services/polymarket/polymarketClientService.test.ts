import { describe, expect, it, vi } from 'vitest';

import {
  decryptApiCredentials,
  derivePolygonAddress,
  encryptApiCredentials
} from '../../../src/services/polymarket/polymarketClientService';

// Mock constants
vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  return {
    ...actual,
    POLYMARKET_CLOB_API_URL: 'https://clob.polymarket.com',
    POLYMARKET_CHAIN_ID: 137,
    $S: 'test-encryption-salt-value'
  };
});

// Mock Logger
vi.mock('../../../src/helpers/loggerHelper', () => ({
  Logger: {
    log: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  }
}));

// Mock ClobClient
vi.mock('@polymarket/clob-client', () => ({
  ClobClient: vi.fn().mockImplementation(() => ({
    createOrDeriveApiKey: vi.fn().mockResolvedValue({
      key: 'test-api-key',
      secret: 'test-secret',
      passphrase: 'test-passphrase'
    })
  }))
}));

describe('polymarketClientService', () => {
  describe('credential encryption/decryption', () => {
    const testCredentials = {
      key: 'test-api-key-12345',
      secret: 'test-secret-67890',
      passphrase: 'test-passphrase-abcde'
    };

    it('should encrypt credentials to a non-empty string', () => {
      const encrypted = encryptApiCredentials(testCredentials);
      expect(encrypted).toBeTruthy();
      expect(typeof encrypted).toBe('string');
      expect(encrypted).not.toEqual(JSON.stringify(testCredentials));
    });

    it('should produce encrypted string with iv:authTag:ciphertext format', () => {
      const encrypted = encryptApiCredentials(testCredentials);
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(3);
      // IV is 16 bytes = 32 hex chars
      expect(parts[0]).toHaveLength(32);
      // Auth tag is 16 bytes = 32 hex chars
      expect(parts[1]).toHaveLength(32);
      // Ciphertext is non-empty
      expect(parts[2].length).toBeGreaterThan(0);
    });

    it('should decrypt back to original credentials', () => {
      const encrypted = encryptApiCredentials(testCredentials);
      const decrypted = decryptApiCredentials(encrypted);

      expect(decrypted.key).toBe(testCredentials.key);
      expect(decrypted.secret).toBe(testCredentials.secret);
      expect(decrypted.passphrase).toBe(testCredentials.passphrase);
    });

    it('should produce different ciphertexts for same input (random IV)', () => {
      const encrypted1 = encryptApiCredentials(testCredentials);
      const encrypted2 = encryptApiCredentials(testCredentials);

      // IVs should be different (random)
      expect(encrypted1.split(':')[0]).not.toBe(encrypted2.split(':')[0]);
      // But both should decrypt to the same value
      expect(decryptApiCredentials(encrypted1)).toEqual(decryptApiCredentials(encrypted2));
    });

    it('should throw on tampered ciphertext', () => {
      const encrypted = encryptApiCredentials(testCredentials);
      const parts = encrypted.split(':');

      // Tamper with ciphertext
      const tampered = `${parts[0]}:${parts[1]}:${parts[2].replace(
        parts[2][0],
        parts[2][0] === 'a' ? 'b' : 'a'
      )}`;

      expect(() => decryptApiCredentials(tampered)).toThrow();
    });
  });

  describe('derivePolygonAddress', () => {
    it('should derive a valid Ethereum address from a private key', () => {
      // Known test private key (DO NOT use in production)
      const testPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
      const address = derivePolygonAddress(testPrivateKey);

      expect(address).toBeTruthy();
      expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      // This is the known address for this test private key (Hardhat account #0)
      expect(address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    });

    it('should derive different addresses for different keys', () => {
      const key1 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
      const key2 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

      const address1 = derivePolygonAddress(key1);
      const address2 = derivePolygonAddress(key2);

      expect(address1).not.toBe(address2);
    });
  });
});

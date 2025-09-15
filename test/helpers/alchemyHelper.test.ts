import { describe, it, expect } from 'vitest';
import { 
  toTopicAddress, 
  fromTopicAddress, 
  isValidAddress, 
  normalizeAddress 
} from '../../src/helpers/alchemyHelper';

describe('AlchemyHelper', () => {
  const testAddress = '0x1234567890123456789012345678901234567890';
  const testAddressLower = testAddress.toLowerCase();
  const testTopic = '0x0000000000000000000000001234567890123456789012345678901234567890';

  describe('toTopicAddress', () => {
    it('should convert address to padded topic', () => {
      const result = toTopicAddress(testAddress);
      expect(result).toBe(testTopic);
    });

    it('should handle address without 0x prefix', () => {
      const addressWithout0x = testAddress.slice(2);
      const result = toTopicAddress(addressWithout0x);
      expect(result).toBe(testTopic);
    });

    it('should handle lowercase address', () => {
      const result = toTopicAddress(testAddressLower);
      expect(result).toBe(testTopic);
    });
  });

  describe('fromTopicAddress', () => {
    it('should extract address from topic', () => {
      const result = fromTopicAddress(testTopic);
      expect(result).toBe(testAddressLower);
    });

    it('should handle topic without 0x prefix', () => {
      const topicWithout0x = testTopic.slice(2);
      const result = fromTopicAddress(topicWithout0x);
      expect(result).toBe(testAddressLower);
    });
  });

  describe('isValidAddress', () => {
    it('should validate correct address', () => {
      expect(isValidAddress(testAddress)).toBe(true);
    });

    it('should validate lowercase address', () => {
      expect(isValidAddress(testAddressLower)).toBe(true);
    });

    it('should reject address without 0x prefix', () => {
      expect(isValidAddress(testAddress.slice(2))).toBe(false);
    });

    it('should reject short address', () => {
      expect(isValidAddress('0x123')).toBe(false);
    });

    it('should reject long address', () => {
      expect(isValidAddress(testAddress + '00')).toBe(false);
    });

    it('should reject invalid characters', () => {
      expect(isValidAddress('0x123456789012345678901234567890123456789g')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidAddress('')).toBe(false);
    });
  });

  describe('normalizeAddress', () => {
    it('should normalize uppercase address to lowercase', () => {
      const result = normalizeAddress(testAddress.toUpperCase());
      expect(result).toBe(testAddressLower);
    });

    it('should keep lowercase address unchanged', () => {
      const result = normalizeAddress(testAddressLower);
      expect(result).toBe(testAddressLower);
    });

    it('should throw for invalid address', () => {
      expect(() => normalizeAddress('invalid')).toThrow('Invalid Ethereum address');
    });
  });

  describe('round trip conversion', () => {
    it('should convert address to topic and back correctly', () => {
      const topic = toTopicAddress(testAddress);
      const backToAddress = fromTopicAddress(topic);
      expect(backToAddress).toBe(testAddressLower);
    });
  });
});

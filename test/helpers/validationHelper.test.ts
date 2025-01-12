import { ethers } from 'ethers';
import { it, expect, describe } from 'vitest';

import { short_urls_domains } from '../../src/config/shortUrlsDomains.json';
import {
  isValidUrl,
  isShortUrl,
  isValidPhoneNumber,
  isValidEthereumWallet
} from '../../src/helpers/validationHelper';

describe('Validation Functions', () => {
  describe('isValidPhoneNumber', () => {
    it('should return true for valid phone numbers', () => {
      expect(isValidPhoneNumber('12345678')).toBe(true);
      expect(isValidPhoneNumber('+1 (123) 456-7890')).toBe(true);
      expect(isValidPhoneNumber('00123456789012')).toBe(true);
    });

    it('should return false for invalid phone numbers', () => {
      expect(isValidPhoneNumber('123')).toBe(false);
      expect(isValidPhoneNumber('phone123')).toBe(false);
      expect(isValidPhoneNumber('')).toBe(false);
    });
  });

  describe('isValidUrl', () => {
    it('should return true for valid URLs', () => {
      expect(isValidUrl('https://www.example.com')).toBe(true);
      expect(isValidUrl('http://example.com')).toBe(true);
      expect(isValidUrl('www.example.com')).toBe(true);
    });

    it('should return false for invalid URLs', () => {
      expect(isValidUrl('not-a-url')).toBe(false);
      expect(isValidUrl('http:/example')).toBe(false);
      expect(isValidUrl('')).toBe(false);
    });
  });

  describe('isShortUrl', () => {
    it('should return true for short URLs', () => {
      const shortUrl = `https://${short_urls_domains[0]}/short-url`;
      expect(isShortUrl(shortUrl)).toBe(true);
    });

    it('should return false for non-short URLs', () => {
      expect(isShortUrl('https://www.example.com')).toBe(false);
      expect(isShortUrl('http://anotherdomain.com')).toBe(false);
    });
  });

  describe('isValidEthereumWallet', () => {
    it('should return true for valid Ethereum addresses', () => {
      const validAddress = ethers.Wallet.createRandom().address;
      expect(isValidEthereumWallet(validAddress)).toBe(true);
    });

    it('should return false for invalid Ethereum addresses', () => {
      expect(isValidEthereumWallet('0xINVALIDADDRESS')).toBe(false);
      expect(isValidEthereumWallet('12345')).toBe(false);
      expect(isValidEthereumWallet('')).toBe(false);
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { AlchemyWebhookVerifier } from '../../../src/services/alchemy/alchemyWebhookVerifier';

describe('AlchemyWebhookVerifier', () => {
  let verifier: AlchemyWebhookVerifier;
  const testSigningKey = 'test-signing-key-123';
  const testPayload = '{"test": "payload", "data": "example"}';

  beforeEach(() => {
    verifier = new AlchemyWebhookVerifier(testSigningKey);
  });

  describe('constructor', () => {
    it('should throw error if no signing key provided', () => {
      expect(() => new AlchemyWebhookVerifier('')).toThrow('ALCHEMY_SIGNING_KEY is required');
    });

    it('should create instance with provided signing key', () => {
      expect(() => new AlchemyWebhookVerifier(testSigningKey)).not.toThrow();
    });
  });

  describe('verifySignature', () => {
    it('should verify valid signature correctly', () => {
      // Create expected signature
      const hmac = crypto.createHmac('sha256', testSigningKey);
      hmac.update(testPayload, 'utf8');
      const expectedSignature = hmac.digest('hex');

      const isValid = verifier.verifySignature(testPayload, expectedSignature);
      expect(isValid).toBe(true);
    });

    it('should verify valid signature with 0x prefix', () => {
      const hmac = crypto.createHmac('sha256', testSigningKey);
      hmac.update(testPayload, 'utf8');
      const expectedSignature = '0x' + hmac.digest('hex');

      const isValid = verifier.verifySignature(testPayload, expectedSignature);
      expect(isValid).toBe(true);
    });

    it('should reject invalid signature', () => {
      const invalidSignature = 'invalid-signature';
      const isValid = verifier.verifySignature(testPayload, invalidSignature);
      expect(isValid).toBe(false);
    });

    it('should reject tampered payload', () => {
      const hmac = crypto.createHmac('sha256', testSigningKey);
      hmac.update(testPayload, 'utf8');
      const validSignature = hmac.digest('hex');

      const tamperedPayload = '{"test": "tampered", "data": "example"}';
      const isValid = verifier.verifySignature(tamperedPayload, validSignature);
      expect(isValid).toBe(false);
    });

    it('should handle Buffer payload', () => {
      const payloadBuffer = Buffer.from(testPayload, 'utf8');
      const hmac = crypto.createHmac('sha256', testSigningKey);
      hmac.update(testPayload, 'utf8');
      const expectedSignature = hmac.digest('hex');

      const isValid = verifier.verifySignature(payloadBuffer, expectedSignature);
      expect(isValid).toBe(true);
    });

    it('should return false for missing signature', () => {
      const isValid = verifier.verifySignature(testPayload, '');
      expect(isValid).toBe(false);
    });

    it('should handle malformed signature gracefully', () => {
      const malformedSignature = 'not-hex';
      const isValid = verifier.verifySignature(testPayload, malformedSignature);
      expect(isValid).toBe(false);
    });
  });

  describe('requireValidSignature', () => {
    it('should not throw for valid signature', () => {
      const hmac = crypto.createHmac('sha256', testSigningKey);
      hmac.update(testPayload, 'utf8');
      const validSignature = hmac.digest('hex');

      expect(() => {
        verifier.requireValidSignature(testPayload, validSignature);
      }).not.toThrow();
    });

    it('should throw for invalid signature', () => {
      const invalidSignature = 'invalid';
      expect(() => {
        verifier.requireValidSignature(testPayload, invalidSignature);
      }).toThrow('Invalid webhook signature');
    });
  });
});

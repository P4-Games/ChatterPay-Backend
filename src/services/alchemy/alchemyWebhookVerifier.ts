import crypto from 'crypto';
import { Logger } from '../../helpers/loggerHelper';
import { ALCHEMY_SIGNING_KEY } from '../../config/constants';

/**
 * Service for verifying Alchemy webhook HMAC signatures
 */
export class AlchemyWebhookVerifier {
  private readonly signingKey: string;

  constructor(signingKey?: string) {
    this.signingKey = signingKey || ALCHEMY_SIGNING_KEY || '';
    if (!this.signingKey) {
      throw new Error('ALCHEMY_SIGNING_KEY is required for webhook verification');
    }
  }

  /**
   * Verifies the HMAC signature of an Alchemy webhook payload
   * @param rawBody - The raw request body as string or Buffer
   * @param signature - The signature from X-Alchemy-Signature header
   * @returns True if signature is valid, false otherwise
   */
  public verifySignature(rawBody: string | Buffer, signature: string): boolean {
    try {
      if (!signature) {
        Logger.warn('AlchemyWebhookVerifier', 'Missing signature header');
        return false;
      }

      // Ensure we have the raw body as a string
      const bodyString = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

      // Create HMAC using SHA-256
      const hmac = crypto.createHmac('sha256', this.signingKey);
      hmac.update(bodyString, 'utf8');
      const expectedSignature = hmac.digest('hex');

      // Remove any '0x' prefix from the provided signature
      const cleanSignature = signature.replace(/^0x/, '');

      // Compare signatures using timing-safe comparison
      const isValid = crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(cleanSignature, 'hex')
      );

      if (!isValid) {
        Logger.warn('AlchemyWebhookVerifier', 'Invalid webhook signature', {
          expected: expectedSignature.substring(0, 8) + '...',
          received: cleanSignature.substring(0, 8) + '...'
        });
      }

      return isValid;
    } catch (error) {
      Logger.error('AlchemyWebhookVerifier', 'Error verifying webhook signature', error);
      return false;
    }
  }

  /**
   * Middleware-style verification function
   * @param rawBody - The raw request body
   * @param signature - The signature from headers
   * @throws Error if signature is invalid
   */
  public requireValidSignature(rawBody: string | Buffer, signature: string): void {
    if (!this.verifySignature(rawBody, signature)) {
      throw new Error('Invalid webhook signature');
    }
  }
}

// Export a singleton instance (lazy initialization)
let _alchemyWebhookVerifier: AlchemyWebhookVerifier | null = null;

export const alchemyWebhookVerifier = (): AlchemyWebhookVerifier => {
  if (!_alchemyWebhookVerifier) {
    _alchemyWebhookVerifier = new AlchemyWebhookVerifier();
  }
  return _alchemyWebhookVerifier;
};

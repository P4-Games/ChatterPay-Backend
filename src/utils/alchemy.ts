import crypto from 'crypto';

import { ALCHEMY_AUTH_TOKEN } from '../constants/environment';

/**
 * Verifies the signature of an Alchemy webhook request.
 * 
 * This function uses HMAC-SHA256 to compute a signature based on the request body
 * and compares it with the provided signature to ensure the authenticity of the webhook.
 * 
 * @param {string} signature - The signature provided in the Alchemy webhook request header.
 * @param {unknown} body - The body of the Alchemy webhook request.
 * @returns {boolean} True if the computed signature matches the provided signature, false otherwise.
 * 
 * @throws {Error} If ALCHEMY_AUTH_TOKEN is not set in the environment variables.
 */
export function verifyAlchemySignature(signature: string, body: unknown): boolean {
    if (!ALCHEMY_AUTH_TOKEN) {
        throw new Error('ALCHEMY_AUTH_TOKEN is not set in environment variables');
    }

    const hmac = crypto.createHmac('sha256', ALCHEMY_AUTH_TOKEN);
    hmac.update(JSON.stringify(body));
    const computedSignature = hmac.digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computedSignature));
}
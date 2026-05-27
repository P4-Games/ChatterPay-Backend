/**
 * Polymarket Client Service
 *
 * Manages CLOB client instances, API credential lifecycle, and encryption.
 * Each user gets their own authenticated CLOB client derived from their EOA wallet.
 *
 * @see https://docs.polymarket.com/api-reference/authentication
 */

import { type ApiKeyCreds, ClobClient, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { Wallet } from 'ethers';

import { $S, POLYMARKET_CHAIN_ID, POLYMARKET_CLOB_API_URL } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import type { IUser } from '../../models/userModel';
import { UserModel } from '../../models/userModel';
import { deriveSafeAddress } from './polymarketRelayerService';

const LOG_PREFIX = 'polymarketClientService';

// ============================================================================
// Encryption Helpers (AES-256-GCM)
// ============================================================================

/** Derive a 32-byte encryption key from the internal salt */
function deriveEncryptionKey(): Buffer {
  return createHash('sha256')
    .update($S ?? 'default-salt')
    .digest();
}

/** Encrypt API credentials for storage in MongoDB */
export function encryptApiCredentials(credentials: ApiKeyCreds): string {
  const key = deriveEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const plaintext = JSON.stringify(credentials);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  // Format: iv:authTag:ciphertext
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/** Decrypt API credentials from MongoDB storage */
export function decryptApiCredentials(encryptedData: string): ApiKeyCreds {
  const parts = encryptedData.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error(
      'Corrupted Polymarket credentials: expected format "iv:authTag:ciphertext" ' +
        `but got ${parts.length} segment(s)`
    );
  }

  const [ivHex, authTagHex, ciphertext] = parts;
  const key = deriveEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  const parsed = JSON.parse(decrypted);
  if (!parsed || !parsed.key || !parsed.secret || !parsed.passphrase) {
    throw new Error(
      'Decrypted Polymarket credentials missing required fields (key, secret, passphrase)'
    );
  }

  return parsed as ApiKeyCreds;
}

// ============================================================================
// CLOB Client Management
// ============================================================================

/**
 * Create a basic (unauthenticated) CLOB client for public endpoints.
 * Used for market data queries that don't require API credentials.
 */
export function createPublicClobClient(): ClobClient {
  return new ClobClient({ host: POLYMARKET_CLOB_API_URL, chain: POLYMARKET_CHAIN_ID });
}

/**
 * Create an authenticated CLOB client for a user.
 * Requires the user's private key and stored API credentials.
 *
 * @param privateKey - User's EOA private key
 * @param credentials - Decrypted API credentials
 * @returns Authenticated ClobClient instance
 */
export function createAuthenticatedClobClient(
  privateKey: string,
  credentials: ApiKeyCreds,
  funderAddress?: string
): ClobClient {
  const signer = new Wallet(privateKey);
  const signatureType = funderAddress ? SignatureTypeV2.POLY_GNOSIS_SAFE : SignatureTypeV2.EOA;

  return new ClobClient({
    host: POLYMARKET_CLOB_API_URL,
    chain: POLYMARKET_CHAIN_ID,
    signer,
    creds: credentials,
    signatureType,
    funderAddress
  });
}

/**
 * Create or derive API credentials for a user's wallet.
 * Uses the CLOB SDK's createOrDeriveApiKey method.
 *
 * @param privateKey - User's EOA private key
 * @returns API credentials (apiKey, secret, passphrase)
 */
export async function getOrCreateApiCredentials(
  privateKey: string,
  funderAddress?: string
): Promise<ApiKeyCreds> {
  const logKey = `[${LOG_PREFIX}:getOrCreateApiCredentials]`;

  try {
    const signer = new Wallet(privateKey);
    const signatureType = funderAddress ? SignatureTypeV2.POLY_GNOSIS_SAFE : SignatureTypeV2.EOA;
    const client = new ClobClient({
      host: POLYMARKET_CLOB_API_URL,
      chain: POLYMARKET_CHAIN_ID,
      signer,
      signatureType,
      funderAddress
    });

    Logger.log(
      'info',
      logKey,
      `Creating/deriving API credentials${funderAddress ? ` for Safe ${funderAddress}` : ''}`
    );
    const credentials = await client.createOrDeriveApiKey();

    return credentials;
  } catch (error) {
    Logger.log('error', logKey, `Failed to create API credentials: ${String(error)}`);
    throw new Error(`Polymarket API credential creation failed: ${String(error)}`);
  }
}

/**
 * Get a fully authenticated CLOB client for a user.
 * Decrypts stored credentials and initializes the client.
 *
 * @param user - User document with polymarket_account
 * @param privateKey - User's EOA private key
 * @returns Authenticated ClobClient
 */
export async function getAuthenticatedClientForUser(
  user: IUser,
  privateKey: string
): Promise<ClobClient> {
  const logKey = `[${LOG_PREFIX}:getAuthenticatedClientForUser]`;

  if (!user.polymarket_account) {
    throw new Error('User does not have a Polymarket account');
  }

  try {
    // Derive the Safe address (deposit address) to use as the funder/maker
    const wallet = new Wallet(privateKey);
    const safeAddress = deriveSafeAddress(wallet.address);

    let credentialsEncrypted = user.polymarket_account.api_credentials_encrypted;

    // MIGRATION: If the stored address is still the EOA (or any other address),
    // we need to re-derive API credentials for the Safe address to avoid "invalid signature" errors.
    if (user.polymarket_account.polygon_address.toLowerCase() !== safeAddress.toLowerCase()) {
      Logger.log(
        'info',
        logKey,
        `Migrating user ${user.phone_number} to Safe-linked API credentials at ${safeAddress}`
      );

      const newCredentials = await getOrCreateApiCredentials(privateKey, safeAddress);
      credentialsEncrypted = encryptApiCredentials(newCredentials);

      await UserModel.findByIdAndUpdate(user._id, {
        $set: {
          'polymarket_account.polygon_address': safeAddress,
          'polymarket_account.api_credentials_encrypted': credentialsEncrypted
        }
      });

      // Update the local object for the current request
      user.polymarket_account.polygon_address = safeAddress;
      user.polymarket_account.api_credentials_encrypted = credentialsEncrypted;
    }

    const credentials = decryptApiCredentials(credentialsEncrypted);
    return createAuthenticatedClobClient(privateKey, credentials, safeAddress);
  } catch (error) {
    Logger.log('error', logKey, `Failed to get authenticated client: ${String(error)}`);
    throw new Error(`Failed to initialize Polymarket client: ${String(error)}`);
  }
}

/**
 * Derive the Polygon address from a private key.
 * Used when creating a Polymarket account to record the user's Polygon address.
 */
export function derivePolygonAddress(privateKey: string): string {
  const wallet = new Wallet(privateKey);
  return wallet.address;
}

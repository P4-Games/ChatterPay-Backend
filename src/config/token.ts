import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

import { GCP_PRIVATE_KEY } from '../constants/environment';

/**
 * Client instance for Google Cloud Secret Manager
 */
const client = new SecretManagerServiceClient({
  credentials: {
      "type": "service_account",
      "project_id": "chatterpay-429614",
      "private_key_id": "c803a4dee596c9fef727075ad1197482de17ef98",
      "private_key": GCP_PRIVATE_KEY,
      "client_email": "backend@chatterpay-429614.iam.gserviceaccount.com",
      "client_id": "110050886814548381507",
      "universe_domain": "googleapis.com"
    }
});

/**
 * Retrieves a secret from Google Cloud Secret Manager
 * @param {string} secretName - The name of the secret to retrieve
 * @returns {Promise<string>} The secret value
 * @throws {Error} If the secret cannot be loaded
 */
async function accessSecret(secretName: string): Promise<string> {
  const [version] = await client.accessSecretVersion({
    name: `projects/your-project-id/secrets/${secretName}/versions/latest`,
  });

  const payload = version.payload?.data?.toString();
  if (!payload) {
    throw new Error(`Failed to load secret ${secretName}`);
  }

  return payload;
}

/**
 * Retrieves frontend and chatizalo tokens from Google Cloud Secret Manager
 * @returns {Promise<{frontendToken: string, chatizaloToken: string}>} Object containing the tokens for each platform
 */
export async function getTokens(): Promise<{frontendToken: string, chatizaloToken: string}> {
  const frontendToken = await accessSecret('FRONTEND_TOKEN');
  const chatizaloToken = await accessSecret('CHATIZALO_TOKEN');

  return { frontendToken, chatizaloToken };
}
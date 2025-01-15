import { FastifyInstance } from 'fastify';

import Token, { IToken } from '../../models/tokenModel';
import { IBlockchain } from '../../models/blockchainModel';
import { getNetworkConfig } from '../../services/networkService';

// Extend the FastifyInstance interface to include our custom decorations
declare module 'fastify' {
  interface FastifyInstance {
    networkConfig: IBlockchain;
    tokens: IToken[];
    refreshTokens(): Promise<void>;
  }
}

/**
 * Sets up the network configuration and token management plugin for Fastify.
 * @param server - The Fastify server instance.
 */
export async function setupNetworkConfigPlugin(server: FastifyInstance): Promise<void> {
  // Fetch the initial tokens from the database when the server starts
  const initialTokens = await Token.find();

  // Fetch the network configuration once during server startup
  const networkConfig = await getNetworkConfig();

  // Decorate Fastify instance with network configuration and tokens
  // eslint-disable-next-line no-param-reassign
  server.networkConfig = networkConfig;
  // eslint-disable-next-line no-param-reassign
  server.tokens = initialTokens;

  /**
   * Refreshes the tokens stored in the Fastify instance.
   * This function updates the tokens by fetching the latest data from the database.
   */
  server.decorate('refreshTokens', async () => {
    try {
      const updatedTokens = await Token.find();
      // Update the tokens in Fastify
      // eslint-disable-next-line no-param-reassign
      server.tokens = updatedTokens;
      server.log.info('Tokens refreshed successfully');
    } catch (error) {
      server.log.error('Failed to refresh tokens:', error);
    }
  });

  /**
   * Adds hooks to refresh network configuration and tokens periodically.
   * The network configuration is refreshed every hour, and the tokens are refreshed every 5 minutes.
   */
  server.addHook('onReady', async () => {
    // Refresh the network configuration every hour
    setInterval(
      async () => {
        try {
          const updatedConfig = await getNetworkConfig();
      // eslint-disable-next-line no-param-reassign
      server.networkConfig = updatedConfig;
          server.log.info('Network config refreshed successfully');
        } catch (error) {
          server.log.error('Failed to refresh network config:', error);
        }
      },
      // 1 hour in milliseconds
      60 * 60 * 1000
    );

    // Refresh the tokens every 5 minutes
    setInterval(
      async () => {
        await server.refreshTokens();
      },
      // 5 minutes in milliseconds
      5 * 60 * 1000
    );
  });

  /**
   * Adds a hook that triggers after a response is sent.
   * It checks if the request modified tokens (via POST, PUT, or DELETE to /tokens) and refreshes them if so.
   */
  server.addHook('onResponse', async (request) => {
    // Check if the request was related to token modifications
    if (request.url.startsWith('/tokens') && ['POST', 'PUT', 'DELETE'].includes(request.method)) {
      // Refresh tokens if modified
      await server.refreshTokens();
    }
  });
}

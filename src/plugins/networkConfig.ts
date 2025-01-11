import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';

import Token, { IToken } from '../models/tokenModel';
import { IBlockchain } from '../models/blockchainModel';
import { getNetworkConfig } from '../services/networkService';

// Extend the FastifyInstance interface to include our custom decorations
declare module 'fastify' {
  interface FastifyInstance {
    networkConfig: IBlockchain;
    tokens: IToken[];
    refreshTokens(): Promise<void>;
  }
}

/**
 * Fastify plugin to manage network configuration and tokens.
 * It decorates the Fastify instance with network configuration and tokens,
 * and provides methods for refreshing tokens.
 */
export default fp(
  async (fastify: FastifyInstance) => {
    // Fetch the initial tokens from the database when the server starts
    const initialTokens = await Token.find();

    // Fetch the network configuration once during server startup
    const networkConfig = await getNetworkConfig();

    // Decorate Fastify instance with network configuration and tokens
    fastify.decorate('networkConfig', networkConfig);
    fastify.decorate('tokens', initialTokens);

    /**
     * Refreshes the tokens stored in the Fastify instance.
     * This function updates the tokens by fetching the latest data from the database.
     */
    fastify.decorate('refreshTokens', async () => {
      try {
        // Fetch updated tokens from the database
        const updatedTokens = await Token.find();
        // eslint-disable-next-line no-param-reassign
        fastify.tokens = updatedTokens; // Update the tokens in Fastify
        fastify.log.info('Tokens refreshed successfully');
      } catch (error) {
        fastify.log.error('Failed to refresh tokens:', error);
      }
    });

    /**
     * Adds hooks to refresh network configuration and tokens periodically.
     * The network configuration is refreshed every hour, and the tokens are refreshed every 5 minutes.
     */
    fastify.addHook('onReady', async () => {
      // Refresh the network configuration every hour
      setInterval(
        async () => {
          try {
            const updatedConfig = await getNetworkConfig();
            // eslint-disable-next-line no-param-reassign
            fastify.networkConfig = updatedConfig; // Update the network config in Fastify
            fastify.log.info('Network config refreshed successfully');
          } catch (error) {
            fastify.log.error('Failed to refresh network config:', error);
          }
        },
        60 * 60 * 1000 // 1 hour in milliseconds
      );

      // Refresh the tokens every 5 minutes
      setInterval(
        async () => {
          await fastify.refreshTokens();
        },
        5 * 60 * 1000 // 5 minutes in milliseconds
      );
    });

    /**
     * Adds a hook that triggers after a response is sent.
     * It checks if the request modified tokens (via POST, PUT, or DELETE to /tokens) and refreshes them if so.
     */
    fastify.addHook('onResponse', async (request) => {
      // Check if the request was related to token modifications
      if (request.url.startsWith('/tokens') && ['POST', 'PUT', 'DELETE'].includes(request.method)) {
        await fastify.refreshTokens(); // Refresh tokens if modified
      }
    });
  },
  {
    name: 'network-config-and-tokens' // Name of the plugin
  }
);

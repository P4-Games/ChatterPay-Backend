import { FastifyInstance } from 'fastify';

import { Logger } from '../../helpers/loggerHelper';
import Token, { IToken } from '../../models/tokenModel';
import { IBlockchain } from '../../models/blockchainModel';
import { mongoBlockchainService } from '../../services/mongo/mongoBlockchainService';
import {
  FASTIFY_REFRESH_TOKENS_INTERVAL_MS,
  FASTIFY_REFRESH_NETWORKS_INTERVAL_MS
} from '../constants';

// Extend the FastifyInstance interface to include our custom decorations
declare module 'fastify' {
  interface FastifyInstance {
    networkConfig: IBlockchain;
    tokens: IToken[];
    refreshTokens(): Promise<void>;
    refreshBlockchains(): Promise<void>;
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
  const networkConfig = await mongoBlockchainService.getNetworkConfig();

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
      Logger.info('refreshTokens', 'Tokens refreshed successfully');
    } catch (error) {
      Logger.error('refreshTokens', 'Failed to refresh tokens:', error);
    }
  });

  /**
   * Refreshes the network configuration stored in the Fastify instance.
   * This function updates the configuration by fetching the latest data from the service.
   */
  server.decorate('refreshBlockchains', async () => {
    try {
      const updatedConfig = await mongoBlockchainService.getNetworkConfig();
      // eslint-disable-next-line no-param-reassign
      server.networkConfig = updatedConfig;
      Logger.info('refreshBlockchains', 'Network config refreshed successfully');
    } catch (error) {
      Logger.error('refreshBlockchains', 'Failed to refresh network config:', error);
    }
  });

  /**
   * Adds hooks to refresh network configuration and tokens periodically.
   */
  server.addHook('onReady', async () => {
    // Refresh the network configuration every hour
    setInterval(async () => {
      await server.refreshBlockchains();
    }, FASTIFY_REFRESH_NETWORKS_INTERVAL_MS);

    // Refresh the tokens every 5 minutes
    setInterval(async () => {
      await server.refreshTokens();
    }, FASTIFY_REFRESH_TOKENS_INTERVAL_MS);
  });

  /**
   * Adds a hook that triggers after a response is sent.
   * It checks if the request modified tokens (via POST, PUT, or DELETE to /tokens) and refreshes them if so.
   */
  server.addHook('onResponse', async (request) => {
    // Check if the request was related to token modifications
    Logger.log('onResponse', request.url);
    if (request.url.startsWith('/tokens') && ['POST', 'PUT', 'DELETE'].includes(request.method)) {
      Logger.log('onResponse', 'Refresh tokens if modified');
      await server.refreshTokens();
    } else if (
      request.url.startsWith('/blockchains') &&
      ['POST', 'PUT', 'DELETE'].includes(request.method)
    ) {
      Logger.log('onResponse', 'Refresh blockchains if modified');
      await server.refreshBlockchains();
    }
  });
}

import axios, { isAxiosError, AxiosInstance } from 'axios';

import { Logger } from '../../helpers/loggerHelper';
import { toTopicAddress } from '../../helpers/alchemyHelper';
import {
  ALCHEMY_AUTH_TOKEN,
  ALCHEMY_VAR_TOKENS_ID,
  ALCHEMY_VAR_WALLETS_ID,
  ALCHEMY_VAR_WALLETS_TOPIC_ID
} from '../../config/constants';

interface AlchemyVariable {
  id: string;
  name: string;
  value: string[];
}

interface AlchemyVariableUpdateRequest {
  value: string[];
}

/**
 * Functional service for managing Alchemy webhook variables via Admin API
 */
const createAlchemyClient = (): AxiosInstance => {
  if (!ALCHEMY_AUTH_TOKEN) {
    throw new Error('ALCHEMY_AUTH_TOKEN is required');
  }

  return axios.create({
    baseURL: `https://dashboard.alchemy.com/api/webhooks/variables`,
    headers: {
      Authorization: `Bearer ${ALCHEMY_AUTH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });
};

export const alchemyAdminService = {
  client: createAlchemyClient(),
  walletsVarId: ALCHEMY_VAR_WALLETS_ID || '',
  walletsTopicVarId: ALCHEMY_VAR_WALLETS_TOPIC_ID || '',
  tokensVarId: ALCHEMY_VAR_TOKENS_ID || '',

  /**
   * Initialization log for debugging configuration
   */
  initLog(): void {
    Logger.info('AlchemyAdminService', 'Initialized Alchemy Admin client', {
      baseURL: 'https://dashboard.alchemy.com/api/webhooks/variables',
      walletsVarId: ALCHEMY_VAR_WALLETS_ID,
      walletsTopicVarId: ALCHEMY_VAR_WALLETS_TOPIC_ID,
      tokensVarId: ALCHEMY_VAR_TOKENS_ID
    });
  },

  /**
   * Batch addresses into chunks to avoid API limits
   */
  chunkArray<T>(array: T[], chunkSize = 1000): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  },

  /**
   * Gets current values of a variable
   */
  async getVariable(variableId: string): Promise<AlchemyVariable> {
    try {
      const response = await alchemyAdminService.client.get(`/${variableId}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        Logger.error('AlchemyAdminService', `Failed to get variable ${variableId}`, {
          status: error.response?.status,
          data: error.response?.data,
          message: error.message
        });
      } else {
        Logger.error(
          'AlchemyAdminService',
          `Unexpected error getting variable ${variableId}`,
          error
        );
      }
      throw error;
    }
  },

  /**
   * Updates an Alchemy variable (set, append, or remove)
   */
  async updateVariable(
    variableId: string,
    values: string[],
    operation: 'set' | 'append' | 'remove' = 'set'
  ): Promise<void> {
    if (!variableId) {
      Logger.info(
        'AlchemyAdminService',
        'Skipping variable update: variableId is null (free plan)'
      );
      return; // early exit — do not throw
    }

    try {
      let currentValues: string[] = [];

      if (operation !== 'set') {
        const currentVar = await alchemyAdminService.getVariable(variableId);
        currentValues = currentVar.value;
      }

      let newValues: string[];
      switch (operation) {
        case 'append':
          newValues = [...new Set([...currentValues, ...values])];
          break;
        case 'remove':
          newValues = currentValues.filter((v) => !values.includes(v));
          break;
        default:
          newValues = values;
      }

      const chunks = alchemyAdminService.chunkArray(newValues);

      await chunks.reduce(async (previousPromise, chunk, index) => {
        await previousPromise;

        const isFirstChunk = index === 0;
        const previousValues = isFirstChunk
          ? []
          : (await alchemyAdminService.getVariable(variableId)).value;
        const finalValues = isFirstChunk ? chunk : [...previousValues, ...chunk];

        const updateData: AlchemyVariableUpdateRequest = { value: finalValues };

        try {
          const res = await alchemyAdminService.client.put(`/${variableId}`, updateData);
          Logger.debug(
            'AlchemyAdminService',
            `PUT /${variableId} chunk ${index + 1}/${chunks.length}`,
            {
              status: res.status,
              statusText: res.statusText,
              chunkSize: chunk.length,
              totalSize: finalValues.length
            }
          );
        } catch (err) {
          if (axios.isAxiosError(err)) {
            Logger.error(
              'AlchemyAdminService',
              `Alchemy API PUT failed for variable ${variableId}`,
              {
                status: err.response?.status,
                data: err.response?.data,
                message: err.message
              }
            );
          } else {
            Logger.error('AlchemyAdminService', 'Unexpected PUT error', err);
          }
          throw err;
        }
      }, Promise.resolve());

      Logger.info(
        'AlchemyAdminService',
        `Successfully ${operation}ed ${values.length} items to variable ${variableId}`
      );
    } catch (error) {
      Logger.error('AlchemyAdminService', `Failed to ${operation} variable ${variableId}`, error);
      throw error;
    }
  },

  /**
   * Appends wallet addresses to the $wallets variable
   */
  async appendWallets(addresses: string[]): Promise<void> {
    if (addresses.length === 0) return;

    Logger.info('AlchemyAdminService', `Appending ${addresses.length} wallets to Alchemy variable`);

    const normalizedAddresses = addresses.map((addr) => addr.toLowerCase());
    await alchemyAdminService.updateVariable(
      alchemyAdminService.walletsVarId,
      normalizedAddresses,
      'append'
    );
  },

  /**
   * Appends wallet topic addresses to the $walletsTopic variable
   */
  async appendWalletTopics(addresses: string[]): Promise<void> {
    if (addresses.length === 0) return;

    Logger.info(
      'AlchemyAdminService',
      `Appending ${addresses.length} wallet topics to Alchemy variable`
    );

    const paddedTopics = addresses.map((addr) => toTopicAddress(addr));
    await alchemyAdminService.updateVariable(
      alchemyAdminService.walletsTopicVarId,
      paddedTopics,
      'append'
    );
  },

  /**
   * Removes wallet addresses from the $wallets variable
   */
  async removeWallets(addresses: string[]): Promise<void> {
    if (addresses.length === 0) return;

    Logger.info(
      'AlchemyAdminService',
      `Removing ${addresses.length} wallets from Alchemy variables`
    );

    const normalizedAddresses = addresses.map((addr) => addr.toLowerCase());
    await alchemyAdminService.updateVariable(
      alchemyAdminService.walletsVarId,
      normalizedAddresses,
      'remove'
    );

    const paddedTopics = addresses.map((addr) => toTopicAddress(addr));
    await alchemyAdminService.updateVariable(
      alchemyAdminService.walletsTopicVarId,
      paddedTopics,
      'remove'
    );

    Logger.debug('AlchemyAdminService', `Removed wallets: ${addresses.join(', ')}`);
  },

  /**
   * Sets the complete token whitelist
   */
  async setTokensWhitelist(tokens: string[]): Promise<void> {
    Logger.info('AlchemyAdminService', `Setting ${tokens.length} tokens in whitelist variable`);
    const normalizedTokens = tokens.map((token) => token.toLowerCase());
    await alchemyAdminService.updateVariable(
      alchemyAdminService.tokensVarId,
      normalizedTokens,
      'set'
    );
  },

  /**
   * Appends tokens to the whitelist
   */
  async appendTokensWhitelist(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;

    Logger.info('AlchemyAdminService', `Appending ${tokens.length} tokens to whitelist variable`);
    const normalizedTokens = tokens.map((token) => token.toLowerCase());
    await alchemyAdminService.updateVariable(
      alchemyAdminService.tokensVarId,
      normalizedTokens,
      'append'
    );
  },

  /**
   * Removes tokens from the whitelist
   */
  async removeTokensWhitelist(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;

    Logger.info('AlchemyAdminService', `Removing ${tokens.length} tokens from whitelist variable`);
    const normalizedTokens = tokens.map((token) => token.toLowerCase());
    await alchemyAdminService.updateVariable(
      alchemyAdminService.tokensVarId,
      normalizedTokens,
      'remove'
    );
  },

  /**
   * Batch operation to add a new wallet (address + topic).
   * Throws if any subtask fails to ensure wallet registration is consistent.
   */
  async addWallet(address: string): Promise<void> {
    Logger.debug('AlchemyAdminService', 'Adding wallet to Alchemy', { address });

    const results = await Promise.allSettled([
      alchemyAdminService.appendWallets([address]),
      alchemyAdminService.appendWalletTopics([address])
    ]);

    let allSuccessful = true;

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        allSuccessful = false;
        const { reason } = r;
        if (isAxiosError(reason)) {
          Logger.warn('AlchemyAdminService', `Subtask ${i} failed for wallet ${address}`, {
            status: reason.response?.status,
            data: reason.response?.data,
            message: reason.message,
            url: reason.config?.url
          });
        } else {
          Logger.warn('AlchemyAdminService', `Subtask ${i} failed for wallet ${address}`, {
            message: reason?.message || String(reason)
          });
        }
      }
    });

    Logger.debug('AlchemyAdminService', 'Finished wallet addition', { address });

    if (!allSuccessful) {
      throw new Error('One or more Alchemy subtasks failed during wallet addition');
    }
  },

  /**
   * Batch operation to remove a wallet (address + topic)
   */
  async removeWallet(address: string): Promise<void> {
    Logger.debug('AlchemyAdminService', 'Removing wallet from Alchemy', { address });
    await alchemyAdminService.removeWallets([address]);
    Logger.debug('AlchemyAdminService', 'Finished wallet removal', { address });
  },

  /**
   * Health check - verifies connection to Alchemy Admin API
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (alchemyAdminService.walletsVarId) {
        await alchemyAdminService.getVariable(alchemyAdminService.walletsVarId);
      }
      return true;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        Logger.error('AlchemyAdminService', 'Health check failed', {
          status: error.response?.status,
          data: error.response?.data
        });
      } else {
        Logger.error('AlchemyAdminService', 'Unexpected error during health check', error);
      }
      return false;
    }
  }
};

// Log initialization info once when imported
alchemyAdminService.initLog();

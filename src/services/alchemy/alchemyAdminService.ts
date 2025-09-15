import axios, { AxiosInstance } from 'axios';
import { Logger } from '../../helpers/loggerHelper';
import { 
  ALCHEMY_AUTH_TOKEN, 
  ALCHEMY_NETWORK,
  ALCHEMY_VAR_WALLETS_ID,
  ALCHEMY_VAR_WALLETS_TOPIC_ID,
  ALCHEMY_VAR_TOKENS_ID
} from '../../config/constants';
import { toTopicAddress } from '../../helpers/alchemyHelper';

interface AlchemyVariable {
  id: string;
  name: string;
  value: string[];
}

interface AlchemyVariableUpdateRequest {
  value: string[];
}

/**
 * Service for managing Alchemy webhook variables via Admin API
 */
export class AlchemyAdminService {
  private readonly client: AxiosInstance;
  private readonly walletsVarId: string;
  private readonly walletsTopicVarId: string;
  private readonly tokensVarId: string;

  constructor() {
    if (!ALCHEMY_AUTH_TOKEN) {
      throw new Error('ALCHEMY_AUTH_TOKEN is required');
    }

    this.walletsVarId = ALCHEMY_VAR_WALLETS_ID || '';
    this.walletsTopicVarId = ALCHEMY_VAR_WALLETS_TOPIC_ID || '';
    this.tokensVarId = ALCHEMY_VAR_TOKENS_ID || '';

    this.client = axios.create({
      baseURL: `https://dashboard.alchemy.com/api/webhooks/${ALCHEMY_NETWORK}/variables`,
      headers: {
        'Authorization': `Bearer ${ALCHEMY_AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
  }

  /**
   * Batch addresses into chunks to avoid API limits
   */
  private chunkArray<T>(array: T[], chunkSize: number = 1000): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Updates an Alchemy variable with retry logic
   */
  private async updateVariable(
    variableId: string, 
    values: string[], 
    operation: 'set' | 'append' | 'remove' = 'set'
  ): Promise<void> {
    if (!variableId) {
      throw new Error('Variable ID is required');
    }

    try {
      let currentValues: string[] = [];
      
      if (operation !== 'set') {
        // Get current values for append/remove operations
        const currentVar = await this.getVariable(variableId);
        currentValues = currentVar.value;
      }

      let newValues: string[];
      switch (operation) {
        case 'append':
          newValues = [...new Set([...currentValues, ...values])]; // Remove duplicates
          break;
        case 'remove':
          newValues = currentValues.filter(v => !values.includes(v));
          break;
        case 'set':
        default:
          newValues = values;
          break;
      }

      // Process in chunks if needed
      const chunks = this.chunkArray(newValues);
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const isFirstChunk = i === 0;
        const finalValues = isFirstChunk ? chunk : [...(await this.getVariable(variableId)).value, ...chunk];

        const updateData: AlchemyVariableUpdateRequest = {
          value: finalValues
        };

        await this.client.put(`/${variableId}`, updateData);
        
        Logger.debug('AlchemyAdminService', `Updated variable ${variableId} chunk ${i + 1}/${chunks.length}`, {
          chunkSize: chunk.length,
          totalSize: finalValues.length
        });
      }

      Logger.info('AlchemyAdminService', `Successfully ${operation}ed ${values.length} items to variable ${variableId}`);
    } catch (error) {
      Logger.error('AlchemyAdminService', `Failed to ${operation} variable ${variableId}`, error);
      throw error;
    }
  }

  /**
   * Gets current values of a variable
   */
  private async getVariable(variableId: string): Promise<AlchemyVariable> {
    try {
      const response = await this.client.get(`/${variableId}`);
      return response.data;
    } catch (error) {
      Logger.error('AlchemyAdminService', `Failed to get variable ${variableId}`, error);
      throw error;
    }
  }

  /**
   * Appends wallet addresses to the $wallets variable
   * @param addresses - Array of wallet addresses to append
   */
  public async appendWallets(addresses: string[]): Promise<void> {
    if (addresses.length === 0) return;
    
    Logger.info('AlchemyAdminService', `Appending ${addresses.length} wallets to Alchemy variables`);
    
    // Normalize addresses (lowercase, with 0x prefix)
    const normalizedAddresses = addresses.map(addr => addr.toLowerCase());
    
    await this.updateVariable(this.walletsVarId, normalizedAddresses, 'append');
  }

  /**
   * Appends wallet topic addresses to the $walletsTopic variable
   * @param addresses - Array of wallet addresses to convert to topics and append
   */
  public async appendWalletTopics(addresses: string[]): Promise<void> {
    if (addresses.length === 0) return;

    Logger.info('AlchemyAdminService', `Appending ${addresses.length} wallet topics to Alchemy variables`);
    
    // Convert addresses to padded topics
    const paddedTopics = addresses.map(addr => toTopicAddress(addr));
    
    await this.updateVariable(this.walletsTopicVarId, paddedTopics, 'append');
  }

  /**
   * Removes wallet addresses from the $wallets variable
   * @param addresses - Array of wallet addresses to remove
   */
  public async removeWallets(addresses: string[]): Promise<void> {
    if (addresses.length === 0) return;
    
    Logger.info('AlchemyAdminService', `Removing ${addresses.length} wallets from Alchemy variables`);
    
    const normalizedAddresses = addresses.map(addr => addr.toLowerCase());
    await this.updateVariable(this.walletsVarId, normalizedAddresses, 'remove');
    
    // Also remove from topics
    const paddedTopics = addresses.map(addr => toTopicAddress(addr));
    await this.updateVariable(this.walletsTopicVarId, paddedTopics, 'remove');
  }

  /**
   * Sets the complete token whitelist (replaces all existing values)
   * @param tokens - Array of token addresses
   */
  public async setTokensWhitelist(tokens: string[]): Promise<void> {
    Logger.info('AlchemyAdminService', `Setting ${tokens.length} tokens in whitelist variable`);
    
    const normalizedTokens = tokens.map(token => token.toLowerCase());
    await this.updateVariable(this.tokensVarId, normalizedTokens, 'set');
  }

  /**
   * Appends tokens to the whitelist
   * @param tokens - Array of token addresses to append
   */
  public async appendTokensWhitelist(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    
    Logger.info('AlchemyAdminService', `Appending ${tokens.length} tokens to whitelist variable`);
    
    const normalizedTokens = tokens.map(token => token.toLowerCase());
    await this.updateVariable(this.tokensVarId, normalizedTokens, 'append');
  }

  /**
   * Removes tokens from the whitelist
   * @param tokens - Array of token addresses to remove
   */
  public async removeTokensWhitelist(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    
    Logger.info('AlchemyAdminService', `Removing ${tokens.length} tokens from whitelist variable`);
    
    const normalizedTokens = tokens.map(token => token.toLowerCase());
    await this.updateVariable(this.tokensVarId, normalizedTokens, 'remove');
  }

  /**
   * Batch operation to add a new wallet (both address and topic)
   * @param address - The wallet address to add
   */
  public async addWallet(address: string): Promise<void> {
    await Promise.all([
      this.appendWallets([address]),
      this.appendWalletTopics([address])
    ]);
  }

  /**
   * Batch operation to remove a wallet (both address and topic)
   * @param address - The wallet address to remove
   */
  public async removeWallet(address: string): Promise<void> {
    await this.removeWallets([address]);
  }

  /**
   * Health check - verifies connection to Alchemy Admin API
   */
  public async healthCheck(): Promise<boolean> {
    try {
      if (this.walletsVarId) {
        await this.getVariable(this.walletsVarId);
      }
      return true;
    } catch (error) {
      Logger.error('AlchemyAdminService', 'Health check failed', error);
      return false;
    }
  }
}

// Export singleton instance
export const alchemyAdminService = new AlchemyAdminService();

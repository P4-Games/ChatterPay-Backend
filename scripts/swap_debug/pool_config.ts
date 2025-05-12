/**
 * @file pool_config.ts
 * @description Service for managing configuration values and environment variables
 * for the Uniswap pool adjustment script. Centralizes all configuration logic.
 */

import { Logger } from "../../src/helpers/loggerHelper";


/**
 * Pool configuration interface defining all required parameters for Uniswap operations
 */
export interface PoolConfig {
  readonly rpc: string;
  readonly privateKey: string;
  readonly usdtAddress: string;
  readonly wethAddress: string;
  readonly poolFee: number;
  readonly swapRouterAddress: string;
  readonly factoryAddress: string;
  readonly gasLimit: number;
}

/**
 * Environment-specific configuration service that manages all configuration values
 * and environment variables for the application
 */
export class ConfigService {
  /**
   * Required environment variables for the application to function properly
   */
  private static readonly REQUIRED_ENV_VARS = ['SIGNING_KEY'] as const;

  /**
   * Default configuration values used when environment-specific values are not provided
   */
  private static readonly DEFAULT_CONFIG = {
    usdtAddress: '0xe6B817E31421929403040c3e42A6a5C5D2958b4A',
    wethAddress: '0xe9c723d01393a437bac13ce8f925a5bc8e1c335c',
    poolFee: 3000, // 0.3%
    swapRouterAddress: '0x101F443B4d1b059569D643917553c771E1b9663E',
    factoryAddress: '0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e',
    gasLimit: 3000000
  } as const;

  /**
   * Validates the presence of all required environment variables
   * @throws Error if any required variable is missing
   */
  private static validateRequiredEnvVars(): void {
    this.REQUIRED_ENV_VARS.forEach(envVar => {
      if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
      }
    });
  }

  /**
   * Builds the RPC URL based on the provider and API key
   * @returns Complete RPC URL
   */
  private static buildRpcUrl(): string {
    const rpcBaseUrl = process.env.RPC_BASE_URL || 'https://arb-sepolia.g.alchemy.com/v2/';
    const apiKey = process.env.ALCHEMY_API_KEY || '';
    
    // If an absolute URL is provided, use it directly
    if (rpcBaseUrl.startsWith('http')) {
      return apiKey ? `${rpcBaseUrl}${apiKey}` : rpcBaseUrl;
    }
    
    // Otherwise, ensure the URL format is correct by appending trailing slash if needed
    const baseUrlWithTrailingSlash = rpcBaseUrl.endsWith('/') 
      ? rpcBaseUrl 
      : `${rpcBaseUrl}/`;
      
    return `${baseUrlWithTrailingSlash}${apiKey}`;
  }

  /**
   * Retrieves the complete pool configuration, combining environment variables
   * with default values and validating required fields
   * @returns Complete pool configuration object
   */
  public static getPoolConfig(): PoolConfig {
    try {
      this.validateRequiredEnvVars();

      return {
        rpc: this.buildRpcUrl(),
        privateKey: process.env.SIGNING_KEY!,
        usdtAddress: process.env.USDT_ADDRESS ?? this.DEFAULT_CONFIG.usdtAddress,
        wethAddress: process.env.WETH_ADDRESS ?? this.DEFAULT_CONFIG.wethAddress,
        poolFee: Number(process.env.POOL_FEE) || this.DEFAULT_CONFIG.poolFee,
        swapRouterAddress: process.env.SWAP_ROUTER_ADDRESS ?? this.DEFAULT_CONFIG.swapRouterAddress,
        factoryAddress: process.env.UNISWAP_FACTORY_ADDRESS ?? this.DEFAULT_CONFIG.factoryAddress,
        gasLimit: Number(process.env.GAS_LIMIT) || this.DEFAULT_CONFIG.gasLimit
      };
    } catch (error) {
      Logger.error(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Logs the current configuration (with sensitive data masked)
   * Useful for debugging purposes
   */
  public static logConfig(): void {
    const config = this.getPoolConfig();
    
    // Create a safe copy for logging by masking sensitive information
    const safeConfig = {
      ...config,
      privateKey: config.privateKey ? '***' : undefined,
      rpc: config.rpc.replace(/\/[^/]+$/, '/***') // Mask API key in URL
    };

    Logger.info(`Current configuration: ${JSON.stringify(safeConfig, null, 2)}`);
  }
}
import { ethers } from 'ethers';
import { Logger } from '../../helpers/loggerHelper';
import { getMulticall3ABI } from './abiService';

/**
 * Multicall3 contract address (deployed on most networks at the same address)
 * https://www.multicall3.com/
 */
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

/**
 * ERC20 minimal ABI for encoding/decoding
 */
const ERC20_MINIMAL_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

interface MulticallCall {
  target: string;
  allowFailure: boolean;
  callData: string;
}

interface MulticallResult {
  success: boolean;
  returnData: string;
}

interface TokenBalanceResult {
  tokenAddress: string;
  balance: string;
  decimals: number;
  success: boolean;
  error?: string;
}

/**
 * Gets balances for multiple tokens using a single Multicall3 call
 * 
 * @param provider - Ethers provider
 * @param walletAddress - Address to check balances for
 * @param tokenAddresses - Array of token contract addresses
 * @param cachedDecimals - Optional map of token addresses to their decimals (to avoid fetching)
 * @returns Array of token balance results
 */
export async function getTokenBalancesMulticall(
  provider: ethers.providers.Provider,
  walletAddress: string,
  tokenAddresses: string[],
  cachedDecimals: Map<string, number> = new Map()
): Promise<TokenBalanceResult[]> {
  try {
    // Load Multicall3 ABI from abiService (with cache)
    const multicall3ABI = await getMulticall3ABI();
    
    const multicallContract = new ethers.Contract(
      MULTICALL3_ADDRESS,
      multicall3ABI,
      provider
    );

    const erc20Interface = new ethers.utils.Interface(ERC20_MINIMAL_ABI);

    // Build calls array: balanceOf + decimals (only if not cached)
    const calls: MulticallCall[] = [];
    const callIndexMap: { type: 'balance' | 'decimals'; tokenAddress: string; index: number }[] =
      [];

    tokenAddresses.forEach((tokenAddress) => {
      // Always add balanceOf call
      calls.push({
        target: tokenAddress,
        allowFailure: true,
        callData: erc20Interface.encodeFunctionData('balanceOf', [walletAddress])
      });
      callIndexMap.push({ type: 'balance', tokenAddress, index: calls.length - 1 });

      // Only add decimals call if not cached
      if (!cachedDecimals.has(tokenAddress.toLowerCase())) {
        calls.push({
          target: tokenAddress,
          allowFailure: true,
          callData: erc20Interface.encodeFunctionData('decimals', [])
        });
        callIndexMap.push({ type: 'decimals', tokenAddress, index: calls.length - 1 });
      }
    });

    Logger.log(
      'getTokenBalancesMulticall',
      `Fetching ${tokenAddresses.length} tokens with ${calls.length} calls (vs ${tokenAddresses.length * 2} without multicall)`
    );

    // Execute multicall - use callStatic to force a read operation (not a transaction)
    const startTime = Date.now();
    const results: MulticallResult[] = await multicallContract.callStatic.aggregate3(calls);
    const elapsed = Date.now() - startTime;

    Logger.log('getTokenBalancesMulticall', `Multicall completed in ${elapsed}ms`);

    // Process results
    const balanceResults: TokenBalanceResult[] = [];
    const tempDecimals = new Map<string, number>(cachedDecimals);

    // First pass: decode decimals
    callIndexMap.forEach(({ type, tokenAddress, index }) => {
      const result = results[index];
      if (type === 'decimals' && result.success) {
        try {
          const decoded = erc20Interface.decodeFunctionResult('decimals', result.returnData);
          tempDecimals.set(tokenAddress.toLowerCase(), decoded[0]);
        } catch (error) {
          Logger.error(
            'getTokenBalancesMulticall',
            `Failed to decode decimals for ${tokenAddress}`,
            error
          );
        }
      }
    });

    // Second pass: decode balances and build results
    tokenAddresses.forEach((tokenAddress) => {
      const balanceCallIndex = callIndexMap.find(
        (c) => c.type === 'balance' && c.tokenAddress === tokenAddress
      )?.index;

      if (balanceCallIndex === undefined) {
        balanceResults.push({
          tokenAddress,
          balance: '0',
          decimals: 18, // fallback
          success: false,
          error: 'Balance call not found'
        });
        return;
      }

      const balanceResult = results[balanceCallIndex];

      if (!balanceResult.success) {
        balanceResults.push({
          tokenAddress,
          balance: '0',
          decimals: tempDecimals.get(tokenAddress.toLowerCase()) || 18,
          success: false,
          error: 'Balance call failed'
        });
        return;
      }

      try {
        const decoded = erc20Interface.decodeFunctionResult('balanceOf', balanceResult.returnData);
        const rawBalance = decoded[0] as ethers.BigNumber;
        const decimals = tempDecimals.get(tokenAddress.toLowerCase()) || 18;

        balanceResults.push({
          tokenAddress,
          balance: ethers.utils.formatUnits(rawBalance, decimals),
          decimals,
          success: true
        });
      } catch (error) {
        Logger.error(
          'getTokenBalancesMulticall',
          `Failed to decode balance for ${tokenAddress}`,
          error
        );
        balanceResults.push({
          tokenAddress,
          balance: '0',
          decimals: tempDecimals.get(tokenAddress.toLowerCase()) || 18,
          success: false,
          error: `Decode error: ${(error as Error).message}`
        });
      }
    });

    return balanceResults;
  } catch (error) {
    Logger.error('getTokenBalancesMulticall', 'Multicall failed:', error);
    throw error;
  }
}

/**
 * Cache for token decimals (they never change)
 */
const decimalsCache = new Map<string, number>();

/**
 * Gets the decimals cache for reuse across calls
 */
export function getDecimalsCache(): Map<string, number> {
  return decimalsCache;
}

/**
 * Preloads decimals for known tokens
 */
export function preloadTokenDecimals(tokens: Array<{ address: string; decimals?: number }>): void {
  tokens.forEach((token) => {
    if (token.decimals !== undefined) {
      decimalsCache.set(token.address.toLowerCase(), token.decimals);
    }
  });
}

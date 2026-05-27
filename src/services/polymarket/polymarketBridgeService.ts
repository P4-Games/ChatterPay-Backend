/**
 * Polymarket Bridge Service
 *
 * Bridges USDC from Scroll to Polygon for Polymarket trading.
 * Reuses the existing LiFi service for cross-chain swaps.
 *
 * @see https://docs.li.fi/api-reference
 */

import { ethers } from 'ethers';

import { POLYMARKET_CHAIN_ID } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import type { IUser } from '../../models/userModel';
import { getLifiQuote, pollLifiStatus, validateLifiQuote } from '../lifi/lifiService';
import type { LifiQuoteResponse, LifiStatusResponse } from '../lifi/lifiTypes';
import { mongoBlockchainService } from '../mongo/mongoBlockchainService';
import { getChatterpayABI, getERC20ABI } from '../web3/abiService';
import { setupContracts } from '../web3/contractSetupService';
import { PUSD_ADDRESS } from './polymarketConstants';

const LOG_PREFIX = 'polymarketBridgeService';

// Default scroll chain ID (will be user's current chain in practice)
const SCROLL_CHAIN_ID = 534352; // Scroll Mainnet

// ============================================================================
// Bridge Operations
// ============================================================================

/**
 * Get a bridge quote for transferring USDC from Scroll to Polygon.
 *
 * @param fromAddress - Sender address on Scroll
 * @param amount - Amount in smallest unit (wei/6 decimals for USDC)
 * @param logKey - Logging identifier
 * @returns LiFi quote response
 */
export async function getBridgeQuote(
  fromAddress: string,
  amount: string,
  logKey: string,
  fromTokenSymbol: string = 'USDC'
): Promise<LifiQuoteResponse> {
  const fnLog = `[${LOG_PREFIX}:getBridgeQuote]`;

  try {
    Logger.log(
      'info',
      fnLog,
      `${logKey} Getting bridge quote: ${amount} ${fromTokenSymbol} Scroll→Polygon`
    );

    const quote = await getLifiQuote(
      {
        fromChain: SCROLL_CHAIN_ID,
        toChain: POLYMARKET_CHAIN_ID,
        fromToken: fromTokenSymbol,
        toToken: PUSD_ADDRESS,
        fromAmount: amount,
        fromAddress,
        toAddress: fromAddress // Default to fromAddress if not specified
      },
      logKey
    );

    return quote;
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to get bridge quote: ${String(error)}`);
  }
}

/**
 * Validate a bridge quote before execution.
 */
export function validateBridgeQuote(
  quote: LifiQuoteResponse,
  expectedMinOutput?: string
): { valid: boolean; reason?: string } {
  return validateLifiQuote(quote, expectedMinOutput);
}

/**
 * Poll the status of a bridge transaction.
 *
 * @param txHash - Source chain transaction hash
 * @param logKey - Logging identifier
 * @returns Final status response
 */
export async function checkBridgeStatus(
  txHash: string,
  logKey: string
): Promise<LifiStatusResponse> {
  const fnLog = `[${LOG_PREFIX}:checkBridgeStatus]`;

  try {
    Logger.log('info', fnLog, `${logKey} Checking bridge status for tx: ${txHash}`);

    const status = await pollLifiStatus(
      {
        txHash,
        fromChain: SCROLL_CHAIN_ID,
        toChain: POLYMARKET_CHAIN_ID
      },
      logKey
    );

    return status;
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to check bridge status: ${String(error)}`);
  }
}

import { deploySafeWallet } from './polymarketRelayerService';

// ============================================================================
// Stablecoin Detection on Scroll
// ============================================================================

import Token from '../../models/tokenModel';

/** Stablecoin symbols to check, in priority order */
const BRIDGE_STABLECOIN_SYMBOLS = ['USDC', 'USDT'];

const ERC20_BALANCE_ABI = ['function balanceOf(address account) view returns (uint256)'];

// Cache stablecoin token records from DB (10-minute TTL).
// This data is near-static (token addresses don't change), so caching
// eliminates 2-3 redundant DB queries per bridge execution.
const stablecoinCacheByChain: Map<
  number,
  { tokens: Array<{ symbol: string; address: string; decimals: number }>; expiresAt: number }
> = new Map();
const STABLECOIN_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getStablecoinTokens(
  chainId: number
): Promise<Array<{ symbol: string; address: string; decimals: number }>> {
  const cached = stablecoinCacheByChain.get(chainId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.tokens;
  }

  const dbTokens = await Token.find({
    chain_id: chainId,
    symbol: { $in: BRIDGE_STABLECOIN_SYMBOLS }
  }).lean();

  const tokens = dbTokens.map((t) => ({
    symbol: t.symbol,
    address: t.address,
    decimals: t.decimals
  }));

  // Sort by priority order (USDC first, then USDT)
  const sorted = BRIDGE_STABLECOIN_SYMBOLS.map((sym) =>
    tokens.find((t) => t.symbol === sym)
  ).filter((t): t is { symbol: string; address: string; decimals: number } => !!t);

  stablecoinCacheByChain.set(chainId, {
    tokens: sorted,
    expiresAt: Date.now() + STABLECOIN_CACHE_TTL_MS
  });
  return sorted;
}

/**
 * Find the first stablecoin in the proxy wallet with sufficient balance.
 *
 * Looks up token addresses from the DB (tokens collection) for the Scroll chain,
 * then checks on-chain balances. Returns the first token with enough balance.
 *
 * @param proxyAddress - The user's proxy wallet address on Scroll
 * @param requiredAmount - Minimum amount needed (in smallest units, 6 decimals)
 * @param provider - Ethereum provider for Scroll
 * @param chainId - Scroll chain ID
 * @param logKey - Logging identifier
 */
async function findAvailableStablecoin(
  proxyAddress: string,
  requiredAmount: string,
  provider: ethers.providers.Provider,
  chainId: number,
  logKey: string
): Promise<{
  symbol: string;
  address: string;
  decimals: number;
  balance: ethers.BigNumber;
} | null> {
  const fnLog = `[${LOG_PREFIX}:findAvailableStablecoin]`;
  const requiredBN = ethers.BigNumber.from(requiredAmount);

  const sortedTokens = await getStablecoinTokens(chainId);

  if (sortedTokens.length === 0) {
    Logger.log('warn', fnLog, `${logKey} No stablecoins found in DB for chain ${chainId}`);
    return null;
  }

  for (const token of sortedTokens) {
    try {
      const contract = new ethers.Contract(token.address, ERC20_BALANCE_ABI, provider);
      const balance: ethers.BigNumber = await contract.balanceOf(proxyAddress);

      const balanceHuman = ethers.utils.formatUnits(balance, token.decimals);
      Logger.log(
        'info',
        fnLog,
        `${logKey} ${token.symbol} (${token.address}) balance: ${balanceHuman}`
      );

      if (balance.gte(requiredBN)) {
        Logger.log('info', fnLog, `${logKey} Using ${token.symbol} (${balanceHuman}) for bridge`);
        return { symbol: token.symbol, address: token.address, decimals: token.decimals, balance };
      }
    } catch (error) {
      Logger.log('warn', fnLog, `${logKey} Failed to check ${token.symbol}: ${String(error)}`);
    }
  }

  return null;
}

/**
 * Determine which stablecoin the user predominantly holds on Scroll.
 *
 * Checks on-chain balances of USDC and USDT on Scroll and returns the
 * symbol of the one with the highest balance. Defaults to 'USDC' if
 * no stablecoin balance is found.
 */
export async function getPreferredScrollStablecoin(
  scrollProxyAddress: string,
  logKey: string
): Promise<string> {
  const fnLog = `[${LOG_PREFIX}:getPreferredScrollStablecoin]`;

  try {
    const networkConfig = await mongoBlockchainService.getNetworkConfig();
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);

    const tokens = await getStablecoinTokens(networkConfig.chainId);
    if (tokens.length === 0) return 'USDC';

    let bestSymbol = 'USDC';
    let bestBalance = ethers.BigNumber.from(0);

    for (const token of tokens) {
      try {
        const contract = new ethers.Contract(token.address, ERC20_BALANCE_ABI, provider);
        const balance: ethers.BigNumber = await contract.balanceOf(scrollProxyAddress);

        Logger.log(
          'info',
          fnLog,
          `${logKey} ${token.symbol}: ${ethers.utils.formatUnits(balance, token.decimals)}`
        );

        if (balance.gt(bestBalance)) {
          bestBalance = balance;
          bestSymbol = token.symbol;
        }
      } catch {
        // Skip tokens we can't query
      }
    }

    Logger.log('info', fnLog, `${logKey} Preferred stablecoin: ${bestSymbol}`);
    return bestSymbol;
  } catch (error) {
    Logger.log(
      'warn',
      fnLog,
      `${logKey} Failed to determine preferred stablecoin: ${String(error)}`
    );
    return 'USDC';
  }
}

/**
 * Get a summary of all stablecoin balances for error messages.
 */
async function getStablecoinBalanceSummary(
  proxyAddress: string,
  provider: ethers.providers.Provider,
  chainId: number
): Promise<string[]> {
  const tokens = await getStablecoinTokens(chainId);

  const results: string[] = [];
  for (const token of tokens) {
    try {
      const contract = new ethers.Contract(token.address, ERC20_BALANCE_ABI, provider);
      const bal = await contract.balanceOf(proxyAddress);
      results.push(`${token.symbol}: ${ethers.utils.formatUnits(bal, token.decimals)}`);
    } catch {
      results.push(`${token.symbol}: error`);
    }
  }
  return results;
}

// ============================================================================
// Bridge Execution (server-side)
// ============================================================================

export interface ExecuteBridgeResult {
  success: boolean;
  txHash: string;
  approveTransactionHash?: string;
  /** The token actually used on Scroll (e.g. 'USDC' or 'USDT') */
  fromToken?: string;
}

/**
 * Execute a bridge transaction server-side (approve + send + poll).
 *
 * Automatically detects which stablecoin the user has on Scroll (USDC or USDT)
 * and bridges it to USDC.e on Polygon via LiFi cross-chain swap.
 *
 * Flow:
 * 1. Setup contracts to get proxy wallet and signer
 * 2. Check stablecoin balances (USDC, USDT) on Scroll
 * 3. Get a LiFi quote for the available stablecoin → USDC.e on Polygon
 * 4. Approve the LiFi router if needed
 * 5. Forward the bridge tx through the proxy wallet via execute()
 * 6. Poll LiFi for bridge completion
 *
 * @param user - User with wallet info
 * @param amount - Amount in smallest unit (6 decimals)
 * @param logKey - Logging identifier
 * @returns Bridge execution result with tx hash
 */
export async function executeBridge(
  user: IUser,
  privateKey: string,
  amount: string,
  logKey: string
): Promise<ExecuteBridgeResult> {
  const fnLog = `[${LOG_PREFIX}:executeBridge]`;

  try {
    Logger.log(
      'info',
      fnLog,
      `${logKey} Executing bridge: ${amount} (smallest units) Scroll→Polygon`
    );

    // 1. Setup contracts + deploy Safe in parallel (independent operations)
    const [contracts, { proxyAddress: polygonSafeAddress }] = await Promise.all([
      mongoBlockchainService
        .getNetworkConfig()
        .then((blockchain) => setupContracts(blockchain, user)),
      deploySafeWallet(privateKey, logKey)
    ]);
    const proxyAddress = contracts.proxy.proxyAddress;
    const backendSigner = contracts.backPrincipal;
    const provider = contracts.provider;

    // 2. Find which stablecoin the user has with enough balance
    const sourceToken = await findAvailableStablecoin(
      proxyAddress,
      amount,
      provider,
      SCROLL_CHAIN_ID,
      logKey
    );

    if (!sourceToken) {
      // Collect all balances for the error message
      const balanceSummary = await getStablecoinBalanceSummary(
        proxyAddress,
        provider,
        SCROLL_CHAIN_ID
      );

      const requiredHuman = ethers.utils.formatUnits(amount, 6);
      throw new Error(
        `Insufficient stablecoin balance on Scroll. ` +
          `Need ${requiredHuman} USDC/USDT. ` +
          `Available: ${balanceSummary.join(', ')}`
      );
    }

    Logger.log(
      'info',
      fnLog,
      `${logKey} Bridging ${sourceToken.symbol} from Scroll → USDC.e on Polygon`
    );

    // 3. Get bridge/swap quote using the available stablecoin
    const quote = await getLifiQuote(
      {
        fromChain: SCROLL_CHAIN_ID,
        toChain: POLYMARKET_CHAIN_ID,
        fromToken: sourceToken.address,
        toToken: PUSD_ADDRESS,
        fromAmount: amount,
        fromAddress: proxyAddress,
        toAddress: polygonSafeAddress,
        slippage: 0.03 // Increased slippage for reliability
      },
      logKey
    );

    const validation = validateLifiQuote(quote);
    if (!validation.valid) {
      throw new Error(`Invalid bridge quote: ${validation.reason}`);
    }

    Logger.log('info', fnLog, `${logKey} Bridge quote received: tool=${quote.tool}`);

    // 4. Setup ChatterPay contract on proxy for execute() calls
    const chatterpayABI = await getChatterpayABI();
    const erc20ABI = await getERC20ABI();
    const chatterPayContract = new ethers.Contract(proxyAddress, chatterpayABI, backendSigner);

    // NOTE: Use getGasPrice() instead of getFeeData().gasPrice because ethers.js v5
    // hardcodes maxPriorityFeePerGas=1.5 gwei in getFeeData(), which massively overpays on L2s.
    const gasPrice = await provider.getGasPrice();

    // 5. Approve LiFi router to spend the source token if needed
    let approveTransactionHash = '';
    const approvalAddress = quote.estimate.approvalAddress;

    if (approvalAddress && approvalAddress !== ethers.constants.AddressZero) {
      const fromTokenAddress = quote.action.fromToken.address;
      const tokenContract = new ethers.Contract(fromTokenAddress, erc20ABI, provider);
      const amountBN = ethers.BigNumber.from(amount);
      const currentAllowance = await tokenContract.allowance(proxyAddress, approvalAddress);
      Logger.log(
        'info',
        fnLog,
        `${logKey} Current ${sourceToken.symbol} allowance for Li.Fi: ${ethers.utils.formatUnits(currentAllowance, sourceToken.decimals)}`
      );

      if (currentAllowance.lt(amountBN)) {
        Logger.log('info', fnLog, `${logKey} Approving LiFi router for ${sourceToken.symbol}`);

        const approveCallData = tokenContract.interface.encodeFunctionData('approve', [
          approvalAddress,
          ethers.constants.MaxUint256
        ]);

        const approveTx = await chatterPayContract.execute(fromTokenAddress, 0, approveCallData, {
          gasLimit: 200000,
          gasPrice
        });

        const approveReceipt = await approveTx.wait();
        if (approveReceipt.status !== 1) {
          throw new Error('Bridge approval transaction failed');
        }

        approveTransactionHash = approveReceipt.transactionHash;
        Logger.log('info', fnLog, `${logKey} Approval tx: ${approveTransactionHash}`);
      } else {
        Logger.log('info', fnLog, `${logKey} Sufficient allowance for bridge, skipping approval`);
      }
    }

    // 6. Fund the proxy account with ETH if it needs to pay a native bridge fee
    // Li.Fi quotes may require native ETH (value) for protocol fees (e.g. Across).
    // The execute() function is non-payable (receives no ETH from caller),
    // but it forwards its internal balance to the destination.
    const requiredValue = ethers.BigNumber.from(quote.transactionRequest.value || 0);

    if (requiredValue.gt(0)) {
      const proxyBalance = await provider.getBalance(proxyAddress);
      Logger.log(
        'info',
        fnLog,
        `${logKey} Required bridge fee (ETH): ${ethers.utils.formatEther(requiredValue)}. Proxy balance: ${ethers.utils.formatEther(proxyBalance)}`
      );

      if (proxyBalance.lt(requiredValue)) {
        const missing = requiredValue.sub(proxyBalance);
        // Add a small buffer for safety
        const fundAmount = missing.add(ethers.utils.parseUnits('0.001', 'ether'));

        Logger.log(
          'info',
          fnLog,
          `${logKey} Funding proxy with ${ethers.utils.formatEther(fundAmount)} ETH from backend`
        );
        const fundTx = await backendSigner.sendTransaction({
          to: proxyAddress,
          value: fundAmount,
          gasLimit: 50000, // Increased from 21000 to handle contract receive logic
          gasPrice
        });
        await fundTx.wait();
        Logger.log('info', fnLog, `${logKey} Proxy funded successfully`);
      }
    }

    // 7. Execute the bridge transaction through the proxy wallet
    Logger.log(
      'info',
      fnLog,
      `${logKey} Sending bridge transaction to ${quote.transactionRequest.to}`
    );
    Logger.log(
      'debug',
      fnLog,
      `${logKey} Bridge Request: ${JSON.stringify(quote.transactionRequest)}`
    );

    // Use LiFi's recommended gasLimit + 15% buffer for proxy execute() overhead.
    // LiFi complex routes (e.g. relaydepository) need 2M+ gas; 1M is insufficient.
    const lifiGasLimit = quote.transactionRequest.gasLimit
      ? Math.ceil(Number(quote.transactionRequest.gasLimit) * 1.15)
      : 2_500_000;
    const bridgeGasLimit = Math.max(lifiGasLimit, 1_000_000);

    Logger.log(
      'info',
      fnLog,
      `${logKey} Bridge gasLimit: ${bridgeGasLimit} (LiFi recommends: ${quote.transactionRequest.gasLimit ?? 'N/A'})`
    );

    const bridgeTx = await chatterPayContract.execute(
      quote.transactionRequest.to,
      requiredValue,
      quote.transactionRequest.data,
      {
        gasLimit: bridgeGasLimit,
        gasPrice
      }
    );

    const bridgeReceipt = await bridgeTx.wait();
    if (bridgeReceipt.status !== 1) {
      throw new Error('Bridge transaction reverted');
    }

    const txHash = bridgeReceipt.transactionHash;
    Logger.log('info', fnLog, `${logKey} Bridge tx sent: ${txHash}`);

    // 8. Poll for bridge completion
    Logger.log('info', fnLog, `${logKey} Polling bridge status`);
    const status = await pollLifiStatus(
      {
        txHash,
        fromChain: SCROLL_CHAIN_ID,
        toChain: POLYMARKET_CHAIN_ID
      },
      logKey
    );

    if (status.status === 'FAILED') {
      throw new Error(`Bridge failed: ${status.substatusMessage || 'Unknown reason'}`);
    }

    Logger.log('info', fnLog, `${logKey} Bridge completed successfully`);

    return {
      success: true,
      txHash,
      approveTransactionHash: approveTransactionHash || undefined,
      fromToken: sourceToken.symbol
    };
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Bridge execution failed: ${String(error)}`);
    throw new Error(`Bridge execution failed: ${String(error)}`);
  }
}

// ============================================================================
// Withdraw to Scroll (Relayer Sponsored)
// ============================================================================

/**
 * Get a bridge quote and necessary transactions for withdrawing USDC.e from Polygon back to Scroll.
 *
 * @param polygonSafeAddress - Sender address on Polygon (the user's Safe)
 * @param scrollProxyAddress - Destination address on Scroll (the user's Proxy)
 * @param amount - Amount to withdraw in smallest unit (wei/6 decimals for USDC.e)
 * @param logKey - Logging identifier
 * @returns An object containing the quote, approval address, to, data, and value for the Relayer.
 */
export async function withdrawToScroll(
  polygonSafeAddress: string,
  scrollProxyAddress: string,
  amount: string,
  logKey: string,
  toTokenSymbol: string = 'USDC'
): Promise<{
  quote: LifiQuoteResponse;
  approvalAddress: string;
  to: string;
  data: string;
  value: string;
}> {
  const fnLog = `[${LOG_PREFIX}:withdrawToScroll]`;

  try {
    Logger.log(
      'info',
      fnLog,
      `${logKey} Getting withdraw quote: ${amount} USDC.e Polygon→Scroll (→${toTokenSymbol})`
    );

    const quote = await getLifiQuote(
      {
        fromChain: POLYMARKET_CHAIN_ID,
        toChain: SCROLL_CHAIN_ID,
        fromToken: PUSD_ADDRESS,
        toToken: toTokenSymbol,
        fromAmount: amount,
        fromAddress: polygonSafeAddress,
        toAddress: scrollProxyAddress
      },
      logKey
    );

    const validation = validateLifiQuote(quote);
    if (!validation.valid) {
      throw new Error(`Invalid withdraw quote: ${validation.reason}`);
    }

    const { approvalAddress } = quote.estimate;
    const { to, data, value } = quote.transactionRequest;

    return {
      quote,
      approvalAddress: approvalAddress || ethers.constants.AddressZero,
      to: to || ethers.constants.AddressZero,
      data: data || '0x',
      value: value?.toString() || '0'
    };
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed getting withdraw quote: ${String(error)}`);
    throw new Error(`Failed to get withdraw quote: ${String(error)}`);
  }
}

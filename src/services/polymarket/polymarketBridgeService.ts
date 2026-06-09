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
import {
  getLifiQuote,
  getLifiTokenPrice,
  pollLifiStatus,
  validateLifiQuote
} from '../lifi/lifiService';
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

import { deploySafeWallet, sweepSafeToDepositWallet } from './polymarketRelayerService';

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

/**
 * Return total stablecoin balance (USDC + USDT) on Scroll for a proxy wallet.
 * Used for early balance validation before starting an async purchase flow.
 *
 * @returns Human-readable total (e.g. 14.50 for $14.50)
 */
export async function getScrollStablecoinTotal(
  proxyAddress: string,
  logKey: string
): Promise<number> {
  const fnLog = `[${LOG_PREFIX}:getScrollStablecoinTotal]`;
  try {
    const networkConfig = await mongoBlockchainService.getNetworkConfig();
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
    const tokens = await getStablecoinTokens(networkConfig.chainId);

    let total = 0;
    for (const token of tokens) {
      try {
        const contract = new ethers.Contract(token.address, ERC20_BALANCE_ABI, provider);
        const bal: ethers.BigNumber = await contract.balanceOf(proxyAddress);
        total += Number(ethers.utils.formatUnits(bal, token.decimals));
      } catch {
        // count as 0
      }
    }

    Logger.log('info', fnLog, `${logKey} Total Scroll stablecoin: $${total.toFixed(2)}`);
    return total;
  } catch (error) {
    Logger.log('warn', fnLog, `${logKey} Balance check failed: ${String(error)}`);
    return 0;
  }
}

// Stablecoin detection (uppercase for O(1) lookup)
const STABLECOIN_SET = new Set(['USDC', 'USDT', 'DAI', 'USDC.E']);

interface SourceToken {
  symbol: string;
  address: string;
  decimals: number;
  fromAmount: string; // smallest units for fromToken
}

/**
 * Resolve which Scroll token to bridge FROM, and compute the `fromAmount` in its smallest units.
 *
 * - If `preferredSymbol` given: look up in Token DB, validate balance, get price if non-stablecoin.
 * - Otherwise: auto-detect first stablecoin with sufficient balance (USDC → USDT priority).
 *
 * @param proxyAddress - User's Scroll proxy wallet
 * @param amountUsd - Bridge amount in human-readable USD (e.g. "2.50")
 * @param provider - Scroll RPC provider
 * @param chainId - Scroll chain ID
 * @param preferredSymbol - Optional token symbol from request
 * @param logKey - Logging identifier
 */
async function resolveSourceToken(
  proxyAddress: string,
  amountUsd: string,
  provider: ethers.providers.Provider,
  chainId: number,
  preferredSymbol: string | undefined,
  logKey: string
): Promise<SourceToken> {
  const fnLog = `[${LOG_PREFIX}:resolveSourceToken]`;
  const amountFloat = parseFloat(amountUsd);

  if (preferredSymbol) {
    const symbolUpper = preferredSymbol.toUpperCase();
    const dbToken = await Token.findOne({ chain_id: chainId, symbol: symbolUpper }).lean();
    if (!dbToken) {
      throw new Error(`Token ${symbolUpper} not found in DB for chain ${chainId}`);
    }

    let fromAmount: string;
    if (STABLECOIN_SET.has(symbolUpper)) {
      fromAmount = Math.floor(amountFloat * 10 ** dbToken.decimals).toString();
    } else {
      // Non-stablecoin: convert USD → token units via LiFi price
      const price = await getLifiTokenPrice(chainId, dbToken.address, logKey);
      if (!price || price <= 0) {
        throw new Error(`Cannot get USD price for ${preferredSymbol} — cannot convert amount`);
      }
      fromAmount = Math.floor((amountFloat / price) * 10 ** dbToken.decimals).toString();
      Logger.log(
        'info',
        fnLog,
        `${logKey} ${preferredSymbol} price $${price}, ${amountFloat} USD → ${fromAmount} smallest units`
      );
    }

    // Validate the user actually has enough of this token
    const contract = new ethers.Contract(dbToken.address, ERC20_BALANCE_ABI, provider);
    const balance: ethers.BigNumber = await contract.balanceOf(proxyAddress);
    if (balance.lt(ethers.BigNumber.from(fromAmount))) {
      const humanBalance = ethers.utils.formatUnits(balance, dbToken.decimals);
      throw new Error(
        `Insufficient ${preferredSymbol} balance: ${humanBalance} < $${amountFloat.toFixed(2)} USD required`
      );
    }

    return {
      symbol: dbToken.symbol,
      address: dbToken.address,
      decimals: dbToken.decimals,
      fromAmount
    };
  }

  // Auto-detect: try stablecoins in priority order
  const requiredSmallest = Math.floor(amountFloat * 1_000_000).toString();
  const stablecoin = await findAvailableStablecoin(
    proxyAddress,
    requiredSmallest,
    provider,
    chainId,
    logKey
  );

  if (stablecoin) {
    return {
      symbol: stablecoin.symbol,
      address: stablecoin.address,
      decimals: stablecoin.decimals,
      fromAmount: Math.floor(amountFloat * 10 ** stablecoin.decimals).toString()
    };
  }

  const summary = await getStablecoinBalanceSummary(proxyAddress, provider, chainId);
  throw new Error(
    `Insufficient stablecoin balance on Scroll. Need $${amountFloat.toFixed(2)} USDC/USDT. ` +
      `Available: ${summary.join(', ')}. Specify bridge_token to use a different token.`
  );
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
 * Resolves the source token on Scroll (auto-detects stablecoin if omitted),
 * converts the USD amount to token units, then bridges via LiFi to pUSD on Polygon.
 *
 * @param user - User with wallet info
 * @param privateKey - User's EOA private key
 * @param amountUsd - Amount in human-readable USD (e.g. "2.50")
 * @param logKey - Logging identifier
 * @param fromTokenSymbol - Optional Scroll token symbol (e.g. "WETH"). Auto-detects stablecoin if omitted.
 * @returns Bridge execution result with tx hash
 */
export async function executeBridge(
  user: IUser,
  privateKey: string,
  amountUsd: string,
  logKey: string,
  fromTokenSymbol?: string
): Promise<ExecuteBridgeResult> {
  const fnLog = `[${LOG_PREFIX}:executeBridge]`;

  try {
    Logger.log('info', fnLog, `${logKey} Executing bridge: $${amountUsd} USD Scroll→Polygon`);

    const walletType = user.polymarket_account?.wallet_type ?? 'safe';

    // For deposit wallet users: don't deploy/use Safe — send funds directly to deposit wallet.
    // For safe users: deploy Safe (idempotent) and use it as the bridge destination.
    let polygonDestinationAddress: string;
    let contracts: Awaited<ReturnType<typeof setupContracts>>;

    if (walletType === 'deposit') {
      if (!user.polymarket_account?.polygon_address) {
        throw new Error('Deposit wallet address not found in polymarket_account');
      }
      polygonDestinationAddress = user.polymarket_account.polygon_address;
      contracts = await mongoBlockchainService
        .getNetworkConfig()
        .then((blockchain) => setupContracts(blockchain, user));

      // Sweep any existing funds from Safe to deposit wallet (best-effort)
      try {
        const swept = await sweepSafeToDepositWallet(privateKey, polygonDestinationAddress, logKey);
        if (swept > 0) {
          Logger.log(
            'info',
            fnLog,
            `${logKey} Swept $${swept.toFixed(2)} from old Safe to deposit wallet before bridge`
          );
        }
      } catch (sweepError) {
        Logger.log(
          'warn',
          fnLog,
          `${logKey} Pre-bridge Safe sweep failed (non-fatal): ${String(sweepError)}`
        );
      }
    } else {
      const [setupContractsResult, { proxyAddress: safeAddress }] = await Promise.all([
        mongoBlockchainService
          .getNetworkConfig()
          .then((blockchain) => setupContracts(blockchain, user)),
        deploySafeWallet(privateKey, logKey)
      ]);
      contracts = setupContractsResult;
      polygonDestinationAddress = safeAddress;
    }

    const proxyAddress = contracts.proxy.proxyAddress;
    const backendSigner = contracts.backPrincipal;
    const provider = contracts.provider;

    // 2. Resolve source token (preferred symbol → any token; none → stablecoin auto-detect).
    // If preferred token's LiFi route fails, fall back to stablecoin auto-detect.
    const buildQuote = async (symbol?: string) => {
      const resolvedToken = await resolveSourceToken(
        proxyAddress,
        amountUsd,
        provider,
        SCROLL_CHAIN_ID,
        symbol,
        logKey
      );
      Logger.log(
        'info',
        fnLog,
        `${logKey} Bridging ${resolvedToken.symbol} (${resolvedToken.fromAmount}) → pUSD`
      );
      const lifiQuote = await getLifiQuote(
        {
          fromChain: SCROLL_CHAIN_ID,
          toChain: POLYMARKET_CHAIN_ID,
          fromToken: resolvedToken.address,
          toToken: PUSD_ADDRESS,
          fromAmount: resolvedToken.fromAmount,
          fromAddress: proxyAddress,
          toAddress: polygonDestinationAddress,
          slippage: 0.03
        },
        logKey
      );
      const validation = validateLifiQuote(lifiQuote);
      if (!validation.valid) throw new Error(`Invalid bridge quote: ${validation.reason}`);
      return { resolvedToken, lifiQuote };
    };

    let sourceToken: SourceToken;
    let quote: LifiQuoteResponse;

    try {
      ({ resolvedToken: sourceToken, lifiQuote: quote } = await buildQuote(fromTokenSymbol));
    } catch (error) {
      if (fromTokenSymbol) {
        Logger.log(
          'warn',
          fnLog,
          `${logKey} ${fromTokenSymbol} route failed (${String(error)}), falling back to stablecoin`
        );
        ({ resolvedToken: sourceToken, lifiQuote: quote } = await buildQuote());
      } else {
        throw error;
      }
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
      const amountBN = ethers.BigNumber.from(sourceToken.fromAmount);
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

    // Deny Squid (Axelar-based): requires native MATIC as msg.value for cross-chain gas.
    // The Polygon Safe has no MATIC, so any bridge that sets value > 0 would revert on-chain.
    const quote = await getLifiQuote(
      {
        fromChain: POLYMARKET_CHAIN_ID,
        toChain: SCROLL_CHAIN_ID,
        fromToken: PUSD_ADDRESS,
        toToken: toTokenSymbol,
        fromAmount: amount,
        fromAddress: polygonSafeAddress,
        toAddress: scrollProxyAddress,
        denyBridges: ['squid']
      },
      logKey
    );

    const validation = validateLifiQuote(quote);
    if (!validation.valid) {
      throw new Error(`Invalid withdraw quote: ${validation.reason}`);
    }

    const { approvalAddress } = quote.estimate;
    const { to, data, value } = quote.transactionRequest;

    // Guard: if the route still requires native MATIC, fail fast with a clear error
    // rather than submitting a tx that will revert on-chain (Safe has no MATIC).
    const nativeValue = BigInt(value ?? '0');
    if (nativeValue > 0n) {
      throw new Error(
        `Withdraw route '${quote.tool}' requires native MATIC (value=${value}). ` +
          `The Polygon Safe has no MATIC. Choose a bridge that deducts fees from the token amount.`
      );
    }

    Logger.log(
      'info',
      fnLog,
      `${logKey} Withdraw quote ok: tool=${quote.tool}, value=0, toAmount=${quote.estimate.toAmount}`
    );

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

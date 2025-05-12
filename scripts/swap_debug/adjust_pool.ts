/**
 * @file direct_adjust_pool.ts
 * @description Adjusts a Uniswap pool price to target in a single, massive swap.
 * This approach leverages unlimited token minting to achieve the target price
 * in one transaction rather than multiple iterations.
 */

import { ethers } from 'ethers';

import { executeSwap } from './swap_tokens';
import { Logger } from '../../src/helpers/loggerHelper';
import { ABI } from '../../src/services/web3/abiService';
import { PoolConfig, ConfigService } from './pool_config';
import { coingeckoService } from '../../src/services/coingecko/coingeckoService';

/**
 * Pool price and balance information, using readonly for immutability
 */
interface PoolPriceInfo {
  readonly usdtPerEth: number;      // Current price as USDT per ETH
  readonly ethPerUsdt: number;      // Inverted price
  readonly usdtBalance: number;     // USDT in pool
  readonly wethBalance: number;     // WETH in pool
  readonly usdtDecimals: number;    // Decimals for USDT token
  readonly wethDecimals: number;    // Decimals for WETH token
}

/**
 * ABIs for interacting with contracts
 */
const ERC20_ABI: ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function mint(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

const FACTORY_ABI: ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];

/**
 * Retrieves the pool address from the factory
 */
const getPoolAddress = async (
  tokenA: string,
  tokenB: string,
  config: PoolConfig,
  provider: ethers.providers.JsonRpcProvider
): Promise<string> => {
  try {
    const factory = new ethers.Contract(config.factoryAddress, FACTORY_ABI, provider);
    const poolAddress = await factory.getPool(tokenA, tokenB, config.poolFee);

    if (poolAddress === ethers.constants.AddressZero) {
      throw new Error(`Pool not found for tokens ${tokenA} and ${tokenB} with fee ${config.poolFee}`);
    }

    return poolAddress;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    Logger.error(`Error retrieving pool address: ${errorMsg}`);
    throw error;
  }
};

/**
 * Gets normalized pool information including token balances and prices
 */
const getPoolInfo = async (
  config: PoolConfig,
  provider: ethers.providers.JsonRpcProvider
): Promise<PoolPriceInfo> => {
  try {
    // Get the pool address
    const poolAddress = await getPoolAddress(
      config.usdtAddress,
      config.wethAddress,
      config,
      provider
    );

    // Create contract instances
    const usdtContract = new ethers.Contract(config.usdtAddress, ERC20_ABI, provider);
    const wethContract = new ethers.Contract(config.wethAddress, ERC20_ABI, provider);

    // Query all data in parallel for efficiency
    const [usdtBalance, usdtDecimals, wethBalance, wethDecimals] = await Promise.all([
      usdtContract.balanceOf(poolAddress),
      usdtContract.decimals(),
      wethContract.balanceOf(poolAddress),
      wethContract.decimals()
    ]);

    // Convert to human-readable values
    const usdtBalanceNum = parseFloat(ethers.utils.formatUnits(usdtBalance, usdtDecimals));
    const wethBalanceNum = parseFloat(ethers.utils.formatUnits(wethBalance, wethDecimals));

    // Calculate price ratios
    const usdtPerEth = usdtBalanceNum / wethBalanceNum;
    const ethPerUsdt = wethBalanceNum / usdtBalanceNum;

    return {
      usdtPerEth,
      ethPerUsdt,
      usdtBalance: usdtBalanceNum,
      wethBalance: wethBalanceNum,
      usdtDecimals,
      wethDecimals
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    Logger.error(`Error getting pool information: ${errorMsg}`);
    throw error;
  }
};

/**
 * Calculates the exact amounts needed to achieve the target price in one step
 */
const calculateDirectSwapToTarget = (
  poolInfo: PoolPriceInfo,
  targetPrice: number
): {
  tokenIn: 'USDT' | 'WETH';
  tokenInDecimals: number;
  amountIn: number;
  expectedNewPrice: number;
} => {
  const { usdtPerEth, usdtBalance, wethBalance, usdtDecimals, wethDecimals } = poolInfo;
  const currentPrice = usdtPerEth;

  Logger.info(`Current price: ${currentPrice.toFixed(8)} USDT/ETH`);
  Logger.info(`Target price: ${targetPrice.toFixed(8)} USDT/ETH`);

  // Determine if we need to increase or decrease the price
  const needsIncreaseUsdtPerEth = currentPrice < targetPrice;

  // Calculate the deviation factor for logging
  const deviationFactor = needsIncreaseUsdtPerEth
    ? targetPrice / currentPrice
    : currentPrice / targetPrice;

  Logger.info(`Price deviation factor: ${deviationFactor.toExponential(2)}x`);

  // Choose which token to add based on direction
  const tokenIn = needsIncreaseUsdtPerEth ? 'USDT' : 'WETH';
  const tokenInDecimals = needsIncreaseUsdtPerEth ? usdtDecimals : wethDecimals;

  // For extreme pool adjustments (>1000x), increase the invariant k
  // to enhance stability at target price
  let kMultiplier = 1;
  if (deviationFactor > 1000) {
    // Logarithmic scaling for k enhances stability for extreme adjustments
    kMultiplier = Math.min(1 + Math.log10(deviationFactor) * 0.2, 3);
    Logger.info(`Increasing liquidity by ${(kMultiplier - 1) * 100}% for better price stability`);
  }

  // Calculate invariant k = reserve0 * reserve1
  // Optionally amplify it for better stability after adjustment
  const k = usdtBalance * wethBalance * kMultiplier;

  // Calculate the ideal balanced reserves for the target price
  // Using the formulas:
  // - wethIdeal = sqrt(k / targetPrice)
  // - usdtIdeal = targetPrice * wethIdeal
  const wethIdeal = Math.sqrt(k / targetPrice);
  const usdtIdeal = targetPrice * wethIdeal;

  Logger.info('Current pool balances:');
  Logger.info(`- USDT: ${usdtBalance.toFixed(4)}`);
  Logger.info(`- WETH: ${wethBalance.toFixed(4)}`);

  Logger.info('Ideal balances for target price:');
  Logger.info(`- USDT: ${usdtIdeal.toFixed(4)}`);
  Logger.info(`- WETH: ${wethIdeal.toFixed(4)}`);

  // Calculate how much of the token to add to reach target
  let amountIn: number;
  let expectedNewPrice: number;

  if (needsIncreaseUsdtPerEth) {
    // Need to add USDT to the pool
    amountIn = usdtIdeal - usdtBalance;

    // Simulate the resulting price using the direct price impact calculation
    const newUsdtBalance = usdtBalance + amountIn;
    const newWethBalance = k / newUsdtBalance; // Using k = x * y formula
    expectedNewPrice = newUsdtBalance / newWethBalance;
  } else {
    // Need to add WETH to the pool
    amountIn = wethIdeal - wethBalance;

    // Simulate the resulting price
    const newWethBalance = wethBalance + amountIn;
    const newUsdtBalance = k / newWethBalance; // Using k = x * y formula
    expectedNewPrice = newUsdtBalance / newWethBalance;
  }

  Logger.info(`Will add ${amountIn.toExponential(4)} ${tokenIn} to the pool`);
  Logger.info(`Expected new price: ${expectedNewPrice.toFixed(8)} USDT/ETH`);

  return {
    tokenIn,
    tokenInDecimals,
    amountIn,
    expectedNewPrice
  };
};

/**
 * Converts a number to BigNumber with proper handling of scientific notation
 */
const toBigNumber = (amount: number, decimals: number): ethers.BigNumber => {
  try {
    // Convert to string with full precision
    const amountStr = amount.toLocaleString('fullwide', { useGrouping: false });

    // Determine if the number is an integer or has decimals
    if (!amountStr.includes('.')) {
      return ethers.utils.parseUnits(amountStr, decimals);
    }

    // Handle numbers with decimals
    const [integerPart, decimalPart] = amountStr.split('.');
    const paddedDecimalPart = decimalPart.padEnd(decimals, '0').slice(0, decimals);
    return ethers.BigNumber.from(integerPart + paddedDecimalPart);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to convert ${amount} to BigNumber: ${errorMsg}`);
  }
};

/**
 * Ensures the wallet has sufficient balance by minting tokens if needed
 */
const ensureTokenBalance = async (
  tokenAddress: string,
  amount: ethers.BigNumber,
  signer: ethers.Signer,
  routerAddress: string
): Promise<boolean> => {
  try {
    const signerAddress = await signer.getAddress();
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const tokenDecimals = await token.decimals();
    const balance = await token.balanceOf(signerAddress);
    const tokenSymbol = tokenAddress.toLowerCase().includes('usdt') ? 'USDT' : 'WETH';

    if (balance.lt(amount)) {
      // Mint with 20% extra for safety
      const mintAmount = amount.mul(120).div(100);
      Logger.info(
        `Minting ${ethers.utils.formatUnits(mintAmount, tokenDecimals)} ${tokenSymbol} tokens...`
      );

      const mintTx = await token.mint(signerAddress, mintAmount);
      await mintTx.wait();
      Logger.info(`${tokenSymbol} tokens successfully minted`);
    }

    // Check and update allowance
    const allowance = await token.allowance(signerAddress, routerAddress);
    if (allowance.lt(amount)) {
      Logger.info(
        `Approving ${ethers.utils.formatUnits(amount, tokenDecimals)} ${tokenSymbol} tokens for router...`
      );
      const approveTx = await token.approve(routerAddress, ethers.constants.MaxUint256);
      await approveTx.wait();
      Logger.info(`${tokenSymbol} tokens successfully approved`);
    }

    return true;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    Logger.error(`Error ensuring token balance: ${errorMsg}`);
    throw error;
  }
};

/**
 * Retrieves pool information with retries using exponential backoff.
 */
async function getPoolInfoWithRetries(
  config: PoolConfig,
  provider: ethers.providers.JsonRpcProvider,
  maxRetries: number,
  currentAttempt: number = 1
): Promise<PoolPriceInfo> {
  try {
    const poolInfo = await getPoolInfo(config, provider);
    return poolInfo;
  } catch (error) {
    if (currentAttempt >= maxRetries) {
      Logger.error(`Failed to get updated pool info after ${maxRetries} attempts.`);
      // Re-throw the last error or a more specific one
      throw error instanceof Error ? error : new Error('Could not verify final pool state after multiple retries');
    }

    // Exponential backoff calculation
    const waitTime = 1000 * (2 ** currentAttempt); // Use exponentiation operator
    Logger.warn(
      `Attempt ${currentAttempt}/${maxRetries} to get pool info failed. Waiting ${waitTime / 1000}s before next attempt...`
    );
    await new Promise(resolve => setTimeout(resolve, waitTime));
    return getPoolInfoWithRetries(config, provider, maxRetries, currentAttempt + 1); // Recursive call for next attempt
  }
}

/**
 * Main function that performs the direct pool adjustment in one step
 */
async function main(): Promise<void> {
  try {
    Logger.info('Starting single-step pool price adjustment...');

    // Get configuration
    const config = ConfigService.getPoolConfig();
    ConfigService.logConfig();

    // Initialize provider and wallet
    const provider = new ethers.providers.JsonRpcProvider(config.rpc);
    const wallet = new ethers.Wallet(config.privateKey, provider);

    // Get current pool information
    Logger.info('Fetching current pool state...');
    const poolInfo = await getPoolInfo(config, provider); // Initial fetch, no retries here unless getPoolInfo itself implements it

    // Get target price from Coingecko (or use fallback)
    let targetPrice: number;
    try {
      targetPrice = await coingeckoService.getTokenPrice('ethereum');
      Logger.info(`Target price from Coingecko: ${targetPrice.toFixed(8)} USDT per ETH`);
    } catch (error) {
      Logger.warn('Failed to fetch price from Coingecko. Using fallback price of 2500 USDT/ETH');
      targetPrice = 2500;
    }

    // Calculate the exact amounts needed to reach target in one swap
    const swapPlan = calculateDirectSwapToTarget(poolInfo, targetPrice);

    // Double-check the impact (for extreme deviations)
    const priceDifferenceFactor = targetPrice / poolInfo.usdtPerEth;
    if (priceDifferenceFactor > 100000) {
      Logger.warn(`⚠️ EXTREME PRICE ADJUSTMENT: Factor of ${priceDifferenceFactor.toExponential(2)}x`);
      Logger.warn('About to make a massive swap that will completely change the pool.');
      // In a production environment, you might want to add confirmation here
    }

    // Convert to BigNumber for transaction
    const amountInBN = toBigNumber(swapPlan.amountIn, swapPlan.tokenInDecimals);

    // Determine token addresses based on direction
    const tokenIn = swapPlan.tokenIn === 'USDT' ? config.usdtAddress : config.wethAddress;
    const tokenOut = swapPlan.tokenIn === 'USDT' ? config.wethAddress : config.usdtAddress;

    // Ensure sufficient balance (mint if needed)
    Logger.info('Ensuring sufficient token balance...');
    await ensureTokenBalance(tokenIn, amountInBN, wallet, config.swapRouterAddress);

    // Format amount for swap execution
    const amountInFormatted = ethers.utils.formatUnits(amountInBN, swapPlan.tokenInDecimals);
    Logger.info(`Executing swap: ${amountInFormatted} ${swapPlan.tokenIn} for ${swapPlan.tokenIn === 'USDT' ? 'WETH' : 'USDT'}`);

    // Execute the swap
    let txHash: string | undefined;
    try {
      const result = await executeSwap({
        config,
        amountIn: amountInFormatted,
        tokenIn,
        tokenOut
      });

      txHash = result?.transactionHash;
      Logger.info(`Swap transaction submitted: ${txHash || 'unknown'}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      Logger.error(`Swap execution failed: ${errorMsg}`);
      throw new Error(`Failed to execute swap: ${errorMsg}`);
    }

    // Wait for blockchain state to settle
    Logger.info('Waiting for blockchain state to update...');
    await new Promise(resolve => setTimeout(resolve, 2500)); // Standard delay, not in a loop flagged by ESLint

    // Get updated pool state with retries
    Logger.info('Checking new pool state...');
    const maxRetriesForPoolInfo = 3;
    const newPoolInfo = await getPoolInfoWithRetries(config, provider, maxRetriesForPoolInfo);

    // Compare results with expectations
    Logger.info('\n========== ADJUSTMENT RESULTS ==========');
    Logger.info(`Initial price: ${poolInfo.usdtPerEth.toFixed(8)} USDT/ETH`);
    Logger.info(`Target price:  ${targetPrice.toFixed(8)} USDT/ETH`);
    Logger.info(`New price:     ${newPoolInfo.usdtPerEth.toFixed(8)} USDT/ETH`);

    // Calculate metrics
    const priceChangePercent = ((newPoolInfo.usdtPerEth / poolInfo.usdtPerEth) - 1) * 100;
    const targetDifferencePercent = Math.abs((newPoolInfo.usdtPerEth / targetPrice - 1) * 100);

    Logger.info(`Price change: ${priceChangePercent.toFixed(2)}%`);
    Logger.info(`Distance from target: ${targetDifferencePercent.toFixed(2)}%`);

    // Final assessment
    if (targetDifferencePercent <= 5) {
      Logger.info('🎉 SUCCESS! Pool price successfully adjusted to within 5% of target.');
    } else if (targetDifferencePercent <= 20) {
      Logger.info('✅ PARTIAL SUCCESS: Pool price adjusted to within 20% of target.');
      Logger.info('You may want to run the script once more for fine-tuning.');
    } else {
      Logger.warn('⚠️ PARTIAL ADJUSTMENT: Pool price moved but still far from target.');
      Logger.warn(`Current deviation: ${targetDifferencePercent.toFixed(2)}% from target`);
      Logger.warn('Run the script again to continue adjustment.');
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    Logger.error(`ERROR: ${errorMsg}`);
    process.exit(1);
  }
}

// Execute and handle any top-level errors
main()
  .then(() => process.exit(0))
  .catch((error) => {
    Logger.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
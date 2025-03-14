/**
 * @file adjust_pool.ts
 * @description Adjusts a Uniswap pool price in testnet to target a specific value,
 * currently based on Ethereum's price from Coingecko. Supports bidirectional adjustments
 * (buying or selling) depending on the current pool price.
 */

import { ethers } from 'ethers';

import { executeSwap } from './swap_tokens';
import { Logger } from '../../src/helpers/loggerHelper';
import { ABI } from '../../src/services/web3/abiService';
import { coingeckoService } from '../../src/services/coingecko/coingeckoService';

// Type definitions
interface PoolConfig {
    readonly rpc: string;
    readonly privateKey: string;
    readonly usdtAddress: string;
    readonly wethAddress: string;
    readonly poolFee: number;
    readonly swapRouterAddress: string;
    readonly factoryAddress: string;
    readonly gasLimit: number;
}

interface TokenBalances {
    readonly poolBalanceA: ethers.BigNumber;
    readonly poolBalanceB: ethers.BigNumber;
    readonly tokenADecimals: number;
    readonly tokenBDecimals: number;
}

/**
 * Environment configuration setup
 * Network: Arbitrum Sepolia
 */
const getConfig = (): PoolConfig => {
    const requiredEnvVars = ['SIGNING_KEY'];

    requiredEnvVars.forEach((envVar) => {
        if (!process.env[envVar]) {
            throw new Error(`Missing required environment variable: ${envVar}`);
        }
    });

    return {
        rpc: `https://arb-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY ?? ''}`,
        privateKey: process.env.SIGNING_KEY!,
        usdtAddress: process.env.USDT_ADDRESS ?? '0xe6B817E31421929403040c3e42A6a5C5D2958b4A',
        wethAddress: process.env.WETH_ADDRESS ?? '0xe9c723d01393a437bac13ce8f925a5bc8e1c335c',
        poolFee: 3000, // 0.3%
        swapRouterAddress:
            process.env.SWAP_ROUTER_ADDRESS ?? '0x101F443B4d1b059569D643917553c771E1b9663E',
        factoryAddress:
            process.env.UNISWAP_FACTORY_ADDRESS ?? '0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e',
        gasLimit: 3000000
    };
};

/**
 * Minimal ERC20 ABI for required operations
 */
const ERC20_ABI: ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function mint(address to, uint256 amount) returns (bool)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)'
];

/**
 * Minimal Factory ABI for pool retrieval
 */
const FACTORY_ABI: ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];

/**
 * Calculates how many token0 tokens should be swapped for token1 in a single transaction
 * to make the resulting pool price (token0/token1) equal to targetPrice.
 *
 * Based on the AMM invariant: k = reserve0 * reserve1
 *
 * After the swap:
 *   - reserve0' = reserve0 + Δtoken0
 *   - reserve1' = reserve1 - Δtoken1
 *
 * And we want:
 *   (reserve0 + Δtoken0) / (reserve1 - Δtoken1) = targetPrice
 *
 * Solving using the invariant:
 *   newReserve1 = sqrt((reserve0 * reserve1) / targetPrice)
 *   newReserve0 = targetPrice * newReserve1 = sqrt(targetPrice * reserve0 * reserve1)
 *
 * The amount of token0 to swap is:
 *   Δtoken0 = newReserve0 - reserve0
 *
 * Note: The returned value can be positive or negative:
 *   - Positive: Need to add token0 to the pool (buy token0, sell token1)
 *   - Negative: Need to remove token0 from the pool (sell token0, buy token1)
 *
 * @param reserve0 - Current amount of token0 in the pool
 * @param reserve1 - Current amount of token1 in the pool
 * @param targetPrice - Desired price (token0 per 1 token1)
 * @returns The amount of token0 to swap (signed value indicating direction)
 */
const calculateSwapForTargetPrice = (
    reserve0: ethers.BigNumber,
    reserve1: ethers.BigNumber,
    targetPrice: number
): number => {
    // Convert BigNumbers to numeric values for mathematical calculations
    const reserve0Num = parseFloat(ethers.utils.formatUnits(reserve0, 18));
    const reserve1Num = parseFloat(ethers.utils.formatUnits(reserve1, 18));

    const k = reserve0Num * reserve1Num;

    // New reserve of token1 to achieve the target price
    const newReserve1 = Math.sqrt(k / targetPrice);

    // New reserve of token0 (since price is targetPrice = newReserve0/newReserve1)
    const newReserve0 = targetPrice * newReserve1;

    // Token0 amount to swap (can be positive or negative)
    return newReserve0 - reserve0Num;
};

/**
 * Retrieves the Uniswap V3 pool address for a token pair.
 *
 * @param tokenA - Token A address
 * @param tokenB - Token B address
 * @param config - Pool configuration
 * @param provider - Ethereum provider
 * @returns Uniswap V3 pool address
 * @throws Error if the pool doesn't exist
 */
const getPoolAddress = async (
    tokenA: string,
    tokenB: string,
    config: PoolConfig,
    provider: ethers.providers.JsonRpcProvider
): Promise<string> => {
    try {
        const factory = new ethers.Contract(config.factoryAddress, FACTORY_ABI, provider);

        // Get pool with the configured fee tier
        const poolAddress = await factory.getPool(tokenA, tokenB, config.poolFee);

        if (poolAddress === ethers.constants.AddressZero) {
            throw new Error(
                `Pool not found for tokens ${tokenA} and ${tokenB} with fee ${config.poolFee}`
            );
        }

        return poolAddress;
    } catch (error) {
        Logger.error(
            `Error retrieving pool address: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
    }
};

/**
 * Gets the token balances in a Uniswap pool.
 *
 * @param tokenA - Token A address
 * @param tokenB - Token B address
 * @param config - Pool configuration
 * @param provider - Ethereum provider
 * @returns Object with token balances and decimals
 */
const getPoolBalances = async (
    tokenA: string,
    tokenB: string,
    config: PoolConfig,
    provider: ethers.providers.JsonRpcProvider
): Promise<TokenBalances> => {
    try {
        const poolAddress = await getPoolAddress(tokenA, tokenB, config, provider);

        const tokenAContract = new ethers.Contract(tokenA, ERC20_ABI, provider);
        const tokenBContract = new ethers.Contract(tokenB, ERC20_ABI, provider);

        // Run all queries in parallel for optimization
        const [poolBalanceA, tokenADecimals, poolBalanceB, tokenBDecimals] = await Promise.all([
            tokenAContract.balanceOf(poolAddress),
            tokenAContract.decimals(),
            tokenBContract.balanceOf(poolAddress),
            tokenBContract.decimals()
        ]);

        return {
            poolBalanceA,
            poolBalanceB,
            tokenADecimals,
            tokenBDecimals
        };
    } catch (error) {
        Logger.error(
            `Error getting pool balances: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
    }
};

/**
 * Ensures the signer has sufficient balance for the swap.
 * If insufficient, mints more tokens with a 20% safety margin.
 *
 * @param tokenAddress - Token address
 * @param amount - Required amount
 * @param signer - Transaction signer
 * @param routerAddress - Uniswap router address
 * @returns true if balance is ensured
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

        // Check current balance
        const balance = await token.balanceOf(signerAddress);
        const tokenDecimals = await token.decimals();

        if (balance.lt(amount)) {
            // Calculate 20% extra for safety margin
            const mintAmount = amount.mul(120).div(100);

            Logger.info(
                `Insufficient balance. Minting ${ethers.utils.formatUnits(mintAmount, tokenDecimals)} tokens...`
            );

            const mintTx = await token.mint(signerAddress, mintAmount);
            await mintTx.wait();

            Logger.info(`Tokens successfully minted`);
        }

        // Check allowance
        const allowance = await token.allowance(signerAddress, routerAddress);

        if (allowance.lt(amount)) {
            Logger.info(
                `Approving ${ethers.utils.formatUnits(amount, tokenDecimals)} tokens for router...`
            );

            const approveTx = await token.approve(routerAddress, ethers.constants.MaxUint256);
            await approveTx.wait();

            Logger.info(`Tokens successfully approved`);
        }

        return true;
    } catch (error) {
        Logger.error(
            `Error ensuring token balance: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
    }
};

/**
 * Prepares tokens for swapping by ensuring balances and approvals.
 *
 * @param signer - Transaction signer
 * @param tokenAddress - Token address to swap
 * @param amount - Amount to swap
 * @param config - Pool configuration
 */
const prepareForSwap = async (
    signer: ethers.Wallet,
    tokenAddress: string,
    amount: ethers.BigNumber,
    config: PoolConfig
): Promise<void> => {
    await ensureTokenBalance(tokenAddress, amount, signer, config.swapRouterAddress);
};

/**
 * Converts a number to BigNumber handling scientific notation correctly.
 *
 * @param amount - Numeric amount
 * @param decimals - Token decimals
 * @returns Equivalent BigNumber
 */
const toBigNumber = (amount: number, decimals: number): ethers.BigNumber => {
    // Convert scientific notation to regular string
    const amountStr = amount.toLocaleString('fullwide', { useGrouping: false });

    // Determine if the number is an integer or has decimals
    if (!amountStr.includes('.')) {
        return ethers.utils.parseUnits(amountStr, decimals);
    }

    // Handle numbers with decimals
    const [integerPart, decimalPart] = amountStr.split('.');
    const paddedDecimalPart = decimalPart.padEnd(decimals, '0').slice(0, decimals);

    return ethers.BigNumber.from(integerPart + paddedDecimalPart);
};

/**
 * Main function that executes the pool adjustment logic.
 * Handles both buying and selling scenarios based on the calculated swap amount.
 */
async function main() {
    try {
        Logger.info('Starting pool adjustment script...');

        // Get configuration
        const config = getConfig();

        // Get target price from Coingecko
        const targetPrice = await coingeckoService.getTokenPrice('ethereum');
        Logger.info(`Target price: ${targetPrice} USDT per ETH`);

        // Initialize provider and wallet
        const provider = new ethers.providers.JsonRpcProvider(config.rpc);
        const wallet = new ethers.Wallet(config.privateKey, provider);

        // Get pool balances
        const { poolBalanceA, poolBalanceB, tokenADecimals, tokenBDecimals } = await getPoolBalances(
            config.usdtAddress,
            config.wethAddress,
            config,
            provider
        );

        // Calculate amount to swap to reach target price
        const tokensToSwap = calculateSwapForTargetPrice(poolBalanceA, poolBalanceB, targetPrice);

        // Determine swap direction based on the sign of tokensToSwap
        const isBuyingTokenA = tokensToSwap > 0;

        // Check if the magnitude is significant enough to warrant a swap
        if (Math.abs(tokensToSwap) < 1) {
            Logger.info('Amount to swap is too small to rebalance...');
            return;
        }

        // Use absolute value for transaction preparation
        const absTokensToSwap = Math.abs(tokensToSwap);

        // Determine which token to use as input based on the direction
        const tokenIn = isBuyingTokenA ? config.wethAddress : config.usdtAddress;
        const tokenOut = isBuyingTokenA ? config.usdtAddress : config.wethAddress;
        const tokenDecimals = isBuyingTokenA ? tokenBDecimals : tokenADecimals;

        // For positive tokensToSwap: We need to add USDT to the pool, so we buy USDT with WETH
        // For negative tokensToSwap: We need to remove USDT from the pool, so we sell USDT for WETH

        // Convert to BigNumber for transactions
        const swapAmountBN = toBigNumber(absTokensToSwap, tokenDecimals);
        const swapAmountFormatted = ethers.utils.formatUnits(swapAmountBN, tokenDecimals);

        Logger.info(
            isBuyingTokenA
                ? `Swapping ${swapAmountFormatted} WETH for USDT to adjust pool price...`
                : `Swapping ${swapAmountFormatted} USDT for WETH to adjust pool price...`
        );

        // Prepare tokens for swap
        await prepareForSwap(wallet, tokenIn, swapAmountBN, config);

        // Execute swap
        await executeSwap({
            config,
            amountIn: swapAmountFormatted,
            tokenIn,
            tokenOut
        });

        Logger.info('Swap completed successfully.');
    } catch (error) {
        Logger.error(`Execution error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        Logger.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });

export { executeSwap };
/**
 * @file swap_tokens.ts
 * @description Execute token swaps using Uniswap V3 on Arbitrum Sepolia testnet
 * 
 * This module provides a robust interface for executing token swaps via Uniswap V3,
 * with comprehensive error handling, type safety, and runtime validation.
 */

import { ethers } from 'ethers';

import { Logger } from '../../src/helpers/loggerHelper';
import { getERC20ABI } from '../../src/services/web3/abiService';

/**
 * Configuration for the swap execution environment
 * Defines network, contract addresses, and transaction parameters
 */
interface PoolConfig {
    readonly rpc: string;              // RPC endpoint URL for the network
    readonly privateKey: string;       // Private key for transaction signing
    readonly usdtAddress: string;      // USDT token contract address
    readonly wethAddress: string;      // WETH token contract address 
    readonly poolFee: number;          // Pool fee in basis points (3000 = 0.3%)
    readonly swapRouterAddress: string; // Uniswap V3 Router address
    readonly gasLimit: number;         // Gas limit for swap transactions
}

/**
 * Options for customizing swap execution
 * Allows overriding default parameters for different swap scenarios
 */
interface SwapOptions {
    readonly config?: Partial<PoolConfig>; // Override default configuration
    readonly amountIn?: string;            // Amount to swap (in token units with decimals)
    readonly slippageTolerance?: number;   // Slippage tolerance in basis points (e.g., 50 = 0.5%)
    readonly tokenIn?: string;             // Address of input token (overrides config)
    readonly tokenOut?: string;            // Address of output token (overrides config)
    readonly deadline?: number;            // Deadline for transaction execution (seconds from now)
}

/**
 * Result of a swap execution
 * Provides detailed information about the transaction outcome
 */
interface SwapResult {
    readonly success: boolean;                    // Whether the swap completed successfully
    readonly transactionHash?: string;            // Transaction hash if successful
    readonly gasUsed?: string;                    // Gas used by the transaction
    readonly error?: string;                      // Error message if not successful
    readonly amountIn?: string;                   // Input amount in readable format
    readonly amountOut?: string;                  // Output amount in readable format (if available)
    readonly inputToken?: string;                 // Input token symbol
    readonly outputToken?: string;                // Output token symbol
}

/**
 * Simplified ABI for Uniswap V3 Router's exactInputSingle function
 * Only includes the specific function needed for basic swaps
 */
const SWAP_ROUTER_ABI = [
    {
        "inputs": [
            {
                "components": [
                    { "internalType": "address", "name": "tokenIn", "type": "address" },
                    { "internalType": "address", "name": "tokenOut", "type": "address" },
                    { "internalType": "uint24", "name": "fee", "type": "uint24" },
                    { "internalType": "address", "name": "recipient", "type": "address" },
                    { "internalType": "uint256", "name": "deadline", "type": "uint256" },
                    { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
                    { "internalType": "uint256", "name": "amountOutMinimum", "type": "uint256" },
                    { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" }
                ],
                "internalType": "struct ISwapRouter.ExactInputSingleParams",
                "name": "params",
                "type": "tuple"
            }
        ],
        "name": "exactInputSingle",
        "outputs": [{ "internalType": "uint256", "name": "amountOut", "type": "uint256" }],
        "stateMutability": "payable",
        "type": "function"
    }
];

/**
 * Default configuration with environment fallbacks
 * Used when no custom configuration is provided
 * 
 * Note: Production code should use environment variables instead of hardcoded values
 */
const DEFAULT_CONFIG: PoolConfig = {
    rpc: `https://arb-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY ?? ''}`,
    privateKey: process.env.SIGNING_KEY ?? '',
    usdtAddress: process.env.USDT_ADDRESS ?? '0x6D904bB70Cf0CbD427e5e70BCcE1F4D1348b785d',
    wethAddress: process.env.WETH_ADDRESS ?? '0xd3A5f60cc44b9E51BF7e8D6db882a88260F708BC',
    poolFee: 3000, // 0.3%
    swapRouterAddress: process.env.SWAP_ROUTER_ADDRESS ?? '0x101F443B4d1b059569D643917553c771E1b9663E',
    gasLimit: 3000000,
};

/**
 * Safely gets token information (symbol and decimals) with error handling
 * 
 * @param tokenContract - ERC20 token contract instance
 * @param fallbackSymbol - Symbol to use if contract call fails
 * @returns Object containing token symbol and decimals
 */
async function getTokenInfo(
    tokenContract: ethers.Contract,
    fallbackSymbol: string = 'UNKNOWN'
): Promise<{ symbol: string; decimals: number }> {
    try {
        // Execute both calls in parallel for efficiency
        const [symbol, decimals] = await Promise.all([
            tokenContract.symbol().catch(() => fallbackSymbol),
            tokenContract.decimals().catch(() => 18) // Most tokens use 18 decimals
        ]);

        return { symbol, decimals };
    } catch (error) {
        // Fallback to defaults if calls fail
        Logger.warn(`Failed to get token info: ${error instanceof Error ? error.message : String(error)}`);
        return { symbol: fallbackSymbol, decimals: 18 };
    }
}

/**
 * Calculate minimum output amount based on slippage tolerance
 * 
 * @param inputAmount - Amount being swapped in wei
 * @param slippageTolerance - Acceptable slippage in basis points
 * @param outputAmount - Expected output amount (if known)
 * @returns Minimum acceptable output amount
 */
function calculateMinimumOutput(
    inputAmount: ethers.BigNumber,
    slippageTolerance: number = 50, // Default to 0.5%
    outputAmount?: ethers.BigNumber
): ethers.BigNumber {
    // If we already know the expected output, use it with slippage applied
    if (outputAmount) {
        const slippageFactor = 10000 - slippageTolerance;
        return outputAmount.mul(slippageFactor).div(10000);
    }

    // Default to 0 minimum (not recommended for production)
    return ethers.constants.Zero;
}

/**
 * Checks token approval and approves if necessary
 * 
 * @param tokenContract - Token contract instance
 * @param ownerAddress - Address of token owner
 * @param spenderAddress - Address to approve spending
 * @param amount - Amount to approve
 * @param tokenSymbol - Token symbol for logging
 */
async function ensureTokenApproval(
    tokenContract: ethers.Contract,
    ownerAddress: string,
    spenderAddress: string,
    amount: ethers.BigNumber,
    tokenSymbol: string,
    tokenDecimals: number
): Promise<void> {
    const allowance = await tokenContract.allowance(ownerAddress, spenderAddress);

    if (allowance.lt(amount)) {
        Logger.info(`Approving ${ethers.utils.formatUnits(amount, tokenDecimals)} ${tokenSymbol} for router...`);

        const approveTx = await tokenContract.approve(spenderAddress, amount);
        const receipt = await approveTx.wait();

        Logger.info(
            `Approval completed. Hash: ${approveTx.hash}, Gas used: ${receipt.gasUsed.toString()}`
        );
    } else {
        Logger.info(`Sufficient allowance already exists for ${tokenSymbol}`);
    }
}

/**
 * Execute a token swap on Uniswap V3
 * 
 * This function handles the entire swap process:
 * 1. Validates inputs and connects to the network
 * 2. Checks token balances and approvals
 * 3. Executes the swap with slippage protection
 * 4. Returns detailed swap results
 * 
 * @param options - Customization options for the swap
 * @returns Promise resolving to swap execution results
 */
async function executeSwap(options: SwapOptions = {}): Promise<SwapResult> {
    try {
        // Merge provided config with defaults
        const config = { ...DEFAULT_CONFIG, ...options.config };

        // Validate critical config parameters
        if (!config.privateKey) {
            throw new Error('Private key is required for signing transactions');
        }

        // Determine tokens for the swap
        const tokenInAddress = options.tokenIn ?? config.usdtAddress;
        const tokenOutAddress = options.tokenOut ?? config.wethAddress;

        if (!ethers.utils.isAddress(tokenInAddress) || !ethers.utils.isAddress(tokenOutAddress)) {
            throw new Error('Invalid token addresses provided');
        }

        // Initialize provider and wallet
        Logger.info(`Connecting to RPC endpoint: ${config.rpc.replace(/\/[a-zA-Z0-9_-]{10,}/, '/***')}`);
        const provider = new ethers.providers.JsonRpcProvider(config.rpc);
        const wallet = new ethers.Wallet(config.privateKey, provider);

        Logger.info(`Connected with account: ${wallet.address}`);

        // Initialize contract interfaces
        const erc20Abi = await getERC20ABI();
        const tokenInContract = new ethers.Contract(tokenInAddress, erc20Abi, wallet);
        const tokenOutContract = new ethers.Contract(tokenOutAddress, erc20Abi, wallet);
        const swapRouterContract = new ethers.Contract(config.swapRouterAddress, SWAP_ROUTER_ABI, wallet);

        // Get token information in parallel for efficiency
        const [tokenInInfo, tokenOutInfo] = await Promise.all([
            getTokenInfo(tokenInContract, 'IN-TOKEN'),
            getTokenInfo(tokenOutContract, 'OUT-TOKEN')
        ]);

        // Parse input amount with proper decimals
        const defaultAmount = "1"; // Default to 1 token
        const amountIn = ethers.utils.parseUnits(options.amountIn ?? defaultAmount, tokenInInfo.decimals);
        const formattedAmountIn = ethers.utils.formatUnits(amountIn, tokenInInfo.decimals);

        Logger.info(`Preparing to swap ${formattedAmountIn} ${tokenInInfo.symbol} → ${tokenOutInfo.symbol}`);

        // Check if wallet has sufficient balance
        const balance = await tokenInContract.balanceOf(wallet.address);
        Logger.info(`Balance: ${ethers.utils.formatUnits(balance, tokenInInfo.decimals)} ${tokenInInfo.symbol}`);

        if (balance.lt(amountIn)) {
            return {
                success: false,
                error: `Insufficient balance. Have ${ethers.utils.formatUnits(balance, tokenInInfo.decimals)} ${tokenInInfo.symbol}, need ${formattedAmountIn}`,
                inputToken: tokenInInfo.symbol,
                outputToken: tokenOutInfo.symbol,
                amountIn: formattedAmountIn
            };
        }

        // Ensure router has approval to spend tokens
        await ensureTokenApproval(
            tokenInContract,
            wallet.address,
            config.swapRouterAddress,
            amountIn,
            tokenInInfo.symbol,
            tokenInInfo.decimals
        );

        // Calculate deadline for transaction (default: 20 minutes from now)
        const deadline = Math.floor(Date.now() / 1000) + (options.deadline ?? 1200);

        // Apply slippage tolerance (default: 0.5%)
        const slippageTolerance = options.slippageTolerance ?? 50;
        const amountOutMinimum = calculateMinimumOutput(amountIn, slippageTolerance);

        // Prepare swap parameters
        const params = {
            tokenIn: tokenInAddress,
            tokenOut: tokenOutAddress,
            fee: config.poolFee,
            recipient: wallet.address,
            deadline,
            amountIn,
            amountOutMinimum,
            sqrtPriceLimitX96: 0  // No price limit
        };

        // Execute the swap
        Logger.info("Executing swap transaction...");
        const swapTx = await swapRouterContract.exactInputSingle(
            params,
            {
                gasLimit: config.gasLimit,
                value: 0  // No ETH being sent
            }
        );

        Logger.info(`Swap initiated. Transaction hash: ${swapTx.hash}`);

        // Wait for transaction to be mined
        const receipt = await swapTx.wait();

        // Extract amount out from event logs (if possible)
        let amountOut: string | undefined;
        try {
            // Attempt to find the transfer event for the output token
            // This is a simplified approach and may not work for all swap scenarios
            const iface = new ethers.utils.Interface([
                'event Transfer(address indexed from, address indexed to, uint256 value)'
            ]);

            const transferLogs = receipt.logs
                .map((log: {
                    address: string;
                    data: string;
                    topics: string[];
                }) => {
                    try {
                        return {
                            address: log.address.toLowerCase(),
                            parsed: iface.parseLog(log)
                        };
                    } catch (e) {
                        return null;
                    }
                })
                .filter((log: {
                    address: string;
                    parsed: ethers.utils.LogDescription;
                }) =>
                    log !== null &&
                    log.address.toLowerCase() === tokenOutAddress.toLowerCase() &&
                    log.parsed.name === 'Transfer' &&
                    log.parsed.args.to.toLowerCase() === wallet.address.toLowerCase()
                );

            if (transferLogs.length > 0) {
                const lastTransferLog = transferLogs[transferLogs.length - 1];
                amountOut = ethers.utils.formatUnits(
                    lastTransferLog.parsed.args.value,
                    tokenOutInfo.decimals
                );
            }
        } catch (error) {
            Logger.warn(`Could not parse output amount: ${error instanceof Error ? error.message : String(error)}`);
        }

        Logger.info(`Swap completed successfully. Gas used: ${receipt.gasUsed.toString()}`);

        return {
            success: true,
            transactionHash: swapTx.hash,
            gasUsed: receipt.gasUsed.toString(),
            amountIn: formattedAmountIn,
            amountOut,
            inputToken: tokenInInfo.symbol,
            outputToken: tokenOutInfo.symbol
        };
    } catch (error) {
        // Comprehensive error handling
        Logger.error(`Swap execution failed: ${error instanceof Error ? error.message : String(error)}`);

        // Return structured error information
        return {
            success: false,
            error: error instanceof Error
                ? error.message
                : 'Unknown error during swap execution'
        };
    }
}

// Execute main function if running directly
if (require.main === module) {
    executeSwap({
        amountIn: "1",
        tokenIn: DEFAULT_CONFIG.wethAddress,
        tokenOut: DEFAULT_CONFIG.usdtAddress,
        slippageTolerance: 100  // 1% slippage tolerance
    })
        .then(result => {
            Logger.info("Swap result:", result);
            process.exit(0);
        })
        .catch(error => {
            Logger.error("Fatal error:", error);
            process.exit(1);
        });
}

// Export for use in other modules
export { SwapResult, PoolConfig, executeSwap, SwapOptions };
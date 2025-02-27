import dotenv from 'dotenv';
import { ethers } from 'ethers';

import { Logger } from '../../src/helpers/loggerHelper';

// Load environment variables
dotenv.config();

/**
 * Complete script to validate all necessary conditions before a swap
 * Run this script before attempting a swap to diagnose issues
 */
async function validateSwapPrerequisites(
    provider: ethers.providers.Provider,
    chatterPayAddress: string,
    proxyAddress: string,
    tokenIn: string,
    tokenOut: string,
    amount: string,
    recipient: string
): Promise<boolean> {
    Logger.info('validateSwapPrerequisites', '=====================================================');
    Logger.info('validateSwapPrerequisites', 'COMPLETE PRE-SWAP VALIDATION');
    Logger.info('validateSwapPrerequisites', '=====================================================');

    try {
        // 1. Load necessary ABIs
        Logger.info('validateSwapPrerequisites', '1. Loading ABIs and contracts...');

        // ChatterPay ABI simplified with the necessary functions
        const chatterPayABI = [
            "function isTokenWhitelisted(address) view returns (bool)",
            "function getPriceFeed(address) view returns (address)",
            "function getSwapRouter() view returns (address)",
            "function getFeeInCents() view returns (uint256)",
            "function owner() view returns (address)"
        ];

        // ERC20 ABI simplified
        const erc20ABI = [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function symbol() view returns (string)",
            "function allowance(address,address) view returns (uint256)"
        ];

        // Uniswap Factory ABI simplified
        const uniswapFactoryABI = [
            "function getPool(address,address,uint24) view returns (address)"
        ];

        // Uniswap Pool ABI simplified
        const uniswapPoolABI = [
            "function liquidity() view returns (uint128)",
            "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
        ];

        // Chainlink ABI simplified
        const chainlinkABI = [
            "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
            "function decimals() view returns (uint8)"
        ];

        // Initialize contracts
        const chatterPay = new ethers.Contract(chatterPayAddress, chatterPayABI, provider);
        const tokenInContract = new ethers.Contract(tokenIn, erc20ABI, provider);
        const tokenOutContract = new ethers.Contract(tokenOut, erc20ABI, provider);

        Logger.info('validateSwapPrerequisites', `ChatterPay: ${chatterPayAddress}`);
        Logger.info('validateSwapPrerequisites', `Proxy: ${proxyAddress}`);
        Logger.info('validateSwapPrerequisites', `TokenIn: ${tokenIn}`);
        Logger.info('validateSwapPrerequisites', `TokenOut: ${tokenOut}`);
        Logger.info('validateSwapPrerequisites', 'Contracts loaded successfully ✅');

        // 2. Verify whitelist of tokens
        Logger.info('validateSwapPrerequisites', '\n2. Verifying whitelist status...');
        const [inWhitelisted, outWhitelisted] = await Promise.all([
            chatterPay.isTokenWhitelisted(tokenIn),
            chatterPay.isTokenWhitelisted(tokenOut)
        ]);

        Logger.info('validateSwapPrerequisites', `TokenIn whitelisted: ${inWhitelisted ? '✅' : '❌'}`);
        Logger.info('validateSwapPrerequisites', `TokenOut whitelisted: ${outWhitelisted ? '✅' : '❌'}`);

        if (!inWhitelisted || !outWhitelisted) {
            Logger.error('validateSwapPrerequisites', 'ERROR: Both tokens must be on the whitelist');
            return false;
        }

        // 3. Get token information
        Logger.info('validateSwapPrerequisites', '\n3. Getting token information...');
        const [
            tokenInSymbol,
            tokenInDecimals,
            tokenOutSymbol,
            tokenOutDecimals
        ] = await Promise.all([
            tokenInContract.symbol(),
            tokenInContract.decimals(),
            tokenOutContract.symbol(),
            tokenOutContract.decimals()
        ]);

        Logger.info('validateSwapPrerequisites', `TokenIn: ${tokenInSymbol} (${tokenInDecimals} decimals)`);
        Logger.debug('validateSwapPrerequisites', `TokenOut: ${tokenOutSymbol} (${tokenOutDecimals} decimals)`);

        // 4. Verify balances
        Logger.info('validateSwapPrerequisites', '\n4. Verifying balances...');
        const amountInBN = ethers.utils.parseUnits(amount, tokenInDecimals);
        const balance = await tokenInContract.balanceOf(proxyAddress);

        Logger.info('validateSwapPrerequisites', `Required balance: ${ethers.utils.formatUnits(amountInBN, tokenInDecimals)} ${tokenInSymbol}`);
        Logger.info('validateSwapPrerequisites', `Current balance: ${ethers.utils.formatUnits(balance, tokenInDecimals)} ${tokenInSymbol}`);

        if (balance.lt(amountInBN)) {
            Logger.error('validateSwapPrerequisites', 'ERROR: Insufficient balance ❌');
            return false;
        }
        Logger.info('validateSwapPrerequisites', 'Balance sufficient ✅');

        // 5. Verify price feeds
        Logger.info('validateSwapPrerequisites', '\n5. Verifying price feeds...');
        const [inPriceFeed, outPriceFeed] = await Promise.all([
            chatterPay.getPriceFeed(tokenIn),
            chatterPay.getPriceFeed(tokenOut)
        ]);

        Logger.info('validateSwapPrerequisites', `TokenIn price feed: ${inPriceFeed}`);
        Logger.info('validateSwapPrerequisites', `TokenOut price feed: ${outPriceFeed}`);

        if (inPriceFeed === ethers.constants.AddressZero || outPriceFeed === ethers.constants.AddressZero) {
            Logger.error('validateSwapPrerequisites', 'ERROR: Some price feed is not configured ❌');
            return false;
        }

        // 6. Verify current prices
        Logger.info('validateSwapPrerequisites', '\n6. Verifying prices...');
        try {
            const inPriceFeedContract = new ethers.Contract(inPriceFeed, chainlinkABI, provider);
            const outPriceFeedContract = new ethers.Contract(outPriceFeed, chainlinkABI, provider);

            const [inRoundData, outRoundData] = await Promise.all([
                inPriceFeedContract.latestRoundData(),
                outPriceFeedContract.latestRoundData()
            ]);

            const inPrice = inRoundData.answer;
            const outPrice = outRoundData.answer;

            Logger.info('validateSwapPrerequisites', `Price of ${tokenInSymbol}: ${inPrice.toString()}`);
            Logger.info('validateSwapPrerequisites', `Price of ${tokenOutSymbol}: ${outPrice.toString()}`);

            if (inPrice.lte(0) || outPrice.lte(0)) {
                Logger.error('validateSwapPrerequisites', 'ERROR: Invalid prices ❌');
                return false;
            }
        } catch (error: unknown) {
            Logger.error('validateSwapPrerequisites', `ERROR getting prices: ${(error as Error).message} ❌`);
            return false;
        }

        // 7. Get Uniswap router
        Logger.info('validateSwapPrerequisites', '\n7. Verifying router...');
        const router = await chatterPay.getSwapRouter();
        Logger.info('validateSwapPrerequisites', `Router address: ${router}`);

        if (router === ethers.constants.AddressZero) {
            Logger.error('validateSwapPrerequisites', 'ERROR: Router not configured ❌');
            return false;
        }

        // 8. Verify allowance
        Logger.info('validateSwapPrerequisites', '\n8. Verifying allowance...');
        const allowance = await tokenInContract.allowance(proxyAddress, router);
        Logger.info('validateSwapPrerequisites', `Current allowance: ${ethers.utils.formatUnits(allowance, tokenInDecimals)} ${tokenInSymbol}`);

        if (allowance.lt(amountInBN)) {
            Logger.warn('validateSwapPrerequisites', 'WARNING: Insufficient allowance ⚠️');
            Logger.warn('validateSwapPrerequisites', 'Tokens need to be approved before swap');
        } else {
            Logger.info('validateSwapPrerequisites', 'Allowance sufficient ✅');
        }

        // 9. Verify pool and liquidity
        Logger.info('validateSwapPrerequisites', '\n9. Verifying pool and liquidity...');

        // Get Uniswap factory address from environment or use default based on network
        let uniswapFactoryAddress = process.env.UNISWAP_FACTORY || "";
        
        // If not provided in env, detect factory based on the network
        if (!uniswapFactoryAddress) {
            const network = await provider.getNetwork();
            if (network.chainId === 421614) { // Arbitrum Sepolia
                uniswapFactoryAddress = "0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e"; // Arbitrum Sepolia factory
            } else {
                // Default Uniswap v3 factory address (mainnet)
                uniswapFactoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
            }
        }
        
        Logger.debug('validateSwapPrerequisites', `Using Uniswap Factory: ${uniswapFactoryAddress}`);

        try {
            const uniswapFactory = new ethers.Contract(uniswapFactoryAddress, uniswapFactoryABI, provider);

            // Test different fee tiers
            const feeTiers = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%
            let poolAddress = ethers.constants.AddressZero;
            let feeTier = 0;

            const pools = await Promise.all(
                feeTiers.map(fee => uniswapFactory.getPool(tokenIn, tokenOut, fee))
            );
            const poolIndex = pools.findIndex(pool => pool !== ethers.constants.AddressZero);
            if (poolIndex >= 0) {
                poolAddress = pools[poolIndex];
                feeTier = feeTiers[poolIndex];
            }

            if (poolAddress === ethers.constants.AddressZero) {
                Logger.error('validateSwapPrerequisites', 'ERROR: No pool found for this token pair ❌');
                Logger.error('validateSwapPrerequisites', 'A pool needs to be created before swaps can be made');
                return false;
            }

            Logger.info('validateSwapPrerequisites', `Pool found: ${poolAddress} (fee: ${feeTier / 10000}%)`);

            // Verify liquidity
            const pool = new ethers.Contract(poolAddress, uniswapPoolABI, provider);
            const liquidity = await pool.liquidity();
            Logger.info('validateSwapPrerequisites', `Current liquidity: ${liquidity.toString()}`);

            if (liquidity.eq(0)) {
                Logger.error('validateSwapPrerequisites', 'ERROR: Pool has no liquidity ❌');
                return false;
            }

            // Get current price in the pool
            const slot0 = await pool.slot0();
            Logger.debug('validateSwapPrerequisites', `Current sqrt price: ${slot0.sqrtPriceX96.toString()}`);
            Logger.debug('validateSwapPrerequisites', `Current tick: ${slot0.tick}`);

        } catch (error: unknown) {
            Logger.error('validateSwapPrerequisites', `ERROR verifying pool: ${(error as Error).message} ❌`);
            return false;
        }

        // 10. Verify fee settings
        Logger.info('validateSwapPrerequisites', '\n10. Verifying fee configuration...');
        const feeInCents = await chatterPay.getFeeInCents();
        Logger.info('validateSwapPrerequisites', `Current fee: ${feeInCents.toString()} cents`);

        // 11. Verify wallet owner
        Logger.info('validateSwapPrerequisites', '\n11. Verifying wallet owner...');
        const owner = await chatterPay.owner();
        Logger.info('validateSwapPrerequisites', `Owner: ${owner}`);

        // Summarize results
        Logger.info('validateSwapPrerequisites', '\n=====================================================');
        Logger.info('validateSwapPrerequisites', 'VALIDATION SUMMARY');
        Logger.info('validateSwapPrerequisites', '=====================================================');
        Logger.info('validateSwapPrerequisites', `ChatterPay: ${chatterPayAddress}`);
        Logger.info('validateSwapPrerequisites', `Proxy: ${proxyAddress}`);
        Logger.info('validateSwapPrerequisites', `TokenIn: ${tokenInSymbol} (${tokenIn})`);
        Logger.info('validateSwapPrerequisites', `TokenOut: ${tokenOutSymbol} (${tokenOut})`);
        Logger.info('validateSwapPrerequisites', `Amount: ${amount} ${tokenInSymbol}`);
        Logger.info('validateSwapPrerequisites', `Recipient: ${recipient}`);
        Logger.info('validateSwapPrerequisites', `TokenIn whitelisted: ${inWhitelisted ? '✅' : '❌'}`);
        Logger.info('validateSwapPrerequisites', `TokenOut whitelisted: ${outWhitelisted ? '✅' : '❌'}`);
        Logger.info('validateSwapPrerequisites', `Sufficient balance: ${balance.gte(amountInBN) ? '✅' : '❌'}`);
        Logger.info('validateSwapPrerequisites', `Sufficient allowance: ${allowance.gte(amountInBN) ? '✅' : '❌'}`);
        Logger.info('validateSwapPrerequisites', 'Pool with liquidity: ✅');
        Logger.info('validateSwapPrerequisites', '=====================================================');

        return true;
    } catch (error) {
        Logger.error('validateSwapPrerequisites', 'Error during validation:', error);
        return false;
    }
}

// Main function
async function main() {
    try {
        // Get environment variables or use default
        // Get parameters from env file or use defaults
        const CHATTERPAY_ADDRESS = process.env.CHATTERPAY_ADDRESS ?? '0xBc5a2FE45C825BB091075664cae88914FB3f73f0';
        const PROXY_ADDRESS = process.env.PROXY_ADDRESS ?? '0x1c875fD25BEb9b72011864831a95eeb67ae8f06d';
        const TOKEN_IN = process.env.TOKEN_IN ?? '0xE9C723D01393a437bac13CE8f925A5bc8E1c335c'; // WETH
        const TOKEN_OUT = process.env.TOKEN_OUT ?? '0xe6B817E31421929403040c3e42A6a5C5D2958b4A'; // USDT
        const AMOUNT = process.env.AMOUNT ?? '10';
        const RECIPIENT = process.env.RECIPIENT ?? '0x1c875fD25BEb9b72011864831a95eeb67ae8f06d';
        
        // RPC configuration
        const { INFURA_API_KEY } = process.env;
        const rpcUrl = `${process.env.RPC_URL ?? "https://arbitrum-sepolia.infura.io/v3/"}${INFURA_API_KEY}`;

        // Configure provider
        const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        
        // Run validation
        Logger.info('main', 'Starting swap validation...');
        const result = await validateSwapPrerequisites(
            provider,
            CHATTERPAY_ADDRESS,
            PROXY_ADDRESS,
            TOKEN_IN,
            TOKEN_OUT,
            AMOUNT,
            RECIPIENT
        );

        Logger.info('main', `\nValidation ${result ? 'successful ✅' : 'failed ❌'}`);

        process.exit(result ? 0 : 1);
    } catch (error) {
        Logger.error('main', 'Fatal error during execution:', error);
        process.exit(1);
    }
}

// Run the script
main();
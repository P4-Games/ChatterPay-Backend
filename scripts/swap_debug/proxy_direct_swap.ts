/* eslint-disable no-console */
import dotenv from 'dotenv';
import { ethers } from 'ethers';

// Load environment variables
dotenv.config();

/**
 * Direct swap execution script that bypasses the UserOp and EntryPoint system
 * This script will connect directly as the owner and execute the swap functions
 */
async function executeDirectSwap(
    provider: ethers.providers.JsonRpcProvider,
    chatterPayAddress: string,
    proxyAddress: string,
    tokenIn: string,
    tokenOut: string,
    amount: string,
    recipient: string
): Promise<boolean> {
    console.log('=====================================================');
    console.log('DIRECT SWAP EXECUTION (BYPASSING USEROP/ENTRYPOINT)');
    console.log('=====================================================');
    
    try {
        // 1. Load contracts and ABIs
        console.log('1. Loading contracts...');
        
        const chatterPayABI = [
            "function approveToken(address token, uint256 amount) external",
            "function executeSwap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, address recipient) external",
            "function getSwapRouter() view returns (address)",
            "function owner() view returns (address)"
        ];
        
        const erc20ABI = [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function symbol() view returns (string)",
            "function allowance(address,address) view returns (uint256)"
        ];
        
        // Get signer
        if (!process.env.SIGNING_KEY) {
            throw new Error("Missing SIGNING_KEY in environment variables");
        }
        
        const signer = new ethers.Wallet(process.env.SIGNING_KEY, provider);
        console.log(`Using signer address: ${signer.address}`);
        
        // Initialize contracts
        const proxy = new ethers.Contract(proxyAddress, chatterPayABI, provider);
        const proxyWithSigner = proxy.connect(signer);
        const tokenInContract = new ethers.Contract(tokenIn, erc20ABI, provider);
        const tokenOutContract = new ethers.Contract(tokenOut, erc20ABI, provider);
        
        console.log(`ChatterPay Implementation: ${chatterPayAddress}`);
        console.log(`Proxy: ${proxyAddress}`);
        console.log(`TokenIn: ${tokenIn}`);
        console.log(`TokenOut: ${tokenOut}`);
        
        // 2. Verify the owner
        console.log('\n2. Verifying owner permissions...');
        const proxyOwner = await proxy.owner();
        
        if (proxyOwner.toLowerCase() !== signer.address.toLowerCase()) {
            console.error(`ERROR: Signer (${signer.address}) is not the owner of the proxy (${proxyOwner})`);
            return false;
        }
        console.log('Signer is the owner of the proxy ✅');
        
        // 3. Get token information
        console.log('\n3. Getting token information...');
        
        const [tokenInSymbol, tokenInDecimals, tokenOutSymbol, tokenOutDecimals] = await Promise.all([
            tokenInContract.symbol(),
            tokenInContract.decimals(),
            tokenOutContract.symbol(),
            tokenOutContract.decimals()
        ]);
        
        console.log(`TokenIn: ${tokenInSymbol} (${tokenInDecimals} decimals)`);
        console.log(`TokenOut: ${tokenOutSymbol} (${tokenOutDecimals} decimals)`);
        
        // 4. Check initial balances
        console.log('\n4. Checking initial balances...');
        
        const amountInBN = ethers.utils.parseUnits(amount, tokenInDecimals);
        const initialInBalance = await tokenInContract.balanceOf(proxyAddress);
        const initialOutBalance = await tokenOutContract.balanceOf(recipient);
        
        console.log(`Initial ${tokenInSymbol} balance: ${ethers.utils.formatUnits(initialInBalance, tokenInDecimals)}`);
        console.log(`Initial ${tokenOutSymbol} balance: ${ethers.utils.formatUnits(initialOutBalance, tokenOutDecimals)}`);
        
        if (initialInBalance.lt(amountInBN)) {
            console.error(`ERROR: Insufficient balance. Need at least ${ethers.utils.formatUnits(amountInBN, tokenInDecimals)} ${tokenInSymbol}`);
            return false;
        }
        
        // 5. Check and approve tokens if needed
        console.log('\n5. Checking and approving tokens...');
        
        const router = await proxy.getSwapRouter();
        console.log(`Router address: ${router}`);
        
        /* const currentAllowance = await tokenInContract.allowance(proxyAddress, router);
        console.log(`Current allowance: ${ethers.utils.formatUnits(currentAllowance, tokenInDecimals)} ${tokenInSymbol}`);
        
        // Approve tokens if needed
        if (currentAllowance.lt(amountInBN)) {
            console.log('Insufficient allowance, executing approval...');
            
            try {
                const approvalTx = await proxyWithSigner.approveToken(
                    tokenIn,
                    ethers.constants.MaxUint256 // Approve maximum to avoid future issues
                );
                
                console.log(`Approval transaction sent: ${approvalTx.hash}`);
                console.log('Waiting for confirmation...');
                
                await approvalTx.wait();
                console.log('Approval confirmed ✅');
                
                // Verify the new allowance
                const newAllowance = await tokenInContract.allowance(proxyAddress, router);
                console.log(`New allowance: ${ethers.utils.formatUnits(newAllowance, tokenInDecimals)} ${tokenInSymbol}`);
                
                if (newAllowance.lt(amountInBN)) {
                    console.error('ERROR: Approval was not effective ❌');
                    return false;
                }
            } catch (error) {
                console.error('ERROR approving tokens:', error);
                return false;
            }
        } else {
            console.log('Allowance is sufficient, skipping approval ✅');
        }
        */
        // 6. Calculate amountOutMin with high slippage for testing
        console.log('\n6. Calculating amountOutMin with high slippage...');
        
        // Use a very low value to ensure swap works in testing
        const amountOutMin = ethers.BigNumber.from(1); // Practically 0
        
        console.log(`AmountOutMin: ${amountOutMin.toString()} (almost 100% slippage for testing)`);
        
        // 7. Execute the swap
        console.log('\n7. Executing swap...');
        
        try {
            const swapTx = await proxyWithSigner.executeSwap(
                tokenIn,
                tokenOut,
                amountInBN,
                amountOutMin,
                recipient
            );
            
            console.log(`Swap transaction sent: ${swapTx.hash}`);
            console.log('Waiting for confirmation...');
            
            await swapTx.wait();
            console.log('Swap confirmed ✅');
            
            // Check final token balances
            const finalInBalance = await tokenInContract.balanceOf(proxyAddress);
            const finalOutBalance = await tokenOutContract.balanceOf(recipient);
            
            console.log(`\nFinal ${tokenInSymbol} balance: ${ethers.utils.formatUnits(finalInBalance, tokenInDecimals)}`);
            console.log(`Final ${tokenOutSymbol} balance: ${ethers.utils.formatUnits(finalOutBalance, tokenOutDecimals)}`);
            
            const inDiff = initialInBalance.sub(finalInBalance);
            const outDiff = finalOutBalance.sub(initialOutBalance);
            
            console.log(`\n${tokenInSymbol} spent: ${ethers.utils.formatUnits(inDiff, tokenInDecimals)}`);
            console.log(`${tokenOutSymbol} received: ${ethers.utils.formatUnits(outDiff, tokenOutDecimals)}`);
            
            if (outDiff.gt(0)) {
                console.log('\nSWAP EXECUTED SUCCESSFULLY ✅');
                return true;
            }

            console.error('\nERROR: No tokens received ❌');
            return false;
        } catch (error) {
            console.error('ERROR executing swap:', error);
            console.error('Error details:', (error as Error).message);
            return false;
        }
    } catch (error) {
        console.error('Execution error:', error);
        return false;
    }
}

// Main function
async function main() {
    try {
        // Get environment variables or use defaults
        const rpcUrl =  ('https://arbitrum-sepolia.infura.io/v3/INF_KEY').replace('INF_KEY', process.env.INFURA_API_KEY ?? '');
        
        // Contract addresses
        const CHATTERPAY_ADDRESS = process.env.CHATTERPAY_ADDRESS || '0xBc5a2FE45C825BB091075664cae88914FB3f73f0';
        const PROXY_ADDRESS = process.env.PROXY_ADDRESS || '0x56b1f585c1a08dad9fcfe38ab2c8f8ee1620bdd4';
        const TOKEN_IN = process.env.TOKEN_IN || '0xE9C723D01393a437bac13CE8f925A5bc8E1c335c'; // WETH
        const TOKEN_OUT = process.env.TOKEN_OUT || '0xe6B817E31421929403040c3e42A6a5C5D2958b4A'; // USDT
        const AMOUNT = process.env.AMOUNT || '0.001'; // Small amount for testing
        const RECIPIENT = process.env.RECIPIENT || PROXY_ADDRESS; // Default to proxy address
        
        // Configure provider
        console.log(`Connecting to ${rpcUrl}...`);
        const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        
        // Execute direct swap
        console.log('Starting direct swap execution...');
        const result = await executeDirectSwap(
            provider,
            CHATTERPAY_ADDRESS,
            PROXY_ADDRESS,
            TOKEN_IN,
            TOKEN_OUT,
            AMOUNT,
            RECIPIENT
        );
        
        console.log(`\nExecution ${result ? 'successful ✅' : 'failed ❌'}`);
        
        process.exit(result ? 0 : 1);
    } catch (error) {
        console.error('Fatal error during execution:', error);
        process.exit(1);
    }
}

// Run the script
main();
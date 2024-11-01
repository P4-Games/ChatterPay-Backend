import { ethers } from 'ethers';
import { FastifyInstance } from 'fastify';

import entryPoint from '../utils/entryPoint.json';
import { getBlockchain } from './blockchainService';
import { generatePrivateKey } from '../utils/keyGenerator';
import { SIMPLE_SWAP_ADDRESS } from '../constants/contracts';
import { sendUserOperationToBundler } from './bundlerService';
import { waitForUserOperationReceipt } from '../utils/waitForTX';
import { setupERC20, setupContracts } from './contractSetupService';
import {
    addPaymasterData,
    ensurePaymasterHasPrefund
} from './paymasterService';
import { 
    signUserOperation, 
    createGenericUserOperation,
} from './userOperationService';

export interface TokenAddresses {
    input: string;
    output: string;
}

/**
 * Creates callData for token approval
 */
function createApproveCallData(
    chatterPay: ethers.Contract,
    tokenContract: ethers.Contract,
    spender: string,
    amount: string,
): string {
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    const approveEncode = tokenContract.interface.encodeFunctionData("approve", [spender, amount_bn]);
    console.log("Approve Encode:", approveEncode);

    const callData = chatterPay.interface.encodeFunctionData("execute", [
        tokenContract.address,
        0,
        approveEncode
    ]);
    console.log("Approve Call Data:", callData);

    return callData;
}

/**
 * Creates callData for swap execution
 */
function createSwapCallData(
    chatterPay: ethers.Contract,
    swapContract: ethers.Contract,
    isWETHtoUSDT: boolean,
    amount: string,
): string {
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    const swapEncode = swapContract.interface.encodeFunctionData(
        isWETHtoUSDT ? "swapWETHforUSDT" : "swapUSDTforWETH",
        [amount_bn]
    );
    console.log("Swap Encode:", swapEncode);

    const callData = chatterPay.interface.encodeFunctionData("execute", [
        swapContract.address,
        0,
        swapEncode
    ]);
    console.log("Swap Call Data:", callData);

    return callData;
}

/**
 * Helper function to check balances
 */
async function checkBalance(
    tokenContract: ethers.Contract, 
    proxyAddress: string, 
    amount: string
) {
    console.log("Token Address:", tokenContract.address);
    console.log(`Checking balance for ${proxyAddress}...`);
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    const balanceCheck = await tokenContract.balanceOf(proxyAddress);
    console.log(`Balance: ${ethers.utils.formatUnits(balanceCheck, 18)}`);
    if (balanceCheck.lt(amount_bn)) {
        throw new Error(
            `Insufficient balance. Required: ${amount}, Available: ${ethers.utils.formatUnits(balanceCheck, 18)}`,
        );
    }
}

/**
 * Executes a user operation with the given callData
 */
async function executeOperation(
    fastify: FastifyInstance,
    callData: string,
    signer: ethers.Wallet,
    backendSigner: ethers.Wallet, // Agregamos backendSigner como parámetro
    entrypoint: ethers.Contract,
    bundlerUrl: string,
    proxyAddress: string,
    provider: ethers.providers.JsonRpcProvider
): Promise<string> {
    // Get the nonce
    const nonce = await entrypoint.getNonce(proxyAddress, 0);
    console.log("Nonce:", nonce.toString());

    // Create the base user operation
    let userOperation = await createGenericUserOperation(
        callData,
        proxyAddress,
        nonce
    );
    
    // Add paymaster data - Usamos el backendSigner que recibimos como parámetro
    userOperation = await addPaymasterData(
        userOperation,
        fastify.networkConfig.contracts.paymasterAddress!,
        backendSigner
    );
    
    // Sign the user operation
    userOperation = await signUserOperation(
        userOperation, 
        fastify.networkConfig.contracts.entryPoint, 
        signer
    );

    // Send to bundler
    const bundlerResponse = await sendUserOperationToBundler(
        bundlerUrl, 
        userOperation, 
        entrypoint.address
    );

    // Wait for receipt
    const receipt = await waitForUserOperationReceipt(provider, bundlerResponse);
    if (!receipt?.success) {
        throw new Error("Transaction failed or not found");
    }

    return receipt.receipt.transactionHash;
}

/**
 * Main function to execute the swap operation
 */
export async function executeSwap(
    fastify: FastifyInstance,
    fromNumber: string,
    tokenAddresses: TokenAddresses,
    amount: string,
    chain_id: number,
    isWETHtoUSDT: boolean
): Promise<{ approveTransactionHash: string; swapTransactionHash: string }> {
    try {
        const blockchain = await getBlockchain(chain_id);
        const seedPrivateKey = process.env.PRIVATE_KEY;
        if (!seedPrivateKey) {
            throw new Error('Seed private key not found in environment variables');
        }

        const privateKey = generatePrivateKey(seedPrivateKey, fromNumber);
        const { provider, signer, backendSigner, bundlerUrl, chatterPay, proxy, accountExists } = 
            await setupContracts(blockchain, privateKey, fromNumber);
        const inputToken = await setupERC20(tokenAddresses.input, signer);
        
        console.log("Contracts and signers set up");

        await checkBalance(inputToken, proxy.proxyAddress, amount);
        console.log("Balance check passed");

        const { networkConfig } = fastify;
        const entrypoint = new ethers.Contract(networkConfig.contracts.entryPoint, entryPoint, backendSigner);
        
        await ensurePaymasterHasPrefund(entrypoint, networkConfig.contracts.paymasterAddress!)

        console.log("Validating account");
        if (!accountExists) {
            throw new Error(`Account ${proxy.proxyAddress} does not exist`);
        }

        // Create SimpleSwap contract instance
        const simpleSwap = new ethers.Contract(
            SIMPLE_SWAP_ADDRESS,
            [
                'function swapWETHforUSDT(uint256 wethAmount) external',
                'function swapUSDTforWETH(uint256 usdtAmount) external',
            ],
            provider
        );

        // 1. Execute approve operation
        console.log('Executing approve operation...');
        const approveCallData = createApproveCallData(
            chatterPay,
            inputToken,
            SIMPLE_SWAP_ADDRESS,
            amount
        );

        const approveHash = await executeOperation(
            fastify,
            approveCallData,
            signer,
            backendSigner, // Pasamos el backendSigner
            entrypoint,
            bundlerUrl,
            proxy.proxyAddress,
            provider
        );

        // 2. Execute swap operation
        console.log('Executing swap operation...');
        const swapCallData = createSwapCallData(
            chatterPay,
            simpleSwap,
            isWETHtoUSDT,
            amount
        );

        const swapHash = await executeOperation(
            fastify,
            swapCallData,
            signer,
            backendSigner, // Pasamos el backendSigner
            entrypoint,
            bundlerUrl,
            proxy.proxyAddress,
            provider
        );

        return {
            approveTransactionHash: approveHash,
            swapTransactionHash: swapHash
        };
    } catch (error) {
        console.error("Error in executeSwap:", error);
        throw error;
    }
}
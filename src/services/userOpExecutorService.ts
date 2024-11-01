import { ethers } from 'ethers';
import { FastifyInstance } from 'fastify';

import entryPoint from '../utils/entryPoint.json';
import { addPaymasterData } from './paymasterService';
import { sendUserOperationToBundler } from './bundlerService';
import { signUserOperation, createGenericUserOperation } from './userOperationService';
import { UserOperationReceiptData, waitForUserOperationReceipt } from '../utils/waitForTX';

declare module 'fastify' {
    interface FastifyInstance {
        backendSigner: ethers.Signer;
        provider: ethers.providers.JsonRpcProvider;
    }
}

/**
 * Creates, signs, sends and waits for a UserOperation in one go.
 * Uses the global Fastify context for network configuration and backend services.
 */
export async function executeUserOperation(
    fastify: FastifyInstance,
    callData: string,
    signer: ethers.Wallet,
    senderAddress: string,
): Promise<UserOperationReceiptData> {
    const { networkConfig, backendSigner, provider } = fastify;
    const entrypoint = new ethers.Contract(networkConfig.contracts.entryPoint, entryPoint, backendSigner);

    // Get the nonce
    const nonce = await entrypoint.getNonce(senderAddress, 0);
    console.log("Nonce:", nonce.toString());

    // Create, add paymaster and sign the UserOperation
    let userOperation = await createGenericUserOperation(
        callData,
        senderAddress,
        nonce
    );
    
    userOperation = await addPaymasterData(
        userOperation,
        networkConfig.contracts.paymasterAddress!,
        backendSigner
    );
    
    userOperation = await signUserOperation(
        userOperation, 
        networkConfig.contracts.entryPoint, 
        signer
    );

    // Send to bundler and wait for receipt
    console.log("Sending user operation to bundler");
    const bundlerResponse = await sendUserOperationToBundler(
        networkConfig.rpc, 
        userOperation, 
        networkConfig.contracts.entryPoint
    );
    console.log("Bundler response:", bundlerResponse);

    console.log("Waiting for transaction to be mined...");
    const receipt = await waitForUserOperationReceipt(provider, bundlerResponse);
    console.log("Transaction receipt:", JSON.stringify(receipt, null, 2));

    if (!receipt?.success) {
        throw new Error("Transaction failed or not found");
    }

    console.log("Transaction confirmed in block:", receipt.receipt.blockNumber);
    return receipt.receipt;
}
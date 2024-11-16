import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { User } from '../models/user';
import Transaction from '../models/transaction';
import entryPoint from '../utils/entryPoint.json';
import { generatePrivateKey } from '../utils/keyGenerator';
import { getBlockchain } from '../services/blockchainService';
import { waitForUserOperationReceipt } from '../utils/waitForTX';
import { setupContracts } from '../services/contractSetupService';
import { sendUserOperationToBundler } from '../services/bundlerService';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';
import { addPaymasterData, ensurePaymasterHasPrefund } from "../services/paymasterService"
import { signUserOperation, createGenericUserOperation } from '../services/userOperationService';

interface ContractCallInputs {
    channel_user_id: string;
    target_contract: string;
    calldata: string;
    value?: string;
    chain_id?: string;
}

/**
 * Validates the inputs for executing a contract call.
 */
const validateContractCallInputs = async (
    inputs: ContractCallInputs, 
    fastify: FastifyInstance
): Promise<string> => {
    const { channel_user_id, target_contract, calldata, chain_id } = inputs;
    const { networkConfig } = fastify;

    // Basic input validation
    if (!channel_user_id || !target_contract || !calldata) {
        return 'Missing required fields';
    }

    // Validate channel_user_id format
    if (channel_user_id.length > 15) {
        return 'Invalid phone number format';
    }

    // Validate target contract address
    if (!ethers.utils.isAddress(target_contract)) {
        return 'Invalid target contract address';
    }

    // Validate calldata format
    if (!calldata.startsWith('0x')) {
        return 'Invalid calldata format';
    }

    // Validate chain_id if provided
    const targetChainId = chain_id ? parseInt(chain_id, 10) : networkConfig.chain_id;
    if (targetChainId !== networkConfig.chain_id) {
        return 'Selected blockchain is not currently available';
    }

    return '';
};

/**
 * Executes a generic contract call with the provided calldata.
 */
async function processContractCall(
    fastify: FastifyInstance,
    fromNumber: string,
    targetContract: string,
    calldata: string,
    chain_id: number,
    value: string = "0",
): Promise<{ transactionHash: string }> {
    try {
        const blockchain = await getBlockchain(chain_id);
        const seedPrivateKey = process.env.PRIVATE_KEY;
        if (!seedPrivateKey) {
            throw new Error('Seed private key not found in environment variables');
        }

        // Setup contracts and signers
        const privateKey = generatePrivateKey(seedPrivateKey, fromNumber);
        const { provider, signer, backendSigner, bundlerUrl, chatterPay, proxy, accountExists } = 
            await setupContracts(blockchain, privateKey, fromNumber);

        // Validate account exists
        if (!accountExists) {
            throw new Error(`Account ${proxy.proxyAddress} does not exist`);
        }

        // Ensure signer has enough ETH for gas
        const EOABalance = await provider.getBalance(await signer.getAddress());
        if (EOABalance.lt(ethers.utils.parseEther('0.0008'))) {
            const tx = await backendSigner.sendTransaction({
                to: await signer.getAddress(),
                value: ethers.utils.parseEther('0.001'),
                gasLimit: 210000,
                maxPriorityFeePerGas: ethers.utils.parseUnits('40', 'gwei'),
            });
            await tx.wait();
        }

        // Setup entry point contract
        const { networkConfig } = fastify;
        const entrypoint = new ethers.Contract(
            networkConfig.contracts.entryPoint, 
            entryPoint, 
            backendSigner
        );

        // Ensure paymaster has enough funds
        await ensurePaymasterHasPrefund(entrypoint, networkConfig.contracts.paymasterAddress!);

        // Create execute calldata
        const executeCallData = chatterPay.interface.encodeFunctionData("execute", [
            targetContract,
            value,
            calldata
        ]);

        // Create and prepare user operation
        const nonce = await entrypoint.getNonce(proxy.proxyAddress, 0);
        let userOperation = await createGenericUserOperation(
            executeCallData,
            proxy.proxyAddress,
            nonce
        );

        // Add paymaster data
        userOperation = await addPaymasterData(
            userOperation,
            networkConfig.contracts.paymasterAddress!,
            backendSigner
        );

        // Sign the user operation
        userOperation = await signUserOperation(
            userOperation,
            networkConfig.contracts.entryPoint,
            signer
        );

        // Send to bundler and wait for receipt
        const bundlerResponse = await sendUserOperationToBundler(
            bundlerUrl,
            userOperation,
            entrypoint.address
        );

        const receipt = await waitForUserOperationReceipt(provider, bundlerResponse);
        if (!receipt?.success) {
            throw new Error("Transaction failed or not found");
        }

        return { transactionHash: receipt.receipt.transactionHash };
    } catch (error) {
        console.error("Error in processContractCall:", error);
        throw error;
    }
}

/**
 * Handles the contract call request.
 */
export const executeContractCall = async (
    request: FastifyRequest<{ Body: ContractCallInputs }>,
    reply: FastifyReply,
) => {
    try {
        const { channel_user_id, target_contract, calldata, value, chain_id } = request.body;
        const { networkConfig } = request.server;

        // Validate inputs
        const validationError = await validateContractCallInputs(request.body, request.server);
        if (validationError) {
            return await returnErrorResponse(reply, 400, 'Error executing contract call', validationError);
        }

        // Check if user exists
        const user = await User.findOne({ phone_number: channel_user_id });
        if (!user) {
            return await returnErrorResponse(
                reply, 
                400, 
                'Error executing contract call', 
                'User not found. You must have an account to execute transactions'
            );
        }

        // Execute the contract call
        const result = await processContractCall(
            request.server,
            channel_user_id,
            target_contract,
            calldata,
            chain_id ? parseInt(chain_id, 10) : networkConfig.chain_id,
            value
        );

        // Create transaction record
        await Transaction.create({
            trx_hash: result.transactionHash,
            wallet_from: user.wallet,
            wallet_to: target_contract,
            type: 'contract_call',
            date: new Date(),
            status: 'completed',
            value: value || '0',
            data: calldata,
        });

        return await returnSuccessResponse(
            reply,
            "Contract call is being processed, it may take a few minutes...",
            { transactionHash: result.transactionHash }
        );
    } catch (error) {
        console.error('Error executing contract call:', error);
        return returnErrorResponse(
            reply,
            400,
            'Error executing contract call',
            (error as Error).message
        );
    }
};
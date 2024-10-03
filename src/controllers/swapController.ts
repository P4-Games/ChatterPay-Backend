import { ethers } from 'ethers';
import * as crypto from 'crypto';
import { FastifyReply, FastifyRequest } from 'fastify';

import Transaction from '../models/transaction';
import { authenticate } from './transactionController';
import { getChatterPayWalletABI, getERC20ABI } from '../services/bucketService';
import { sendSwapNotification } from './replyController';
import { getDynamicGas_callData } from '../utils/dynamicGas';
import { getNetworkConfig } from '../services/networkService';
import { ensureSignerHasEth } from '../services/walletService';
import { computeProxyAddressFromPhone } from '../services/predictWalletService';
import { WETH_ADDRESS, USDT_ADDRESS, SIMPLE_SWAP_ADDRESS } from '../constants/contracts';

interface SwapBody {
    channel_user_id: string;
    inputCurrency: string;
    outputCurrency: string;
    amount: number;
}

interface SwapResult {
    approveTransactionHash: string;
    swapTransactionHash: string;
}

/**
 * Validates the input for the swap operation.
 * @param inputs The swap inputs to validate.
 * @returns An error message if validation fails, or an empty string if validation succeeds.
 */
const validateInputs = (inputs: SwapBody): string => {
    const { channel_user_id, inputCurrency, outputCurrency, amount } = inputs;

    if (!channel_user_id || !inputCurrency || !outputCurrency) {
        return 'Missing required fields: address, inputCurrency, or outputCurrency';
    }

    if (channel_user_id.length > 15) {
        return 'El número de telefono no es válido';
    }

    if (inputCurrency === outputCurrency) {
        return 'Input and output currencies must be different';
    }

    if (amount === undefined || amount <= 0) {
        return 'Amount must be provided and greater than 0';
    }

    return '';
};

/**
 * Executes the swap operation.
 * @param simpleSwap The SimpleSwap contract instance.
 * @param isWETHtoUSDT Whether the swap is from WETH to USDT.
 * @param amount The amount to swap.
 * @param proxyAddress The proxy address to use for the swap.
 * @param signer The signer to use for transactions.
 * @returns An object containing the approve and swap transaction hashes.
 */
async function executeSwap(
    simpleSwap: ethers.Contract,
    isWETHtoUSDT: boolean,
    amount: string,
    proxyAddress: string,
    signer: ethers.Wallet,
): Promise<SwapResult> {
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    const tokenAddress = isWETHtoUSDT ? WETH_ADDRESS : USDT_ADDRESS;
    const erc20abi = await getERC20ABI();
    const tokenContract = new ethers.Contract(tokenAddress, erc20abi, signer);
    const chatterpayWalletAbi = await getChatterPayWalletABI();
    const chatterPay = new ethers.Contract(proxyAddress, chatterpayWalletAbi, signer);
    const provider = signer.provider!;

    try {
        // 1. Approve tokens
        console.log(`Approving ${isWETHtoUSDT ? 'WETH' : 'USDT'} for swap...`);
        const approveEncode = tokenContract.interface.encodeFunctionData('approve', [
            SIMPLE_SWAP_ADDRESS,
            amount_bn,
        ]);
        const approveCallData = chatterPay.interface.encodeFunctionData('execute', [
            tokenAddress,
            0,
            approveEncode,
        ]);
        const approveTx = await signer.sendTransaction({
            to: proxyAddress,
            data: approveCallData,
            gasLimit: await getDynamicGas_callData(provider, tokenAddress, approveEncode),
        });
        await approveTx.wait();
        console.log('Approval transaction confirmed');

        // 2. Execute swap
        console.log(`Swapping ${isWETHtoUSDT ? 'WETH for USDT' : 'USDT for WETH'}...`);
        const swapEncode = simpleSwap.interface.encodeFunctionData(
            isWETHtoUSDT ? 'swapWETHforUSDT' : 'swapUSDTforWETH',
            [amount_bn],
        );
        const swapCallData = chatterPay.interface.encodeFunctionData('execute', [
            SIMPLE_SWAP_ADDRESS,
            0,
            swapEncode,
        ]);

        const swapTx = await signer.sendTransaction({
            to: proxyAddress,
            data: swapCallData,
            gasLimit: await getDynamicGas_callData(provider, proxyAddress, swapEncode),
        });
        const receipt = await swapTx.wait();
        console.log(`Swap transaction confirmed in block ${receipt.blockNumber}`);

        return {
            approveTransactionHash: approveTx.hash,
            swapTransactionHash: receipt.transactionHash,
        };
    } catch (error) {
        console.error('Error in swap process:', error);
        throw error;
    }
}

/**
 * Generates a deterministic wallet for a user.
 * @param channel_user_id The user's channel ID.
 * @returns An object containing the signer and proxy address.
 */
async function generateUserWallet(channel_user_id: string) {
    const seedPrivateKey = process.env.PRIVATE_KEY;
    if (!seedPrivateKey) {
        throw new Error('Seed private key not found in environment variables');
    }

    const seed = seedPrivateKey + channel_user_id;
    const privateKey = `0x${crypto.createHash('sha256').update(seed).digest('hex')}`;

    const networkConfig = await getNetworkConfig();
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
    const signer = new ethers.Wallet(privateKey, provider);
    const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);

    await ensureSignerHasEth(signer, backendSigner, provider);

    const proxy = await computeProxyAddressFromPhone(channel_user_id);

    return { signer, proxyAddress: proxy.proxyAddress };
}

/**
 * Saves the transaction details to the database.
 * @param tx The transaction details.
 * @param walletFrom The sender's wallet address.
 * @param walletTo The recipient's wallet address.
 * @param amount The transaction amount.
 * @param currency The currency of the transaction.
 */
async function saveTransaction(
    tx: string,
    walletFrom: string,
    walletTo: string,
    amount: number,
    currency: string,
) {
    await Transaction.create({
        trx_hash: tx,
        wallet_from: walletFrom,
        wallet_to: walletTo,
        type: 'transfer',
        date: new Date(),
        status: 'completed',
        amount,
        token: currency,
    });
}

/**
 * Handles the swap operation.
 * @param request The FastifyRequest object containing the swap details.
 * @param reply The FastifyReply object for sending the response.
 */
export const swap = async (request: FastifyRequest<{ Body: SwapBody }>, reply: FastifyReply) => {
    try {
        // Authenticate the request
        authenticate(request);

        // Extract swap details from request body
        const { channel_user_id, inputCurrency, outputCurrency, amount } = request.body;

        // Validate inputs
        const validationError = validateInputs(request.body);
        if (validationError) {
            return await reply.status(400).send({ message: validationError });
        }

        // Send initial response to client
        reply
            .status(200)
            .send({ message: 'Intercambio de monedas en progreso, puede tardar unos minutos...' });

        // Generate user wallet
        const { signer, proxyAddress } = await generateUserWallet(channel_user_id);

        console.log('Wallet of the signer: ', await signer.getAddress());

        // Create SimpleSwap contract instance (Custom demo contract for swapping between these two tokens)
        const simpleSwap = new ethers.Contract(
            SIMPLE_SWAP_ADDRESS,
            [
                'function swapWETHforUSDT(uint256 wethAmount) external',
                'function swapUSDTforWETH(uint256 usdtAmount) external',
            ],
            signer,
        );

        // Determine swap direction and prepare input amount
        const isWETHtoUSDT =
            inputCurrency.toUpperCase() === 'WETH' && outputCurrency.toUpperCase() === 'USDT';
        const inputAmount = amount.toString();

        // Create ERC20 contract instance for balance checks
        const erc20 = new ethers.Contract(
            isWETHtoUSDT ? WETH_ADDRESS : USDT_ADDRESS,
            ['function balanceOf(address owner) view returns (uint256)'],
            signer,
        );

        // Check initial balance
        const initialBalance = await erc20.balanceOf(proxyAddress);
        console.log(
            `User initial balance of ${inputCurrency}: ${ethers.utils.formatUnits(initialBalance, 18)}`,
        );

        // Execute swap
        const tx = await executeSwap(simpleSwap, isWETHtoUSDT, inputAmount, proxyAddress, signer);

        // Check final balance
        const finalBalance = await erc20.balanceOf(proxyAddress);
        console.log(
            `User final balance of ${outputCurrency}: ${ethers.utils.formatUnits(finalBalance, 18)}`,
        );

        // Calculate swap result
        const result = ethers.utils.formatUnits(finalBalance.sub(initialBalance), 18);

        // Send swap notification
        await sendSwapNotification(
            channel_user_id,
            inputCurrency,
            amount.toString(),
            result,
            outputCurrency,
            tx.swapTransactionHash,
        );

        // Save transactions
        await saveTransaction(
            tx.approveTransactionHash,
            proxyAddress,
            SIMPLE_SWAP_ADDRESS,
            parseFloat(inputAmount),
            inputCurrency,
        );
        await saveTransaction(
            tx.swapTransactionHash,
            SIMPLE_SWAP_ADDRESS,
            proxyAddress,
            parseFloat(result),
            outputCurrency,
        );

        // Return success response
        return await reply.status(200).send({
            message: 'Swap completed successfully',
            approveTransactionHash: tx.approveTransactionHash,
            swapTransactionHash: tx.swapTransactionHash,
        });
    } catch (error) {
        // Handle errors
        console.error('Error swapping tokens:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

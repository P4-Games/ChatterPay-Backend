import { ethers } from 'ethers';
import * as crypto from 'crypto';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import Transaction from '../models/transaction';
import chatterPayABI from '../utils/chatterPayABI.json';
import { sendSwapNotification } from './replyController';
import { getDynamicGas_callData } from '../utils/dynamicGas';
import { SIMPLE_SWAP_ADDRESS } from '../constants/contracts';
import { ensureSignerHasEth } from '../services/transferService';
import { PRIVATE_KEY, SIGNING_KEY } from '../constants/environment';
import { computeProxyAddressFromPhone } from '../services/predictWalletService';

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

interface TokenAddresses {
    input: string;
    output: string;
}

/**
 * Gets token addresses from the decorator based on symbols
 */
function getTokenAddresses(
    fastify: FastifyInstance,
    inputCurrency: string,
    outputCurrency: string
): TokenAddresses {
    const { tokens, networkConfig } = fastify;
    const chainTokens = tokens.filter(token => token.chain_id === networkConfig.chain_id);

    const inputToken = chainTokens.find(
        t => t.symbol.toLowerCase() === inputCurrency.toLowerCase()
    );
    const outputToken = chainTokens.find(
        t => t.symbol.toLowerCase() === outputCurrency.toLowerCase()
    );

    if (!inputToken || !outputToken) {
        throw new Error('Invalid token symbols for the current network');
    }

    return {
        input: inputToken.address,
        output: outputToken.address
    };
}

/**
 * Validates the input for the swap operation.
 */
const validateInputs = async (
    inputs: SwapBody,
    fastify: FastifyInstance
): Promise<string> => {
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

    // Validate tokens exist in current network
    try {
        getTokenAddresses(fastify, inputCurrency, outputCurrency);
    } catch (error) {
        return 'Invalid token symbols for the current network';
    }

    return '';
};

/**
 * Executes the swap operation.
 */
async function executeSwap(
    simpleSwap: ethers.Contract,
    isWETHtoUSDT: boolean,
    amount: string,
    proxyAddress: string,
    signer: ethers.Wallet,
    tokenAddresses: TokenAddresses,
): Promise<SwapResult> {
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    const tokenAddress = isWETHtoUSDT ? tokenAddresses.input : tokenAddresses.output;
    const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function approve(address spender, uint256 amount) public returns (bool)'],
        signer,
    );
    const chatterPay = new ethers.Contract(proxyAddress, chatterPayABI, signer);
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
 */
async function generateUserWallet(channel_user_id: string, fastify: FastifyInstance) {
    if (!PRIVATE_KEY) {
        throw new Error('Seed private key not found in environment variables');
    }

    const seed = PRIVATE_KEY + channel_user_id;
    const privateKey = `0x${crypto.createHash('sha256').update(seed).digest('hex')}`;

    const { networkConfig } = fastify;
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
    const signer = new ethers.Wallet(privateKey, provider);
    const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);

    await ensureSignerHasEth(signer, backendSigner, provider);

    const proxy = await computeProxyAddressFromPhone(channel_user_id);

    return { signer, proxyAddress: proxy.proxyAddress };
}

/**
 * Saves the transaction details to the database.
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
 */
export const swap = async (request: FastifyRequest<{ Body: SwapBody }>, reply: FastifyReply) => {
    try {
        const { channel_user_id, inputCurrency, outputCurrency, amount } = request.body;

        // Validate inputs
        const validationError = await validateInputs(request.body, request.server);
        if (validationError) {
            return await reply.status(400).send({ message: validationError });
        }

        // Send initial response to client
        reply
            .status(200)
            .send({ message: 'Intercambio de monedas en progreso, puede tardar unos minutos...' });

        // Get token addresses from decorator
        const tokenAddresses = getTokenAddresses(request.server, inputCurrency, outputCurrency);

        // Generate user wallet
        const { signer, proxyAddress } = await generateUserWallet(channel_user_id, request.server);

        console.log('Wallet of the signer: ', await signer.getAddress());

        // Create SimpleSwap contract instance
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
            isWETHtoUSDT ? tokenAddresses.input : tokenAddresses.output,
            ['function balanceOf(address owner) view returns (uint256)'],
            signer,
        );

        // Check initial balance
        const initialBalance = await erc20.balanceOf(proxyAddress);
        console.log(
            `User initial balance of ${inputCurrency}: ${ethers.utils.formatUnits(initialBalance, 18)}`,
        );

        // Execute swap
        const tx = await executeSwap(
            simpleSwap, 
            isWETHtoUSDT, 
            inputAmount, 
            proxyAddress, 
            signer,
            tokenAddresses
        );

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

        return await reply.status(200).send({
            message: 'Swap completed successfully',
            approveTransactionHash: tx.approveTransactionHash,
            swapTransactionHash: tx.swapTransactionHash,
        });
    } catch (error) {
        console.error('Error swapping tokens:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
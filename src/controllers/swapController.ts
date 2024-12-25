import { ethers } from 'ethers';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { SIMPLE_SWAP_ADDRESS } from '../constants/contracts';
import { SIGNING_KEY } from '../constants/environment';
import Transaction from '../models/transaction';
import { computeProxyAddressFromPhone } from '../services/predictWalletService';
import { executeSwap } from '../services/swapService';
import { sendSwapNotification } from '../services/notificationService';

interface SwapBody {
    channel_user_id: string;
    user_wallet: string;
    inputCurrency: string;
    outputCurrency: string;
    amount: number;
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
        const { channel_user_id, user_wallet, inputCurrency, outputCurrency, amount } = request.body;

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

        // Determine swap direction
        const isWETHtoUSDT =
            inputCurrency.toUpperCase() === 'WETH' && outputCurrency.toUpperCase() === 'USDT';

        // Execute swap
        const tx = await executeSwap(
            request.server,
            channel_user_id,
            tokenAddresses,
            amount.toString(),
            request.server.networkConfig.chain_id,
            isWETHtoUSDT
        );


        const { networkConfig } = request.server;
        const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
        const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);

        // Create ERC20 contract for balance check
        const outputToken = new ethers.Contract(
            tokenAddresses.output,
            ['function balanceOf(address owner) view returns (uint256)'],
            backendSigner
        );

        const { proxyAddress } = await computeProxyAddressFromPhone(channel_user_id);
        const finalBalance = await outputToken.balanceOf(proxyAddress);
        const initialOutputBalance = await outputToken.balanceOf(proxyAddress);
        const result = ethers.utils.formatUnits(finalBalance.sub(initialOutputBalance), 18);

        // Send notifications
        await sendSwapNotification(
            user_wallet,
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
            amount,
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
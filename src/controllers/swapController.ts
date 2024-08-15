import { FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "./transactionController";
import { ethers } from "ethers";
import { WETH_ADDRESS, USDT_ADDRESS, SIMPLE_SWAP_ADDRESS } from "../constants/contracts";
import { SCROLL_CONFIG } from "../constants/networks";
import * as crypto from 'crypto';

interface SwapBody {
    channel_user_id: string;
    inputCurrency: string;
    outputCurrency: string;
    amount: number;
}

const validateInputs = (inputs: SwapBody): string => {
    const { channel_user_id, inputCurrency, outputCurrency, amount } = inputs;

    if (!channel_user_id || !inputCurrency || !outputCurrency) {
        return "Missing required fields: address, inputCurrency, or outputCurrency";
    }

    if (channel_user_id.length > 15) {
        return "El número de telefono no es válido";
    }

    if (inputCurrency === outputCurrency) {
        return "Input and output currencies must be different";
    }

    if (amount === undefined) {
        return "Either inputAmount or outputAmount must be provided";
    }

    if (amount !== undefined && amount <= 0) {
        return "Amount must be greater than 0";
    }

    return "";
};

export const swap = async (
    request: FastifyRequest<{ Body: SwapBody }>,
    reply: FastifyReply
) => {
    try {
        authenticate(request);

        const { channel_user_id, inputCurrency, outputCurrency, amount } = request.body;

        const validationError = validateInputs(request.body);
        if (validationError) {
            return reply.status(400).send({ message: validationError });
        }

        // Generate a deterministic wallet from the user's address
        const seedPrivateKey = process.env.PRIVATE_KEY;
        if (!seedPrivateKey) {
            throw new Error('Seed private key not found in environment variables');
        }

        // Create a deterministic seed for generating the wallet
        const seed = seedPrivateKey + channel_user_id;

        // Generate a deterministic private key
        const privateKey = '0x' + crypto.createHash('sha256').update(seed).digest('hex');

        // 1. Connect to the contracts
        const provider = new ethers.providers.JsonRpcProvider(SCROLL_CONFIG.RPC_URL);
        const signer = new ethers.Wallet(privateKey, provider);

        const weth = new ethers.Contract(WETH_ADDRESS, ["function approve(address spender, uint256 amount) public returns (bool)"], signer);
        const usdt = new ethers.Contract(USDT_ADDRESS, ["function approve(address spender, uint256 amount) public returns (bool)"], signer);
        const simpleSwap = new ethers.Contract(SIMPLE_SWAP_ADDRESS, [
            "function swapWETHforUSDT(uint256 wethAmount) external",
            "function swapUSDTforWETH(uint256 usdtAmount) external"
        ], signer);

        // 2. Determine swap direction and amount
        const isWETHtoUSDT = inputCurrency.toUpperCase() === "WETH" && outputCurrency.toUpperCase() === "USDT";
        const inputAmount = ethers.utils.parseEther(amount?.toString());

        // 3. Approve token transfer
        if (isWETHtoUSDT) {
            const wethApproval = await weth.approve(SIMPLE_SWAP_ADDRESS, inputAmount);
            await wethApproval.wait();
        } else {
            const usdtApproval = await usdt.approve(SIMPLE_SWAP_ADDRESS, inputAmount);
            await usdtApproval.wait();
        }

        // 4. Execute swap
        let tx;
        if (isWETHtoUSDT) {
            tx = await simpleSwap.swapWETHforUSDT(inputAmount);
        } else {
            tx = await simpleSwap.swapUSDTforWETH(inputAmount);
        }

        // 5. Wait for transaction confirmation
        await tx.wait();

        reply.status(200).send({ message: "Swap completed successfully", transactionHash: tx.hash });
    } catch (error) {
        console.error("Error swapping tokens:", error);
        return reply.status(500).send({ message: "Internal Server Error" });
    }
};
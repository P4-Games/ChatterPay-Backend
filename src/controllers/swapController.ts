import { FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "./transactionController";
import { ethers } from "ethers";
import { WETH_ADDRESS, USDT_ADDRESS, SIMPLE_SWAP_ADDRESS } from "../constants/contracts";
import { SCROLL_CONFIG } from "../constants/networks";
import * as crypto from 'crypto';
import chatterPayABI from "../chatterPayABI.json";
import { ensureSignerHasEth } from "../services/walletService";
import { computeProxyAddressFromPhone } from "../services/predictWalletService";
import { sendSwapNotification, sendTransferNotification } from "./replyController";

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

async function executeSwap(
    simpleSwap: ethers.Contract,
    isWETHtoUSDT: boolean,
    amount: string,
    proxyAddress: string,
    signer: ethers.Wallet
) {
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    const tokenAddress = isWETHtoUSDT ? WETH_ADDRESS : USDT_ADDRESS;
    const tokenContract = new ethers.Contract(tokenAddress, [
        "function approve(address spender, uint256 amount) public returns (bool)"
    ], signer);
    const chatterPay = new ethers.Contract(proxyAddress, chatterPayABI, signer);

    try {
        // 1. Approve tokens
        console.log(`Approving ${isWETHtoUSDT ? "WETH" : "USDT"} for swap...`);
        const approveEncode = tokenContract.interface.encodeFunctionData("approve", [SIMPLE_SWAP_ADDRESS, amount_bn]);
        const approveCallData = chatterPay.interface.encodeFunctionData("execute", [tokenAddress, 0, approveEncode]);
        const approveTx = await signer.sendTransaction({
            to: proxyAddress,
            data: approveCallData,
            gasLimit: 300000,
        });
        await approveTx.wait();
        console.log("Approval transaction confirmed");

        // 2. Execute swap
        console.log(`Swapping ${isWETHtoUSDT ? "WETH for USDT" : "USDT for WETH"}...`);
        let swapEncode;
        if (isWETHtoUSDT) {
            swapEncode = simpleSwap.interface.encodeFunctionData("swapWETHforUSDT", [amount_bn]);
        } else {
            swapEncode = simpleSwap.interface.encodeFunctionData("swapUSDTforWETH", [amount_bn]);
        }  
        const swapCallData = chatterPay.interface.encodeFunctionData("execute", [SIMPLE_SWAP_ADDRESS, 0, swapEncode]);

        const swapTx = await signer.sendTransaction({
            to: proxyAddress,
            data: swapCallData,
            gasLimit: 500000,
        });
        const receipt = await swapTx.wait();
        console.log(`Swap transaction confirmed in block ${receipt.blockNumber}`);
        return { 
            approveTransactionHash: approveTx.hash,
            swapTransactionHash: receipt.transactionHash 
        };
    } catch (error) {
        console.error('Error in swap process:', error);
        throw error;
    }
}

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

        reply.status(200).send({ message: "Intercambio de monedas en progreso, puede tardar unos minutos..." });

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
        const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);

        await ensureSignerHasEth(signer, backendSigner, provider);

        const proxy = await computeProxyAddressFromPhone(channel_user_id);

        const simpleSwap = new ethers.Contract(SIMPLE_SWAP_ADDRESS, [
            "function swapWETHforUSDT(uint256 wethAmount) external",
            "function swapUSDTforWETH(uint256 usdtAmount) external"
        ], signer);

        console.log("Wallet of the signer: ", await signer.getAddress());
        
        // 2. Determine swap direction and amount
        const isWETHtoUSDT = inputCurrency.toUpperCase() === "WETH" && outputCurrency.toUpperCase() === "USDT";
        const inputAmount = amount.toString();

        // 3. Execute approval and swap
        const erc20 = new ethers.Contract(outputCurrency === "WETH" ? WETH_ADDRESS : USDT_ADDRESS, [
            'function balanceOf(address owner) view returns (uint256)',
        ], signer);

        const balance = await erc20.balanceOf(proxy.proxyAddress);
        console.log(`User balance of ${inputCurrency}: ${ethers.utils.formatUnits(balance, 18)}`);

        const tx = await executeSwap(simpleSwap, isWETHtoUSDT, inputAmount, proxy.proxyAddress, signer);

        reply.status(200).send({ 
            message: "Swap completed successfully", 
            approveTransactionHash: tx.approveTransactionHash,
            swapTransactionHash: tx.swapTransactionHash 
        });

        //Check user balance of the output currency
        const outputBalance = await erc20.balanceOf(proxy.proxyAddress);
        console.log(`User balance of ${outputCurrency}: ${ethers.utils.formatUnits(outputBalance, 18)}`);

        //Calculate difference between input and output balances
        const result = ethers.utils.formatUnits(outputBalance.sub(balance), 18);

        sendSwapNotification(channel_user_id, inputCurrency, amount.toString(), result, outputCurrency, tx.swapTransactionHash)
    } catch (error) {
        console.error("Error swapping tokens:", error);
        return reply.status(500).send({ message: "Internal Server Error" });
    }
};
import axios from 'axios';
import * as crypto from 'crypto';
import { ethers, BigNumber } from 'ethers';

import entryPoint from '../utils/entryPoint.json';
import { getNetworkConfig } from './networkService';
import chatterPayABI from '../utils/chatterPayABI.json';
import Blockchain, { IBlockchain } from '../models/blockchain';
import { waitForUserOperationReceipt } from '../utils/waitForTX';
import { getBundlerUrl, validateBundlerUrl } from '../utils/bundler';
import { computeProxyAddressFromPhone } from './predictWalletService';

interface PackedUserOperation {
    sender: string;
    nonce: BigNumber;
    initCode: string;
    callData: string;
    callGasLimit: BigNumber;
    verificationGasLimit: BigNumber;
    preVerificationGas: BigNumber;
    maxFeePerGas: BigNumber;
    maxPriorityFeePerGas: BigNumber;
    paymasterAndData: string;
    signature: string;
}

async function getBlockchain(chain_id: number): Promise<IBlockchain> {
    const blockchain: IBlockchain | null = await Blockchain.findOne({ chain_id });
    if (!blockchain) {
        throw new Error(`Blockchain with chain_id ${chain_id} not found`);
    }
    return blockchain;
}

function generatePrivateKey(seedPrivateKey: string, fromNumber: string): string {
    const seed = seedPrivateKey + fromNumber;
    return `0x${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

async function setupContracts(blockchain: IBlockchain, privateKey: string, fromNumber: string) {
    const bundlerUrl = getBundlerUrl(blockchain.chain_id);
    if (!bundlerUrl) {
        throw new Error(`Unsupported chain ID: ${blockchain.chain_id}`);
    }

    const isValidBundler = await validateBundlerUrl(bundlerUrl);
    if (!isValidBundler) {
        throw new Error(`Invalid or unreachable bundler URL: ${bundlerUrl}`);
    }

    const network = await getNetworkConfig(421614);
    const provider = new ethers.providers.JsonRpcProvider(network.rpc);
    const signer = new ethers.Wallet(privateKey, provider);
    const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);
    const proxy = await computeProxyAddressFromPhone(fromNumber);
    const accountExists = true;

    const chatterPay = new ethers.Contract(proxy.proxyAddress, chatterPayABI, signer);

    return { provider, signer, backendSigner, bundlerUrl, chatterPay, proxy, accountExists };
}

async function createUserOperation(
    entrypoint: ethers.Contract,
    chatterPay: ethers.Contract,
    to: string,
    proxyAddress: string,
): Promise<PackedUserOperation> {
    const amount = ethers.utils.parseEther("0.0001");
    const transferCallData = chatterPay.interface.encodeFunctionData("execute", [to, amount, "0x"]);
    
    const nonce = await entrypoint.getNonce(proxyAddress, 0);
    
    const verificationGasLimit = BigNumber.from(200000);
    const callGasLimit = BigNumber.from(600000);
    const preVerificationGas = BigNumber.from(200000); 
    const maxFeePerGas = BigNumber.from(ethers.utils.parseUnits("10", "gwei"));
    const maxPriorityFeePerGas = BigNumber.from(ethers.utils.parseUnits("1", "gwei"));

    return {
        sender: proxyAddress,
        nonce,
        initCode: "0x",
        callData: transferCallData,
        callGasLimit,
        verificationGasLimit,
        preVerificationGas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        paymasterAndData: "0x",
        signature: "0x",
    };
}

async function calculatePrefund(userOp: PackedUserOperation): Promise<BigNumber> {
    const requiredGas = userOp.verificationGasLimit
        .add(userOp.callGasLimit)
        .add(userOp.preVerificationGas);

    return requiredGas.mul(userOp.maxFeePerGas);
}

async function ensureAccountHasPrefund(
    entrypoint: ethers.Contract,
    userOp: PackedUserOperation,
    signer: ethers.Wallet
): Promise<void> {
    const prefund = await calculatePrefund(userOp);
    const balance = await entrypoint.balanceOf(userOp.sender);
    
    if (balance.lt(prefund)) {
        const missingFunds = prefund.sub(balance);
        const tx = await entrypoint.depositTo(userOp.sender, { value: missingFunds });
        await tx.wait();
    }
}

async function signUserOperation(
    userOperation: PackedUserOperation,
    entryPointAddress: string,
    signer: ethers.Wallet
): Promise<PackedUserOperation> {
    const chainId = await signer.getChainId();
    const userOpHash = getUserOpHash(userOperation, entryPointAddress, chainId);
    const signature = await signer.signMessage(ethers.utils.arrayify(userOpHash));
    return { ...userOperation, signature };
}

export async function sendUserOperation(
    from: string,
    fromNumber: string,
    to: string,
    tokenAddress: string,
    amount: string,
    chain_id: number
): Promise<{ transactionHash: string; }> {
    try {
        const blockchain = await getBlockchain(chain_id);
        const seedPrivateKey = process.env.PRIVATE_KEY;
        if (!seedPrivateKey) {
            throw new Error('Seed private key not found in environment variables');
        }

        const privateKey = generatePrivateKey(seedPrivateKey, fromNumber);
        const { provider, signer, backendSigner, bundlerUrl, chatterPay, proxy, accountExists } = await setupContracts(blockchain, privateKey, fromNumber);

        const networkConfig = await getNetworkConfig();
        const entrypoint = new ethers.Contract(networkConfig.contracts.entryPoint, entryPoint, backendSigner);

        if (!accountExists) {
            throw new Error(`Account ${proxy.proxyAddress} does not exist. Cannot proceed with transfer.`);
        }

        let userOperation = await createUserOperation(entrypoint, chatterPay, to, proxy.proxyAddress);
        userOperation = await signUserOperation(userOperation, networkConfig.contracts.entryPoint, signer);

        await ensureAccountHasPrefund(entrypoint, userOperation, backendSigner);

        const bundlerResponse = await sendUserOperationToBundler(bundlerUrl, userOperation, entrypoint.address);
        
        const receipt = await waitForUserOperationReceipt(provider, bundlerResponse);

        if (!receipt || !receipt.success) {
            throw new Error("Transaction failed or not found");
        }

        return { transactionHash: receipt.receipt.transactionHash };
    } catch (error) {
        console.error("Error in sendUserOperation:", error);
        throw error;
    }
}

async function sendUserOperationToBundler(
    bundlerUrl: string,
    userOperation: PackedUserOperation,
    entryPointAddress: string
): Promise<string> {
    const serializedUserOp = serializeUserOperation(userOperation);
    const payload = {
        jsonrpc: '2.0',
        method: 'eth_sendUserOperation',
        params: [serializedUserOp, entryPointAddress],
        id: Date.now(),
    };

    const response = await axios.post(bundlerUrl, payload, {
        headers: {
            'Content-Type': 'application/json',
        },
    });

    if (response.data.error) {
        throw new Error(`Bundler Error: ${response.data.error.message}`);
    }

    if (!response.data.result) {
        throw new Error('Bundler did not return a result');
    }

    return response.data.result as string;
}

function packUserOp(userOp: PackedUserOperation): string {
    const types = [
        "address", "uint256", "bytes32", "bytes32", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes32"
    ];
    const values = [
        userOp.sender,
        userOp.nonce,
        ethers.utils.keccak256(userOp.initCode),
        ethers.utils.keccak256(userOp.callData),
        userOp.callGasLimit,
        userOp.verificationGasLimit,
        userOp.preVerificationGas,
        userOp.maxFeePerGas,
        userOp.maxPriorityFeePerGas,
        ethers.utils.keccak256(userOp.paymasterAndData)
    ];
    return ethers.utils.defaultAbiCoder.encode(types, values);
}

function hashUserOp(userOp: PackedUserOperation): string {
    return ethers.utils.keccak256(packUserOp(userOp));
}

function getUserOpHash(userOp: PackedUserOperation, entryPointAddress: string, chainId: number): string {
    const userOpHash = hashUserOp(userOp);
    const encoded = ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "address", "uint256"],
        [userOpHash, entryPointAddress, chainId]
    );
    return ethers.utils.keccak256(encoded);
}

function serializeUserOperation(userOp: PackedUserOperation): Record<string, string> {
    return {
        sender: userOp.sender,
        nonce: ethers.utils.hexlify(userOp.nonce),
        initCode: userOp.initCode,
        callData: userOp.callData,
        callGasLimit: ethers.utils.hexlify(userOp.callGasLimit),
        verificationGasLimit: ethers.utils.hexlify(userOp.verificationGasLimit),
        preVerificationGas: ethers.utils.hexlify(userOp.preVerificationGas),
        maxFeePerGas: ethers.utils.hexlify(userOp.maxFeePerGas),
        maxPriorityFeePerGas: ethers.utils.hexlify(userOp.maxPriorityFeePerGas),
        paymasterAndData: userOp.paymasterAndData,
        signature: userOp.signature,
    };
}
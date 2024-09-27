import * as crypto from 'crypto';
import { ethers, BigNumber } from 'ethers';
import axios from 'axios';
import entryPoint from "../utils/entryPoint.json";
import { getNetworkConfig } from "./networkService";
import chatterPayABI from "../utils/chatterPayABI.json";
import Blockchain, { IBlockchain } from '../models/blockchain';
import { computeProxyAddressFromPhone } from './predictWalletService';
import { getBundlerUrl, validateBundlerUrl } from '../utils/bundler';
import { waitForUserOperationReceipt } from '../utils/waitForTX';

/**
 * Represents a user operation in the ChatterPay system.
 */
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

/**
 * Retrieves the blockchain information for a given chain ID.
 * 
 * @param chain_id - The ID of the blockchain to retrieve.
 * @returns A promise that resolves to the blockchain information.
 * @throws Error if the blockchain with the given chain ID is not found.
 */
async function getBlockchain(chain_id: number): Promise<IBlockchain> {
    const blockchain: IBlockchain | null = await Blockchain.findOne({ chain_id });
    if (!blockchain) {
        throw new Error(`Blockchain with chain_id ${chain_id} not found`);
    }
    return blockchain;
}

/**
 * Generates a private key from a seed private key and a phone number.
 * 
 * @param seedPrivateKey - The seed private key.
 * @param fromNumber - The phone number to use in key generation.
 * @returns The generated private key as a hexadecimal string.
 */
function generatePrivateKey(seedPrivateKey: string, fromNumber: string): string {
    const seed = seedPrivateKey + fromNumber;
    return `0x${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

/**
 * Sets up the necessary contracts and signers for the ChatterPay system.
 * 
 * @param blockchain - The blockchain information.
 * @param privateKey - The private key to use for signing.
 * @param fromNumber - The phone number associated with the account.
 * @returns An object containing the provider, signers, and contracts.
 */
async function setupContracts(blockchain: IBlockchain, privateKey: string, fromNumber: string) {
    const bundlerUrl = getBundlerUrl(blockchain.chain_id);
    if (!bundlerUrl) {
        throw new Error(`Unsupported chain ID: ${blockchain.chain_id}`);
    }

    console.log(`Validating bundler URL: ${bundlerUrl}`);
    const isValidBundler = await validateBundlerUrl(bundlerUrl);
    if (!isValidBundler) {
        throw new Error(`Invalid or unreachable bundler URL: ${bundlerUrl}`);
    }

    const provider = new ethers.providers.JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL);
    const signer = new ethers.Wallet(privateKey, provider);
    const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);
    const proxy = await computeProxyAddressFromPhone(fromNumber);
    //const code = await provider.getCode(proxy.proxyAddress);
    const accountExists = true;

    const chatterPay = new ethers.Contract(proxy.proxyAddress, chatterPayABI, signer);

    return { provider, signer, backendSigner, bundlerUrl, chatterPay, proxy, accountExists };
}

/**
 * Sets up an ERC20 contract instance.
 * 
 * @param tokenAddress - The address of the ERC20 token contract.
 * @param signer - The signer to use for the contract.
 * @returns A promise that resolves to the ERC20 contract instance.
 */
async function setupERC20(tokenAddress: string, signer: ethers.Wallet) {
    return new ethers.Contract(tokenAddress, [
        'function transfer(address to, uint256 amount) returns (bool)',
        'function balanceOf(address owner) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
    ], signer);
}

function packGasParameters(verificationGasLimit: BigNumber, callGasLimit: BigNumber): string {
    // Pack verificationGasLimit and callGasLimit into a single 256-bit value
    const packed = verificationGasLimit.shl(128).add(callGasLimit);
    return ethers.utils.hexZeroPad(ethers.utils.hexlify(packed), 32);
}

function unpackGasParameters(packedValue: string): [BigNumber, BigNumber] {
    const value = BigNumber.from(packedValue);
    const mask = BigNumber.from(2).pow(128).sub(1);
    const value2 = value.and(mask);
    const value1 = value.shr(128);
    return [value1, value2];
}

/**
 * Creates a user operation for token transfer.
 * 
 * @param entrypoint - The entrypoint contract instance.
 * @param chatterPay - The ChatterPay contract instance.
 * @param erc20 - The ERC20 token contract instance.
 * @param to - The recipient's address.
 * @param amount - The amount of tokens to transfer.
 * @param proxyAddress - The proxy address to use for the operation.
 * @returns A promise that resolves to the created UserOperation.
 */
async function createUserOperation(
    entrypoint: ethers.Contract,
    chatterPay: ethers.Contract,
    erc20: ethers.Contract,
    to: string,
    amount: string,
    proxyAddress: string,
): Promise<PackedUserOperation> {
    console.log("Creating UserOperation...");
    console.log("Proxy Address:", proxyAddress);
    console.log("To Address:", to);
    console.log("Amount:", amount);

    if (!ethers.utils.isAddress(to)) {
        throw new Error("Invalid 'to' address");
    }

    let amount_bn;
    try {
        amount_bn = ethers.utils.parseUnits(amount, 18);
    } catch (error) {
        throw new Error("Invalid amount");
    }
    console.log("Amount in BigNumber:", amount_bn.toString());

    const transferEncode = erc20.interface.encodeFunctionData("transfer", [to, amount_bn]);
    console.log("Transfer Encode:", transferEncode);

    const transferCallData = chatterPay.interface.encodeFunctionData("execute", [erc20.address, 0, transferEncode]);
    console.log("Transfer Call Data:", transferCallData);

    const nonce = await entrypoint.getNonce(proxyAddress, 0);
    console.log("Proxy Nonce:", nonce.toString());

    const verificationGasLimit = BigNumber.from(1500000);  // Increased from 1000000
    const callGasLimit = BigNumber.from(1500000);  // Increased from 1000000
    const preVerificationGas = BigNumber.from(400000); 
    const maxFeePerGas = BigNumber.from(ethers.utils.parseUnits("10", "gwei"));  // Adjusted
    const maxPriorityFeePerGas = BigNumber.from(ethers.utils.parseUnits("1", "gwei"));  // Adjusted

    const userOp: PackedUserOperation = {
        sender: proxyAddress,
        nonce: nonce,
        initCode: "0x",
        callData: transferCallData,
        callGasLimit: callGasLimit,
        verificationGasLimit: verificationGasLimit,
        preVerificationGas: preVerificationGas,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        paymasterAndData: "0x",
        signature: "0x",  // Inicialmente vacío, se llenará más tarde
    };

    return userOp;
}

async function calculatePrefund(userOp: PackedUserOperation): Promise<BigNumber> {
    try {
        const verificationGasLimit = userOp.verificationGasLimit;
        const callGasLimit = userOp.callGasLimit;
        const preVerificationGas = userOp.preVerificationGas;
        const maxFeePerGas = userOp.maxFeePerGas;
        
        const requiredGas = verificationGasLimit
            .add(callGasLimit)
            .add(preVerificationGas);

        const prefund = requiredGas.mul(maxFeePerGas);

        console.log("Prefund calculation details:");
        console.log(`Verification Gas Limit: ${verificationGasLimit.toString()}`);
        console.log(`Call Gas Limit: ${callGasLimit.toString()}`);
        console.log(`Pre-Verification Gas: ${preVerificationGas.toString()}`);
        console.log(`Max Fee Per Gas: ${ethers.utils.formatUnits(maxFeePerGas, "gwei")} gwei`);
        console.log(`Total Required Gas: ${requiredGas.toString()}`);
        console.log(`Calculated Prefund: ${ethers.utils.formatEther(prefund)} ETH`);

        return prefund;
    } catch (error) {
        console.error("Error calculating prefund:", error);
        throw new Error("Failed to calculate prefund");
    }
}

async function ensureAccountHasPrefund(
    entrypoint: ethers.Contract,
    userOp: PackedUserOperation,
    signer: ethers.Wallet
): Promise<void> {
    try {
        const prefund = await calculatePrefund(userOp);
        const balance = await entrypoint.balanceOf(userOp.sender);
        
        console.log(`Required prefund: ${ethers.utils.formatEther(prefund)} ETH`);
        console.log(`Current balance: ${ethers.utils.formatEther(balance)} ETH`);
        
        if (balance.lt(prefund)) {
            const missingFunds = prefund.sub(balance);
            console.log(`Depositing ${ethers.utils.formatEther(missingFunds)} ETH to account`);
            const tx = await entrypoint.depositTo(userOp.sender, { value: missingFunds });
            await tx.wait();
            console.log("Deposit transaction confirmed");
        } else {
            console.log("Account has sufficient prefund");
        }
    } catch (error) {
        console.error("Error ensuring account has prefund:", error);
        throw error;
    }
}

/**
 * Signs the UserOperation, replicating the contract's signature verification process.
 * 
 * @param userOperation - The UserOperation object.
 * @param entryPointAddress - The address of the EntryPoint contract.
 * @param signer - The ethers.js Wallet instance representing the signer.
 * @returns The UserOperation with the signature field populated.
 */
async function signUserOperation(
    userOperation: PackedUserOperation,
    entryPointAddress: string,
    signer: ethers.Wallet
): Promise<PackedUserOperation> {
    const chainId = await signer.getChainId();
    console.log("Chain ID:", chainId);

    console.log("Computing userOpHash...");
    const userOpHash = getUserOpHash(userOperation, entryPointAddress, chainId);
    console.log("UserOpHash:", userOpHash);

    // Sign the userOpHash digest directly
    const signature = await signer.signMessage(ethers.utils.arrayify(userOpHash));
    console.log("Generated signature:", signature);

    // Verify the signature
    const recoveredAddress = ethers.utils.verifyMessage(ethers.utils.arrayify(userOpHash), signature);
    console.log("Recovered address:", recoveredAddress);
    console.log("Signer address:", await signer.getAddress());

    if (recoveredAddress.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
        throw new Error("Signature verification failed on client side");
    }

    return { ...userOperation, signature };
}

/**
 * Sends a user operation for token transfer.
 * 
 * @param from - The sender's address.
 * @param fromNumber - The sender's phone number.
 * @param to - The recipient's address.
 * @param tokenAddress - The address of the token to transfer.
 * @param amount - The amount of tokens to transfer.
 * @param chain_id - The chain ID (default is 534351 for Scroll).
 * @returns A promise that resolves to an object containing the transaction hash.
 * @throws Error if there's an issue during the process.
 */
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
        const erc20 = await setupERC20(tokenAddress, signer);
        console.log("Contracts and signers set up");

        await checkBalance(erc20, proxy.proxyAddress, amount);
        console.log("Balance check passed");
        await ensureSignerHasEth(signer, backendSigner, provider);
        console.log("Signer has enough ETH");

        console.log("Getting network config");
        const networkConfig = await getNetworkConfig();
        // const entryPointAddress = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"
        const entrypoint = new ethers.Contract(networkConfig.entryPoint, entryPoint, backendSigner);

        console.log("Validating account");
        if (!accountExists) {
            throw new Error(`Account ${proxy.proxyAddress} does not exist. Cannot proceed with transfer.`);
        }

        console.log("Creating user op");
        let userOperation = await createUserOperation(entrypoint, chatterPay, erc20, to, amount, proxy.proxyAddress);
        
        console.log("Signing user op");
        userOperation = await signUserOperation(userOperation, networkConfig.entryPoint, signer);

        console.log("Ensuring account has enough prefund");
        await ensureAccountHasPrefund(entrypoint, userOperation, backendSigner);

        console.log("Sending user operation to bundler");
        const bundlerResponse = await sendUserOperationToBundler(bundlerUrl, userOperation, entrypoint.address);
        console.log("Bundler response:", bundlerResponse);

        // Wait for the transaction to be mined
        console.log("Waiting for transaction to be mined...");
        const receipt = await waitForUserOperationReceipt(provider, bundlerResponse);
        console.log("Transaction receipt:", JSON.stringify(receipt, null, 2));

        if (!receipt || !receipt.success) {
            throw new Error("Transaction failed or not found");
        }

        console.log("Transaction confirmed in block:", receipt.receipt.blockNumber);

        return { transactionHash: receipt.receipt.transactionHash };
    } catch (error) {
        console.error("Error in sendUserOperation:", error);
        console.log("Full error object:", JSON.stringify(error, null, 2));
        throw error;
    }
}

/**
 * Checks if the account has sufficient balance for the transfer.
 *  
 * @param erc20 - The ERC20 token contract instance.
 * @param proxyAddress - The proxy address to check the balance for.
 * @param amount - The amount to check against.
 * @throws Error if the balance is insufficient.
 */
async function checkBalance(erc20: ethers.Contract, proxyAddress: string, amount: string) {
    console.log(`Checking balance for ${proxyAddress}...`);
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    const balanceCheck = await erc20.balanceOf(proxyAddress);
    console.log(`Checking balance for ${proxyAddress}: ${ethers.utils.formatUnits(balanceCheck, 18)}`);
    if (balanceCheck.lt(amount_bn)) {
        throw new Error(`Insufficient balance. Required: ${amount}, Available: ${ethers.utils.formatUnits(balanceCheck, 18)}`);
    }
}

/**
 * Ensures that the signer has enough ETH for gas fees.
 * 
 * @param signer - The signer wallet.
 * @param backendSigner - The backend signer wallet.
 * @param provider - The Ethereum provider.
 */
export async function ensureSignerHasEth(signer: ethers.Wallet, backendSigner: ethers.Wallet, provider: ethers.providers.JsonRpcProvider): Promise<void> {
    const EOABalance = await provider.getBalance(await signer.getAddress());
    console.log(`Signer balance: ${ethers.utils.formatEther(EOABalance)} ETH`);
    if (EOABalance.lt(ethers.utils.parseEther('0.0008'))) {
        console.log('Sending ETH to signer...');
        const tx = await backendSigner.sendTransaction({
            to: await signer.getAddress(),
            value: ethers.utils.parseEther('0.001'),
            gasLimit: 210000,
        });
        await tx.wait();
        console.log('ETH sent to signer');
    }
    console.log('Signer has enough ETH');
}

/**
 * Sends a user operation to the bundler.
 * 
 * @param bundlerUrl - The URL of the bundler.
 * @param userOperation - The packed user operation to send.
 * @param entryPointAddress - The address of the EntryPoint contract.
 * @returns The bundler's response.
 * @throws Error if the request fails.
 */
async function sendUserOperationToBundler(
    bundlerUrl: string,
    userOperation: PackedUserOperation,
    entryPointAddress: string
): Promise<any> {
    try {
        const serializedUserOp = serializeUserOperation(userOperation);
        console.log("Serialized UserOperation:", JSON.stringify(serializedUserOp, null, 2));
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
            console.error('Bundler returned an error:', response.data.error);
            if (response.data.error.data) {
                console.error('Bundler error data:', response.data.error.data);
            }
            throw new Error(`Bundler Error: ${response.data.error.message}`);
        }

        if (!response.data.result) {
            throw new Error('Bundler did not return a result');
        }

        return response.data.result;
    } catch (error: any) {
        console.error('Error sending user operation to bundler:', error.message);
        console.error('Error details:', error.response?.data || error);
        throw error;
    }
}

/**
 * Packs the UserOperation fields as per the contract's pack function.
 * 
 * @param userOp - The UserOperation object.
 * @returns The ABI-encoded packed user operation as a hex string.
 */
function packUserOp(userOp: PackedUserOperation): string {
    const sender = userOp.sender;
    const nonce = userOp.nonce;
    const hashInitCode = ethers.utils.keccak256(userOp.initCode);
    const hashCallData = ethers.utils.keccak256(userOp.callData);
    const callGasLimit = userOp.callGasLimit;
    const verificationGasLimit = userOp.verificationGasLimit;
    const preVerificationGas = userOp.preVerificationGas;
    const maxFeePerGas = userOp.maxFeePerGas;
    const maxPriorityFeePerGas = userOp.maxPriorityFeePerGas;
    const hashPaymasterAndData = ethers.utils.keccak256(userOp.paymasterAndData);

    const types = [
        "address",      // sender
        "uint256",      // nonce
        "bytes32",      // hashInitCode
        "bytes32",      // hashCallData
        "uint256",      // callGasLimit
        "uint256",      // verificationGasLimit
        "uint256",      // preVerificationGas
        "uint256",      // maxFeePerGas
        "uint256",      // maxPriorityFeePerGas
        "bytes32"       // hashPaymasterAndData
    ];

    const values = [
        sender,
        nonce,
        hashInitCode,
        hashCallData,
        callGasLimit,
        verificationGasLimit,
        preVerificationGas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        hashPaymasterAndData
    ];

    // ABI-encode the packed user operation
    const encoded = ethers.utils.defaultAbiCoder.encode(types, values);
    return encoded;
}

/**
 * Computes the hash of the UserOperation, replicating the contract's hash function.
 * 
 * @param userOp - The UserOperation object.
 * @returns The hash of the packed user operation as a hex string.
 */
function hashUserOp(userOp: PackedUserOperation): string {
    const packedUserOp = packUserOp(userOp);
    return ethers.utils.keccak256(packedUserOp);
}

/**
 * Computes the userOpHash for signing, replicating the contract's getUserOpHash function.
 * 
 * @param userOp - The UserOperation object.
 * @param entryPointAddress - The address of the EntryPoint contract.
 * @param chainId - The chain ID of the network.
 * @returns The userOpHash as a hex string.
 */
function getUserOpHash(userOp: PackedUserOperation, entryPointAddress: string, chainId: number): string {
    const userOpHash = hashUserOp(userOp);

    // ABI encode [userOpHash, entryPointAddress, chainId]
    const encoded = ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "address", "uint256"],
        [userOpHash, entryPointAddress, chainId]
    );

    // Compute the keccak256 hash
    const finalUserOpHash = ethers.utils.keccak256(encoded);
    return finalUserOpHash;
}

function serializeUserOperation(userOp: PackedUserOperation): any {
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
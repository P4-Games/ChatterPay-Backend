// Mi archivo
import * as crypto from 'crypto';
import { ethers, BigNumber } from 'ethers';

import entryPoint from "../utils/entryPoint.json";
import { getNetworkConfig } from "./networkService";
import chatterPayABI from "../utils/chatterPayABI.json";
import Blockchain, { IBlockchain } from '../models/blockchain';
import { computeProxyAddressFromPhone } from './predictWalletService';

/**
 * Represents a user operation in the ChatterPay system.
 */
interface PackedUserOperation {
    sender: string;
    nonce: string;
    initCode: string;
    callData: string;
    accountGasLimits: string;
    preVerificationGas: string;
    gasFees: string;
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
    const provider = new ethers.providers.JsonRpcProvider(blockchain.rpc);
    const signer = new ethers.Wallet(privateKey, provider);
    const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);
    const proxy = await computeProxyAddressFromPhone(fromNumber);
    const code = await provider.getCode(proxy.proxyAddress);
    const accountExists = code !== '0x';

    const chatterPay = new ethers.Contract(proxy.proxyAddress, chatterPayABI, signer);

    return { provider, signer, backendSigner, chatterPay, proxy, accountExists };
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

function packGasParameters(value1: BigNumber, value2: BigNumber): string {
    return ethers.utils.hexZeroPad(
        ethers.utils.hexlify(
            value1.mul(BigNumber.from(2).pow(128)).add(value2)
        ),
        32
    );
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

   // Ajustamos estos valores a cantidades más razonables
   const verificationGasLimit = BigNumber.from(100000);  // Reducido de 1000000
   const callGasLimit = BigNumber.from(200000);  // Reducido de 1000000
   const preVerificationGas = BigNumber.from(5000);  // Reducido de 1000000
   
   // Usamos valores más realistas para las tarifas de gas
   const maxFeePerGas = BigNumber.from(ethers.utils.parseUnits("50", "gwei"));  // Ajustado a un valor más típico
   const maxPriorityFeePerGas = BigNumber.from(ethers.utils.parseUnits("2", "gwei"));  // Ajustado a un valor más típico

   const accountGasLimits = packGasParameters(verificationGasLimit, callGasLimit);
   const gasFees = packGasParameters(maxFeePerGas, maxPriorityFeePerGas);

   const userOp: PackedUserOperation = {
       sender: proxyAddress,
       nonce: ethers.utils.hexZeroPad(ethers.utils.hexlify(nonce), 32),
       initCode: "0x",
       callData: transferCallData,
       accountGasLimits,
       preVerificationGas: ethers.utils.hexlify(preVerificationGas),
       gasFees,
       paymasterAndData: "0x",
       signature: "0x",
   };

   console.log("Created UserOperation:", JSON.stringify(userOp, null, 2));

   return userOp;
}

async function calculatePrefund(userOp: PackedUserOperation): Promise<BigNumber> {
    try {
        const [verificationGasLimit, callGasLimit] = unpackGasParameters(userOp.accountGasLimits);
        const [maxFeePerGas] = unpackGasParameters(userOp.gasFees);
        const preVerificationGas = BigNumber.from(userOp.preVerificationGas);
        
        const requiredGas = callGasLimit
            .add(verificationGasLimit)
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
 * Computes the hash of a user operation.
 * 
 * @param userOp - The user operation to hash.
 * @param entryPointAddress - The address of the entry point contract.
 * @param chainId - The chain ID.
 * @returns The computed hash as a hexadecimal string.
 */
function getUserOpHash(userOp: PackedUserOperation, entryPointAddress: string, chainId: number): string {
    const packed = ethers.utils.defaultAbiCoder.encode(
        ['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32'],
        [
            userOp.sender,
            userOp.nonce,
            ethers.utils.keccak256(userOp.initCode),
            ethers.utils.keccak256(userOp.callData),
            userOp.accountGasLimits,
            userOp.preVerificationGas,
            userOp.gasFees,
            ethers.utils.keccak256(userOp.paymasterAndData),
            ethers.utils.keccak256(userOp.signature)
        ]
    );
    const userOpHash = ethers.utils.keccak256(packed);
    return ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ['bytes32', 'address', 'uint256'],
            [userOpHash, entryPointAddress, chainId]
        )
    );
}

/**
 * Signs a user operation.
 * 
 * @param userOperation - The user operation to sign.
 * @param entrypoint - The entrypoint contract instance.
 * @param signer - The signer to use for signing.
 * @returns A promise that resolves to the signed UserOperation.
 */
async function signUserOperation(userOperation: PackedUserOperation, entrypoint: ethers.Contract, signer: ethers.Wallet): Promise<PackedUserOperation> {
    const chainId = await signer.getChainId();
    console.log("Chain ID:", chainId);

    const userOpHash = getUserOpHash(userOperation, entrypoint.address, chainId);
    console.log("UserOpHash to sign:", userOpHash);

    const signature = await signer.signMessage(ethers.utils.arrayify(userOpHash));
    console.log("Generated signature:", signature);

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
    chain_id: number = 534351
): Promise<{ transactionHash: string; }> {
    try {
        const blockchain = await getBlockchain(chain_id);
        const seedPrivateKey = process.env.PRIVATE_KEY;
        if (!seedPrivateKey) {
            throw new Error('Seed private key not found in environment variables');
        }

        const privateKey = generatePrivateKey(seedPrivateKey, fromNumber);
        const { provider, signer, backendSigner, chatterPay, proxy, accountExists } = await setupContracts(blockchain, privateKey, fromNumber);
        const erc20 = await setupERC20(tokenAddress, signer);

        await checkBalance(erc20, proxy.proxyAddress, amount);
        await ensureSignerHasEth(signer, backendSigner, provider);

        console.log("Getting network config");
        const networkConfig = await getNetworkConfig();
        const entrypoint = new ethers.Contract(networkConfig.entryPoint, entryPoint, backendSigner);

        console.log("Validating account");
        if (!accountExists) {
            throw new Error(`Account ${proxy.proxyAddress} does not exist. Cannot proceed with transfer.`);
        }

        console.log("Creating user op");
        let userOperation = await createUserOperation(entrypoint, chatterPay, erc20, to, amount, proxy.proxyAddress);

        console.log("Signing user op");
        userOperation = await signUserOperation(userOperation, entrypoint, signer);

        console.log("Ensuring account has enough prefund");
        await ensureAccountHasPrefund(entrypoint, userOperation, backendSigner);

        console.log("Sending handleOps transaction");
        const tx = await entrypoint.handleOps([userOperation], backendSigner.address, {
            gasLimit: 3000000, // Increased gas limit
        });
        console.log("Transaction sent:", tx.hash);

        const receipt = await tx.wait();
        console.log("Transaction confirmed in block:", receipt.blockNumber);

        return { transactionHash: receipt.transactionHash };
    } catch (error) {
        console.error("Error in sendUserOperation:", error);
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
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    const balanceCheck = await erc20.balanceOf(proxyAddress);
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
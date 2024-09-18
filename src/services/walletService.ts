import { BigNumber, ethers } from 'ethers';
import * as crypto from 'crypto';

import entryPoint from "../utils/entryPoint.json";
import { getNetworkConfig } from "./networkService";
import chatterPayABI from "../utils/chatterPayABI.json";
import Blockchain, { IBlockchain } from '../models/blockchain';
import { computeProxyAddressFromPhone } from './predictWalletService';
import { ChatterPayWalletFactory__factory } from '../types/ethers-contracts/factories/ChatterPayWalletFactory__factory';

/**
 * Represents a user operation in the ChatterPay system.
 */
interface UserOperation {
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
    return `0x${  crypto.createHash('sha256').update(seed).digest('hex')}`;
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
    const factory = ChatterPayWalletFactory__factory.connect(blockchain.factoryAddress, backendSigner);

    const proxy = await computeProxyAddressFromPhone(fromNumber);
    const code = await provider.getCode(proxy.proxyAddress);
    if (code === '0x') {
        console.log(`Creating new wallet for EOA: ${proxy.EOAAddress}, will result in: ${proxy.proxyAddress}...`);
        const tx = await factory.createProxy(proxy.EOAAddress, { gasLimit: 1000000 });
        await tx.wait();
    }
    console.log("User wallet is: ", proxy.proxyAddress)
    const chatterPay = new ethers.Contract(proxy.proxyAddress, chatterPayABI, signer);
    return { provider, signer, backendSigner, chatterPay, proxy };
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

/**
 * Creates a user operation for token transfer.
 * 
 * @param chatterPay - The ChatterPay contract instance.
 * @param erc20 - The ERC20 token contract instance.
 * @param to - The recipient's address.
 * @param amount - The amount of tokens to transfer.
 * @param proxyAddress - The proxy address to use for the operation.
 * @param signer - The signer to use for the operation.
 * @returns A promise that resolves to the created UserOperation.
 */
async function createUserOperation(
    entrypoint: ethers.Contract,
    chatterPay: ethers.Contract,
    erc20: ethers.Contract,
    to: string,
    amount: string,
    proxyAddress: string,
): Promise<UserOperation> {
    console.log("Creating UserOperation...");
    console.log("Proxy Address:", proxyAddress);
    console.log("To Address:", to);
    console.log("Amount:", amount);

    // Asegúrate de que 'to' sea una dirección válida
    if (!ethers.utils.isAddress(to)) {
        throw new Error("Invalid 'to' address");
    }

    // Asegúrate de que 'amount' sea un número válido
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
    console.log("Nonce:", nonce.toString());

    const userOp: UserOperation = {
        sender: proxyAddress,
        nonce,
        initCode: "0x",
        callData: transferCallData,
        callGasLimit: BigNumber.from(1000000), // Aumentado
        verificationGasLimit: BigNumber.from(1000000), // Aumentado
        preVerificationGas: BigNumber.from(100000), // Aumentado
        maxFeePerGas: BigNumber.from(ethers.utils.parseUnits("20", "gwei")),
        maxPriorityFeePerGas: BigNumber.from(ethers.utils.parseUnits("1", "gwei")),
        paymasterAndData: "0x",
        signature: "0x",
    };

    console.log("Created UserOperation:", JSON.stringify(userOp, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
    , 2));

    return userOp;
}

function getUserOpHash(userOp: UserOperation, entryPointAddress: string, chainId: number): string {
    const userOpHash = hashUserOp(userOp);
    const enc = ethers.utils.defaultAbiCoder.encode(
        ['bytes32', 'address', 'uint256'],
        [userOpHash, entryPointAddress, chainId]
    );
    return ethers.utils.keccak256(enc);
}

function hashUserOp(userOp: UserOperation): string {
    const hashedInitCode = ethers.utils.keccak256(userOp.initCode);
    const hashedCallData = ethers.utils.keccak256(userOp.callData);
    const hashedPaymasterAndData = ethers.utils.keccak256(userOp.paymasterAndData);

    const enc = ethers.utils.defaultAbiCoder.encode(
        ['address', 'uint256', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes32'],
        [userOp.sender, userOp.nonce, hashedInitCode, hashedCallData, userOp.callGasLimit, userOp.verificationGasLimit, 
        userOp.preVerificationGas, userOp.maxFeePerGas, userOp.maxPriorityFeePerGas, hashedPaymasterAndData]
    );

    return ethers.utils.keccak256(enc);
}

async function signUserOperation(userOperation: UserOperation, entrypoint: ethers.Contract, signer: ethers.Wallet): Promise<UserOperation> {
    console.log("Getting UserOp hash");

    const fixedUserOperation: UserOperation = {
        ...userOperation,
        initCode: userOperation.initCode || '0x',
        paymasterAndData: userOperation.paymasterAndData || '0x',
        signature: userOperation.signature || '0x'
    };

    console.log('Fixed User Operation:', JSON.stringify(fixedUserOperation, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
    , 2));

    const chainId = await signer.getChainId();
    const userOpHash = getUserOpHash(fixedUserOperation, entrypoint.address, chainId);

    console.log("signing UserOp", userOpHash);
    const userOpSignature = await signer.signMessage(ethers.utils.arrayify(userOpHash));

    return { ...fixedUserOperation, signature: userOpSignature };
}

async function simulateTransaction(
    entrypoint: ethers.Contract,
    userOperation: UserOperation,
    signer: ethers.Wallet
) {
    try {
        const result = await entrypoint.callStatic.handleOps(
            [userOperation],
            signer.address,
            { from: signer.address, gasLimit: 2000000 } // Aumentado el gasLimit
        );
        console.log("Simulation successful:", result);
        return true;
    } catch (error) {
        console.error("Simulation failed:", error);
        if (error.errorName) {
            console.error("Error name:", error.errorName);
        }
        if (error.errorArgs) {
            console.error("Error arguments:", error.errorArgs);
        }
        if (error.reason) {
            console.error("Error reason:", error.reason);
        }
        return false;
    }
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
    const blockchain = await getBlockchain(chain_id);
    const seedPrivateKey = process.env.PRIVATE_KEY;
    if (!seedPrivateKey) {
        throw new Error('Seed private key not found in environment variables');
    }

    const privateKey = generatePrivateKey(seedPrivateKey, fromNumber);
    const { provider, signer, backendSigner, chatterPay, proxy } = await setupContracts(blockchain, privateKey, fromNumber);
    const erc20 = await setupERC20(tokenAddress, signer);

    await checkBalance(erc20, proxy.proxyAddress, amount);
    await ensureSignerHasEth(signer, backendSigner, provider);

    console.log("Getting network config");
    const networkConfig = await getNetworkConfig();
    const entrypoint = new ethers.Contract(networkConfig.entryPoint, entryPoint, signer);
    
    console.log("Creating user op");
    let userOperation = await createUserOperation(entrypoint, chatterPay, erc20, to, amount, proxy.proxyAddress);
    
    console.log("Signing user op");
    userOperation = await signUserOperation(userOperation, entrypoint, signer);
    
    // Llamar a esta función antes de ejecutar la transacción real
    await simulateTransaction(entrypoint, userOperation, signer);

    console.log("Executing user op");
    return executeTransfer(entrypoint, userOperation, signer, backendSigner);
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

/**
 * Executes the token transfer.
 * 
 * @param entrypoint - The entrypoint contract instance.
 * @param userOperation - The user operation to execute.
 * @param signer - The signer wallet.
 * @param backendSigner - The backend signer wallet.
 * @returns A promise that resolves to an object containing the transaction hash.
 * @throws Error if there's an error in the transfer process.
 */
async function executeTransfer(
    entrypoint: ethers.Contract,
    userOperation: UserOperation,
    signer: ethers.Wallet,
    backendSigner: ethers.Wallet
): Promise<{ transactionHash: string; }> {
    try {
        const entrypoint_backend = entrypoint.connect(backendSigner);
        console.log("Preparing handleOps parameters");
        
        console.log("Original UserOperation:", JSON.stringify(userOperation, (key, value) => 
            typeof value === 'bigint' ? value.toString() : value
        , 2));

        // Additional checks
        console.log("Checking nonce...");
        const currentNonce = await entrypoint.getNonce(userOperation.sender, 0);
        console.log(`Current nonce for ${userOperation.sender}: ${currentNonce}`);
        console.log(`UserOperation nonce: ${userOperation.nonce}`);
        if (currentNonce.toString() !== userOperation.nonce) {
            console.warn("Nonce mismatch. This might cause the transaction to fail.");
        }

        console.log("Checking gas limits...");
        const block = await backendSigner.provider.getBlock('latest');
        console.log(`Current block gas limit: ${block.gasLimit}`);
        console.log(`UserOperation total gas: ${
            ethers.BigNumber.from(userOperation.callGasLimit)
            .add(userOperation.verificationGasLimit)
            .add(userOperation.preVerificationGas)
        }`);

        // Ensure all fields are properly converted and not undefined
        const safeUserOp = {
            sender: userOperation.sender,
            nonce: userOperation.nonce.toHexString(), // Convertir BigNumber a string hexadecimal
            initCode: userOperation.initCode || '0x',
            callData: userOperation.callData,
            callGasLimit: userOperation.callGasLimit.toHexString(),
            verificationGasLimit: userOperation.verificationGasLimit.toHexString(),
            preVerificationGas: userOperation.preVerificationGas.toHexString(),
            maxFeePerGas: userOperation.maxFeePerGas.toHexString(),
            maxPriorityFeePerGas: userOperation.maxPriorityFeePerGas.toHexString(),
            paymasterAndData: userOperation.paymasterAndData || '0x',
            signature: userOperation.signature
        };

        console.log("Safe UserOperation:", JSON.stringify(safeUserOp, null, 2));

        console.log("Checking callData...");
        console.log("CallData length:", safeUserOp.callData.length);
        console.log("CallData:", safeUserOp.callData);

        console.log("Sending handleOps");
        const tx = await entrypoint_backend.handleOps(
            [safeUserOp],
            signer.address,
            { gasLimit: 2000000 } // Aumentado el gasLimit
        );

        console.log("Transaction sent, waiting for confirmation");
        console.log("Transaction hash:", tx.hash);
        
        const receipt = await tx.wait();
        console.log("Transaction receipt:", JSON.stringify(receipt, null, 2));
        
        if (receipt.status === 0) {
            console.error("Transaction failed");
            
            // Try to get more info about the failure
            try {
                const failureReason = await backendSigner.provider.call(tx, tx.blockNumber);
                console.error("Failure reason:", failureReason);
            } catch (callError) {
                console.error("Error getting failure reason:", callError);
                if (callError.error && callError.error.message) {
                    console.error("Detailed error message:", callError.error.message);
                }
            }
            
            throw new Error("Transaction failed");
        }
        
        console.log(`User Operation execute confirmed in block ${receipt.blockNumber}`);
        return { transactionHash: receipt.transactionHash };
    } catch (error) {
        console.error('Error sending User Operation transaction:', error);
        if (error.reason) console.error('Error reason:', error.reason);
        if (error.code) console.error('Error code:', error.code);
        if (error.method) console.error('Error method:', error.method);
        if (error.transaction) {
            console.error("Failed transaction data:", error?.transaction?.data);
        }
        if (error.error && error.error.message) console.error('Internal error message:', error.error.message);
        if (error.stack) console.error('Error stack:', error.stack);
        throw error;
    }
}
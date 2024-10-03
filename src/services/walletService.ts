import { ethers } from 'ethers';
import * as crypto from 'crypto';

import { getNetworkConfig } from './networkService';
import Blockchain, { IBlockchain } from '../models/blockchain';
import { computeProxyAddressFromPhone } from './predictWalletService';
import { getDynamicGas, executeWithDynamicGas } from '../utils/dynamicGas';
import { getEntryPointABI, getChatterPayWalletABI, getChatterPayWalletFactoryABI } from './bucketService';

const chatterPayABI = await getChatterPayWalletABI();
const entryPoint = await getEntryPointABI();

/**
 * Represents a user operation in the ChatterPay system.
 */
interface UserOperation {
    sender: string;
    nonce: string;
    initCode: string;
    callData: string;
    accountGasLimits: ethers.BigNumber;
    preVerificationGas: ethers.BigNumber;
    gasFees: ethers.BigNumber;
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
    const factoryABI = await getChatterPayWalletFactoryABI();

    const factory = new ethers.Contract(blockchain.contracts.factoryAddress, factoryABI, backendSigner);

    const proxy = await computeProxyAddressFromPhone(fromNumber);
    const code = await provider.getCode(proxy.proxyAddress);
    if (code === '0x') {
        console.log(
            `Creating new wallet for EOA: ${proxy.EOAAddress}, will result in: ${proxy.proxyAddress}...`,
        );
        const tx = await factory.createProxy(proxy.EOAAddress, {
            gasLimit: await getDynamicGas(factory, 'createProxy', [proxy.EOAAddress]),
        });
        await tx.wait();
    }

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
    return new ethers.Contract(
        tokenAddress,
        [
            'function transfer(address to, uint256 amount) returns (bool)',
            'function balanceOf(address owner) view returns (uint256)',
            'function approve(address spender, uint256 amount) returns (bool)',
            'function allowance(address owner, address spender) view returns (uint256)',
        ],
        signer,
    );
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
    chatterPay: ethers.Contract,
    erc20: ethers.Contract,
    to: string,
    amount: string,
    proxyAddress: string,
    signer: ethers.Wallet,
): Promise<UserOperation> {
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    const transferEncode = erc20.interface.encodeFunctionData('transfer', [to, amount_bn]);
    const transferCallData = chatterPay.interface.encodeFunctionData('execute', [
        erc20.address,
        0,
        transferEncode,
    ]);

    const nonce = (await signer.provider!.getTransactionCount(proxyAddress)) + 1;

    return {
        sender: proxyAddress,
        nonce: ethers.BigNumber.from(nonce).toHexString(),
        initCode: '',
        callData: transferCallData,
        accountGasLimits: ethers.BigNumber.from('10000000'),
        preVerificationGas: ethers.BigNumber.from(16777216),
        gasFees: ethers.BigNumber.from('1000000'),
        paymasterAndData: '',
        signature: '',
    };
}

/**
 * Signs a user operation.
 *
 * @param userOperation - The user operation to sign.
 * @param entrypoint - The entrypoint contract instance.
 * @param signer - The signer to use for signing.
 * @returns A promise that resolves to the signed UserOperation.
 */
async function signUserOperation(
    userOperation: UserOperation,
    entrypoint: ethers.Contract,
    signer: ethers.Wallet,
): Promise<UserOperation> {
    const userOpHash = await entrypoint.getUserOpHash([
        userOperation.sender,
        userOperation.nonce,
        userOperation.initCode,
        userOperation.callData,
        userOperation.accountGasLimits,
        userOperation.preVerificationGas,
        userOperation.gasFees,
        userOperation.paymasterAndData,
        userOperation.signature,
    ]);
    const userOpSignature = await signer.signMessage(userOpHash);
    return { ...userOperation, signature: userOpSignature };
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
    chain_id: number = 534351,
): Promise<{ transactionHash: string }> {
    const blockchain = await getBlockchain(chain_id);
    const seedPrivateKey = process.env.PRIVATE_KEY;
    if (!seedPrivateKey) {
        throw new Error('Seed private key not found in environment variables');
    }

    const privateKey = generatePrivateKey(seedPrivateKey, fromNumber);
    const { provider, signer, backendSigner, chatterPay, proxy } = await setupContracts(
        blockchain,
        privateKey,
        fromNumber,
    );
    const erc20 = await setupERC20(tokenAddress, signer);

    await checkBalance(erc20, proxy.proxyAddress, amount);
    await ensureSignerHasEth(signer, backendSigner, provider);

    const networkConfig = await getNetworkConfig();
    const entrypoint = new ethers.Contract(networkConfig.contracts.entryPoint, entryPoint, signer);

    let userOperation = await createUserOperation(
        chatterPay,
        erc20,
        to,
        amount,
        proxy.proxyAddress,
        signer,
    );
    userOperation = await signUserOperation(userOperation, entrypoint, signer);

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
        throw new Error(
            `Insufficient balance. Required: ${amount}, Available: ${ethers.utils.formatUnits(balanceCheck, 18)}`,
        );
    }
}

/**
 * Ensures that the signer has enough ETH for gas fees.
 *
 * @param signer - The signer wallet.
 * @param backendSigner - The backend signer wallet.
 * @param provider - The Ethereum provider.
 */
export async function ensureSignerHasEth(
    signer: ethers.Wallet,
    backendSigner: ethers.Wallet,
    provider: ethers.providers.JsonRpcProvider,
): Promise<void> {
    const EOABalance = await provider.getBalance(await signer.getAddress());
    if (EOABalance.lt(ethers.utils.parseEther('0.0008'))) {
        console.log('Sending ETH to signer...');
        const tx = await backendSigner.sendTransaction({
            to: await signer.getAddress(),
            value: ethers.utils.parseEther('0.001'),
            gasLimit: 210000, // Fixed gas limit for ETH transfer
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
    backendSigner: ethers.Wallet,
): Promise<{ transactionHash: string }> {
    try {
        const entrypoint_backend = entrypoint.connect(backendSigner);
        const tx = await executeWithDynamicGas(entrypoint_backend, 'handleOps', [
            [userOperation],
            signer.address,
        ]);
        console.log(`User Operation execute confirmed in block ${tx.receipt.blockNumber}`);
        return { transactionHash: tx.transactionHash };
    } catch (error) {
        console.error('Error sending User Operation transaction:', error);
        throw error;
    }
}

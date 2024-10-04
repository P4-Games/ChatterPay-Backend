import { ethers } from 'ethers';

import { gasService } from './gasService';
import entryPoint from '../utils/entryPoint.json';
import { getBlockchain } from './blockchainService';
import { getNetworkConfig } from './networkService';
import { generatePrivateKey } from '../utils/keyGenerator';
import { sendUserOperationToBundler } from './bundlerService';
import { waitForUserOperationReceipt } from '../utils/waitForTX';
import { setupERC20, setupContracts } from './contractSetupService';
import { signUserOperation, createUserOperation } from './userOperationService';

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
        const entrypoint = new ethers.Contract(networkConfig.contracts.entryPoint, entryPoint, backendSigner);

        console.log("Validating account");
        if (!accountExists) {
            throw new Error(`Account ${proxy.proxyAddress} does not exist. Cannot proceed with transfer.`);
        }

        console.log("Creating user op");
        let userOperation = await createUserOperation(entrypoint, chatterPay, erc20, to, amount, proxy.proxyAddress);

        // const gasServiceConfig = gasService.createConfig(
        //     process.env.ARBITRUM_SEPOLIA_RPC_URL!,
        //     process.env.ALCHEMY_POLICY_ID!,
        //     networkConfig.contracts.entryPoint,
        //     networkConfig.rpc
        // );

        // console.log("Applying paymaster data to user op");
        // userOperation = await gasService.applyPaymasterDataToUserOp(gasServiceConfig, userOperation, signer);

        console.log("Signing user op");
        userOperation = await signUserOperation(userOperation, networkConfig.contracts.entryPoint, signer);

        // console.log("Ensuring account has enough prefund");
        // await ensureAccountHasPrefund(entrypoint, userOperation, backendSigner);

        console.log("Sending user operation to bundler");
        const bundlerResponse = await sendUserOperationToBundler(bundlerUrl, userOperation, entrypoint.address);
        console.log("Bundler response:", bundlerResponse);

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
    console.log("ERC20 ADDRESS", erc20.address)
    console.log(`Checking balance for ${proxyAddress}...`);
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    const balanceCheck = await erc20.balanceOf(proxyAddress);
    console.log(`Checking balance for ${proxyAddress}: ${ethers.utils.formatUnits(balanceCheck, 18)}`);
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
import { ethers } from 'ethers';
import { FastifyInstance } from 'fastify';

import { getEntryPointABI } from './bucketService';
import { getBlockchain } from './blockchainService';
import { checkWalletBalance } from './walletService';
import { generatePrivateKey } from '../utils/keyGenerator';
import { sendUserOperationToBundler } from './bundlerService';
import { waitForUserOperationReceipt } from '../utils/waitForTX';
import { setupERC20, setupContracts } from './contractSetupService';
import { addPaymasterData, ensurePaymasterHasPrefund } from './paymasterService';
import {
  signUserOperation,
  createTransferCallData,
  createGenericUserOperation
} from './userOperationService';

/**
 * Sends a user operation for token transfer.
 */
export async function sendUserOperation(
  fastify: FastifyInstance,
  fromNumber: string,
  to: string,
  tokenAddress: string,
  amount: string,
  chain_id: number
): Promise<{ transactionHash: string }> {
  try {
    const blockchain = await getBlockchain(chain_id);
    const seedPrivateKey = process.env.PRIVATE_KEY;
    if (!seedPrivateKey) {
      throw new Error('Seed private key not found in environment variables');
    }

    const privateKey = generatePrivateKey(seedPrivateKey, fromNumber);
    const { provider, signer, backendSigner, bundlerUrl, chatterPay, proxy, accountExists } =
      await setupContracts(blockchain, privateKey, fromNumber);
    const erc20 = await setupERC20(tokenAddress, signer);
    console.log('Contracts and signers set up.', signer.address);

    const checkBalanceResult = await checkWalletBalance(erc20, proxy.proxyAddress, amount);

    if (!checkBalanceResult.enoughBalance) {
      throw new Error(
        `Insufficient balance. Required: ${checkBalanceResult.amountToCheck}, Available: ${checkBalanceResult.walletBalance}`
      );
    }
    console.log('Balance check passed');

    await ensureSignerHasEth(signer, backendSigner, provider);
    console.log('Signer has enough ETH');

    const { networkConfig } = fastify;
    const entrypointABI = await getEntryPointABI();
    const entrypointContract = new ethers.Contract(
      networkConfig.contracts.entryPoint,
      entrypointABI,
      backendSigner
    );

    await ensurePaymasterHasPrefund(entrypointContract, networkConfig.contracts.paymasterAddress!);

    console.log('Validating account');
    if (!accountExists) {
      throw new Error(
        `Account ${proxy.proxyAddress} does not exist. Cannot proceed with transfer.`
      );
    }

    // Create transfer-specific call data
    const callData = createTransferCallData(chatterPay, erc20, to, amount);

    // Get the nonce
    const nonce = await entrypointContract.getNonce(proxy.proxyAddress, 0);
    console.log('Nonce:', nonce.toString());

    // Create the base user operation
    let userOperation = await createGenericUserOperation(callData, proxy.proxyAddress, nonce);

    // Add paymaster data
    userOperation = await addPaymasterData(
      userOperation,
      networkConfig.contracts.paymasterAddress!,
      backendSigner
    );

    // Sign the user operation
    userOperation = await signUserOperation(
      userOperation,
      networkConfig.contracts.entryPoint,
      signer
    );

    console.log('Sending user operation to bundler');
    const bundlerResponse = await sendUserOperationToBundler(
      bundlerUrl,
      userOperation,
      entrypointContract.address
    );
    console.log('Bundler response:', bundlerResponse);

    console.log('Waiting for transaction to be mined.');
    const receipt = await waitForUserOperationReceipt(provider, bundlerResponse);
    console.log('Transaction receipt:', JSON.stringify(receipt, null, 2));

    if (!receipt?.success) {
      throw new Error('Transaction failed or not found');
    }

    console.log('Transaction confirmed in block:', receipt.receipt.blockNumber);

    return { transactionHash: receipt.receipt.transactionHash };
  } catch (error) {
    console.error('Error in sendUserOperation:', error);
    console.log('Full error object:', JSON.stringify(error, null, 2));
    throw error;
  }
}

/**
 * Helper function to ensure the signer has enough ETH for gas fees.
 */
export async function ensureSignerHasEth(
  signer: ethers.Wallet,
  backendSigner: ethers.Wallet,
  provider: ethers.providers.JsonRpcProvider
): Promise<void> {
  const EOABalance = await provider.getBalance(await signer.getAddress());
  console.log(`Signer balance: ${ethers.utils.formatEther(EOABalance)} ETH`);
  if (EOABalance.lt(ethers.utils.parseEther('0.0008'))) {
    console.log('Sending ETH to signer.');
    const tx = await backendSigner.sendTransaction({
      to: await signer.getAddress(),
      value: ethers.utils.parseEther('0.001'),
      gasLimit: 210000
    });
    await tx.wait();
    console.log('ETH sent to signer');
  }
  console.log('Signer has enough ETH');
}

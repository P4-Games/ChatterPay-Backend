import { ethers } from 'ethers';

import { IUser } from '../models/user';
import { getUser } from './userService';
import { IToken } from '../models/token';
import { TokenBalance } from '../types/common';
import Transaction from '../models/transaction';
import { getEntryPointABI } from './bucketService';
import { IBlockchain } from '../models/blockchain';
import { getBlockchain } from './blockchainService';
import { generatePrivateKey } from '../utils/keyGenerator';
import { sendUserOperationToBundler } from './bundlerService';
import { waitForUserOperationReceipt } from '../utils/waitForTX';
import { setupERC20, setupContracts } from './contractSetupService';
import { getTokenBalances, verifyWalletBalance } from './walletService';
import { addPaymasterData, ensurePaymasterHasPrefund } from './paymasterService';
import { sendTransferNotification, sendOutgoingTransferNotification } from './notificationService';
import {
  signUserOperation,
  createTransferCallData,
  createGenericUserOperation
} from './userOperationService';

/**
 * Sends a user operation for token transfer.
 */
export async function sendUserOperation(
  networkConfig: IBlockchain,
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

    const checkBalanceResult = await verifyWalletBalance(erc20, proxy.proxyAddress, amount);
    if (!checkBalanceResult.enoughBalance) {
      throw new Error(
        `Insufficient balance. Required: ${checkBalanceResult.amountToCheck}, Available: ${checkBalanceResult.walletBalance}`
      );
    }
    console.log('Balance check passed');

    await ensureSignerHasEth(signer, backendSigner, provider);
    console.log('Signer has enough ETH');

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
    console.log('sendUserOperation end!');

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

/**
 * Executes a transaction between two users and handles the notifications.
 */
export const executeTransaction = async (
  networkConfig: IBlockchain,
  from: IUser,
  to: IUser | { wallet: string },
  tokenAddress: string,
  tokenSymbol: string,
  amount: string,
  chain_id: number
): Promise<string> => {
  console.log('Sending user operation.');

  let result;
  try {
    result = await sendUserOperation(
      networkConfig,
      from.phone_number,
      to.wallet,
      tokenAddress,
      amount,
      chain_id
    );
  } catch (error: unknown) {
    console.error('Error with sendUserOperation:', (error as Error).message);
    return 'The transaction failed, the funds remain in your account';
  }

  if (!result || !result.transactionHash) {
    return 'The transaction failed, the funds remain in your account';
  }

  try {
    await Transaction.create({
      trx_hash: result.transactionHash,
      wallet_from: from.wallet,
      wallet_to: to.wallet,
      type: 'transfer',
      date: new Date(),
      status: 'completed',
      amount: parseFloat(amount),
      token: tokenSymbol
    });
  } catch (error: unknown) {
    console.error(
      `Error saving transaction ${result.transactionHash} in database:`,
      (error as Error).message
    );
    // no throw error
  }

  try {
    console.log('Trying to notificate transfer');
    const fromName = from.name ?? from.phone_number ?? 'Alguien';
    const toNumber = 'phone_number' in to ? to.phone_number : to.wallet;

    sendTransferNotification(to.wallet, toNumber, fromName, amount, tokenSymbol);

    sendOutgoingTransferNotification(
      from.wallet,
      from.phone_number,
      toNumber,
      amount,
      tokenSymbol,
      result.transactionHash
    );

    return '';
  } catch (error) {
    console.error('Error sending notifications:', error);
    return 'The transaction failed, the funds remain in your account';
  }
};

export async function withdrawWalletAllFunds(
  tokens: IToken[],
  networkConfig: IBlockchain,
  channel_user_id: string,
  to_wallet: string
): Promise<{ result: boolean; message: string }> {
  const bddUser: IUser | null = await getUser(channel_user_id);
  if (!bddUser) {
    return { result: false, message: 'There are not user with that phone number' };
  }

  if (bddUser.walletEOA === to_wallet || bddUser.wallet === to_wallet) {
    return { result: false, message: 'You are trying to send funds to your own wallet' };
  }

  try {
    const to_wallet_formatted: string = !to_wallet.startsWith('0x') ? `0x${to_wallet}` : to_wallet;

    const walletTokensBalance: TokenBalance[] = await getTokenBalances(
      bddUser.wallet,
      tokens,
      networkConfig
    );

    // Usar forEach para iterar sobre el array y ejecutar la transacción si el balance es mayor a 0
    const delay = (ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    for (let index = 0; index < walletTokensBalance.length; index += 1) {
      const tokenBalance = walletTokensBalance[index];
      const { symbol, balance, address } = tokenBalance;
      const amount = parseFloat(balance);

      if (amount > 0) {
        // We are aware that using await inside for loops should be avoided,
        // as it can cause performance issues. We tried using Promise.all,
        // but it resulted in the failure of the user operation calls.
        //
        // eslint-disable-next-line no-await-in-loop
        await executeTransaction(
          networkConfig,
          bddUser,
          { wallet: to_wallet_formatted },
          address,
          symbol,
          balance,
          networkConfig.chain_id
        );

        // Only if it's not the last one
        if (index < walletTokensBalance.length - 1) {
          delay(15000); // 15 seg delay
        }
      }
    }
  } catch (error: unknown) {
    return { result: false, message: (error as Error).message };
  }

  return { result: true, message: '' };
}

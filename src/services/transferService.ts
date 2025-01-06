import { ethers } from 'ethers';

import { IUser } from '../models/user';
import { getUser } from './userService';
import { IToken } from '../models/token';
import { Logger } from '../utils/logger';
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
import { addPaymasterData, ensurePaymasterHasEnoughEth } from './paymasterService';
import { sendTransferNotification, sendOutgoingTransferNotification } from './notificationService';
import {
  signUserOperation,
  createTransferCallData,
  createGenericUserOperation
} from './userOperationService';
import {
  USER_SIGNER_MIN_BALANCE,
  BACKEND_SIGNER_MIN_BALANCE,
  USER_SIGNER_BALANCE_TO_TRANSFER
} from '../constants/environment';

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
      throw new Error('Seed private key not found in environment variables.');
    }

    const privateKey = generatePrivateKey(seedPrivateKey, fromNumber);
    const { provider, signer, backendSigner, bundlerUrl, chatterPay, proxy, accountExists } =
      await setupContracts(blockchain, privateKey, fromNumber);

    Logger.log('Validating account');
    if (!accountExists) {
      throw new Error(
        `Account ${proxy.proxyAddress} does not exist. Cannot proceed with user operation.`
      );
    }

    const erc20 = await setupERC20(tokenAddress, signer);
    const checkUserTokenBalanceResult = await verifyWalletBalance(
      erc20,
      proxy.proxyAddress,
      amount
    );
    if (!checkUserTokenBalanceResult.enoughBalance) {
      throw new Error(
        `User Wallet ${proxy.proxyAddress} insufficient Token balance. Required: ${checkUserTokenBalanceResult.amountToCheck}, Available: ${checkUserTokenBalanceResult.walletBalance}`
      );
    }

    const backendSignerWalletAddress = await backendSigner.getAddress();
    const checkBackendSignerBalanceresult = await ensureBackendSignerHasEnoughEth(
      backendSignerWalletAddress,
      provider
    );
    if (!checkBackendSignerBalanceresult) {
      throw new Error(
        `Backend Signer Wallet ${backendSignerWalletAddress}, insufficient ETH balance.`
      );
    }

    const userWalletAddress = await signer.getAddress();
    const checkUserEthBalanceResult = await ensureUserSignerHasEnoughEth(
      userWalletAddress,
      backendSigner,
      provider
    );
    if (!checkUserEthBalanceResult) {
      Logger.error(`User Wallet ${proxy.proxyAddress}, does not have enough ETH.`);
      throw new Error(`User Wallet ${proxy.proxyAddress}, insufficient ETH balance.`);
    }

    const entrypointABI = await getEntryPointABI();
    const entrypointContract = new ethers.Contract(
      networkConfig.contracts.entryPoint,
      entrypointABI,
      backendSigner
    );

    const ensurePaymasterPrefundResult = await ensurePaymasterHasEnoughEth(
      entrypointContract,
      networkConfig.contracts.paymasterAddress!
    );
    if (!ensurePaymasterPrefundResult) {
      throw new Error(`Cannot make the transaction right now. Please try again later.`);
    }

    // Create transfer-specific call data
    const callData = createTransferCallData(chatterPay, erc20, to, amount);

    // Get the nonce
    const nonce = await entrypointContract.getNonce(proxy.proxyAddress, 0);
    Logger.log('Nonce:', nonce.toString());

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

    Logger.log('Sending user operation to bundler');
    const bundlerResponse = await sendUserOperationToBundler(
      bundlerUrl,
      userOperation,
      entrypointContract.address
    );
    Logger.log('Bundler response:', bundlerResponse);

    Logger.log('Waiting for transaction to be mined.');
    const receipt = await waitForUserOperationReceipt(provider, bundlerResponse);
    Logger.log('Transaction receipt:', JSON.stringify(receipt));

    if (!receipt?.success) {
      throw new Error('Transaction failed or not found');
    }

    Logger.log('Transaction confirmed in block:', receipt.receipt.blockNumber);
    Logger.log('sendUserOperation end!');

    return { transactionHash: receipt.receipt.transactionHash };
  } catch (error) {
    Logger.error(
      `Error in sendUserOperation, from: ${fromNumber}, to: ${to}, ` +
        `token address: ${tokenAddress}, amount: ${amount}, error: `,
      error
    );
    Logger.log('Full error object:', JSON.stringify(error));
    throw error;
  }
}

/**
 * Helper function to ensure the User signer has enough ETH for gas fees.
 */
export async function ensureUserSignerHasEnoughEth(
  userSignerWalletAdddress: string,
  backendSignerWallet: ethers.Wallet,
  provider: ethers.providers.JsonRpcProvider
): Promise<boolean> {
  try {
    const backendSignerWalletAddress = await backendSignerWallet.getAddress();
    Logger.log(
      `Checking if User EOA ${userSignerWalletAdddress} has minimal funds (${USER_SIGNER_MIN_BALANCE}) to sign the transaction.`
    );

    const EOABalance = await provider.getBalance(userSignerWalletAdddress);
    Logger.log(
      `User EOA ${userSignerWalletAdddress} balance: ${ethers.utils.formatEther(EOABalance)} ETH.`
    );

    if (EOABalance.lt(ethers.utils.parseEther(USER_SIGNER_MIN_BALANCE))) {
      Logger.log(
        `Sending ${USER_SIGNER_BALANCE_TO_TRANSFER} ETH from backendSigner ${backendSignerWalletAddress} ` +
          `to User EOA ${userSignerWalletAdddress}.`
      );

      const tx = await backendSignerWallet.sendTransaction({
        to: userSignerWalletAdddress,
        value: ethers.utils.parseEther(USER_SIGNER_BALANCE_TO_TRANSFER),
        gasLimit: 210000
      });

      await tx.wait();
      Logger.log('ETH sent to user EOA');
    } else {
      Logger.log('User EOA has enough ETH to sign.');
    }
    return true;
  } catch (error: unknown) {
    Logger.error(
      `Error checking if EOA Signer has minimal funds to make the transaction. Error: ${(error as Error).message}`
    );
    return false;
  }
}

/**
 * Helper function to ensure the backend Signer has enough ETH for gas fees.
 */
export async function ensureBackendSignerHasEnoughEth(
  backendSignerWalletAddress: string,
  provider: ethers.providers.JsonRpcProvider
): Promise<boolean> {
  try {
    Logger.log(
      `Checking if Backend Signer ${backendSignerWalletAddress} has minimal funds (${BACKEND_SIGNER_MIN_BALANCE}) to make transactions.`
    );

    const walletBalance = await provider.getBalance(backendSignerWalletAddress);
    const walletBalanceFormatted = ethers.utils.formatEther(walletBalance);
    Logger.log(
      `Backend Signer ${backendSignerWalletAddress} balance: ${walletBalanceFormatted} ETH.`
    );

    if (walletBalance.lt(ethers.utils.parseEther(BACKEND_SIGNER_MIN_BALANCE))) {
      Logger.error(
        `Backend Signer ${backendSignerWalletAddress} current balance: ${walletBalanceFormatted} ETH, ` +
          `balance required: ${BACKEND_SIGNER_MIN_BALANCE} ETH.`
      );
      return false;
    }
    
    Logger.log('Backend Signer has enough ETH.');
    return true;

  } catch (error: unknown) {
    Logger.error(
      `Error checking if Backend Signer has minimal funds to make transactions. Error: ${(error as Error).message}`
    );
    return false;
  }
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
  Logger.log('Sending user operation.');

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
    Logger.error('Error with sendUserOperation:', (error as Error).message);
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
    Logger.error(
      `Error saving transaction ${result.transactionHash} in database:`,
      (error as Error).message
    );
    // no throw error
  }

  try {
    Logger.log('Trying to notificate transfer');
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
    Logger.error('Error sending notifications:', error);
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

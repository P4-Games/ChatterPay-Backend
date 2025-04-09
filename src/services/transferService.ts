/* eslint-disable no-restricted-syntax */
import { ethers } from 'ethers';

import { IToken } from '../models/tokenModel';
import { Logger } from '../helpers/loggerHelper';
import { getTokenBalances } from './balanceService';
import { IBlockchain } from '../models/blockchainModel';
import { IUser, IUserWallet } from '../models/userModel';
import { setupERC20 } from './web3/contractSetupService';
import { mongoUserService } from './mongo/mongoUserService';
import { checkBlockchainConditions } from './blockchainService';
import { mongoTransactionService } from './mongo/mongoTransactionService';
import { createTransferCallData, executeUserOperationWithRetry } from './web3/userOperationService';
import {
  logPaymasterEntryPointDeposit,
  getPaymasterEntryPointDepositValue
} from './web3/paymasterService';
import {
  openOperation,
  closeOperation,
  getUserWalletByChainId,
  hasUserAnyOperationInProgress
} from './userService';
import {
  TokenBalance,
  TransactionData,
  SetupContractReturn,
  ExecueTransactionResult,
  ConcurrentOperationsEnum,
  CheckBalanceConditionsResult
} from '../types/commonType';

/**
 * Sends a user operation for token transfer.
 *
 * @param networkConfig
 * @param setupContractsResult
 * @param entryPointContract
 * @param fromAddress
 * @param toAddress
 * @param tokenAddress
 * @param amount
 * @returns
 */
export async function sendTransferUserOperation(
  networkConfig: IBlockchain,
  setupContractsResult: SetupContractReturn,
  entryPointContract: ethers.Contract,
  fromAddress: string,
  toAddress: string,
  tokenAddress: string,
  amount: string
): Promise<ExecueTransactionResult> {
  try {
    Logger.log('sendTransferUserOperation', 'Getting ERC20 Contract');
    const erc20 = await setupERC20(tokenAddress, setupContractsResult.signer);
    Logger.log('sendTransferUserOperation', 'Getted ERC20 Contract OK');

    Logger.log('sendTransferUserOperation', 'Validating sender contract init-code');
    const code = await setupContractsResult.provider.getCode(fromAddress);
    if (code === '0x') {
      Logger.log(
        'sendTransferUserOperation',
        `Invalid Init Code in user wallet ${fromAddress}`,
        code
      );
    }
    Logger.log(
      'sendTransferUserOperation',
      `Verified Init Code in user wallet ${fromAddress}`,
      code
    );

    Logger.log('sendTransferUserOperation', 'Creating Transfer Call Data');
    Logger.log(
      'sendTransferUserOperation',
      'Creating Transfer Call Data, chatterpay contract address:',
      setupContractsResult.chatterPay.address
    );
    const callData = await createTransferCallData(
      setupContractsResult.chatterPay,
      erc20,
      toAddress,
      amount
    );
    Logger.log('sendTransferUserOperation', 'Created Transfer Call Data OK', callData);

    // Keep Paymater Deposit Value
    const paymasterDepositValuePrev = await getPaymasterEntryPointDepositValue(
      entryPointContract,
      networkConfig.contracts.paymasterAddress!
    );

    const userOpGasConfig = networkConfig.gas.operations.transfer;
    const userOpResult = await executeUserOperationWithRetry(
      networkConfig,
      setupContractsResult.provider,
      setupContractsResult.signer,
      setupContractsResult.backendSigner,
      entryPointContract,
      callData,
      setupContractsResult.proxy.proxyAddress,
      'transfer',
      userOpGasConfig.perGasInitialMultiplier,
      userOpGasConfig.perGasIncrement,
      userOpGasConfig.callDataInitialMultiplier,
      userOpGasConfig.maxRetries,
      userOpGasConfig.timeoutMsBetweenRetries
    );

    await logPaymasterEntryPointDeposit(
      entryPointContract,
      networkConfig.contracts.paymasterAddress!,
      paymasterDepositValuePrev
    );

    return userOpResult;
  } catch (error) {
    const errorMessage = JSON.stringify(error);
    Logger.error(
      'sendTransferUserOperation',
      `Error, from: ${fromAddress}, to: ${toAddress}, ` +
        `token address: ${tokenAddress}, amount: ${amount}, error: `,
      errorMessage
    );
    return { success: false, transactionHash: '', error: errorMessage };
  }
}

export async function withdrawWalletAllFunds(
  tokens: IToken[],
  networkConfig: IBlockchain,
  channel_user_id: string,
  to_wallet: string
): Promise<{ result: boolean; message: string }> {
  try {
    const bddUser: IUser | null = await mongoUserService.getUser(channel_user_id);
    if (!bddUser) {
      return { result: false, message: 'There are not user with that phone number' };
    }

    const userWallet: IUserWallet | null = getUserWalletByChainId(
      bddUser.wallets,
      networkConfig.chainId
    );
    if (!userWallet) {
      return { result: false, message: `No wallet found for chain ${networkConfig.chainId}` };
    }

    if (
      !userWallet ||
      userWallet.wallet_proxy === to_wallet ||
      userWallet.wallet_eoa === to_wallet
    ) {
      return { result: false, message: 'You are trying to send funds to your own wallet' };
    }

    if (hasUserAnyOperationInProgress(bddUser)) {
      return {
        result: false,
        message: `Concurrent withdraw-all operation for wallet ${userWallet.wallet_proxy}, phone: ${bddUser.phone_number}.`
      };
    }

    const to_wallet_formatted: string = !to_wallet.startsWith('0x') ? `0x${to_wallet}` : to_wallet;

    const walletTokensBalance: TokenBalance[] = await getTokenBalances(
      userWallet.wallet_proxy,
      tokens,
      networkConfig
    );

    // Check Blockchain Conditions
    const checkBlockchainConditionsResult: CheckBalanceConditionsResult =
      await checkBlockchainConditions(networkConfig, channel_user_id);

    if (!checkBlockchainConditionsResult.success) {
      return { result: false, message: 'Invalid Blockchain Conditions to make transaction' };
    }

    await openOperation(bddUser.phone_number, ConcurrentOperationsEnum.WithdrawAll);

    // Use forEach to iterate over the array and execute the transaction if the balance is greater than 0
    const delay = (ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    // Arrays to store transactions data for later persistence
    const transactionsOutToSave: TransactionData[] = [];

    // Iterate through tokens and execute transactions
    for (let index = 0; index < walletTokensBalance.length; index += 1) {
      const tokenBalance: TokenBalance = walletTokensBalance[index];
      const { balance, address, symbol } = tokenBalance;
      const amount = parseFloat(balance);

      if (amount > 0) {
        // We are aware that using await inside for loops should be avoided,
        // as it can cause performance issues. We tried using Promise.all,
        // but it resulted in the failure of the user operation calls.
        //
        // eslint-disable-next-line no-await-in-loop
        const executeTransactionResult: ExecueTransactionResult = await sendTransferUserOperation(
          networkConfig,
          checkBlockchainConditionsResult.setupContractsResult!,
          checkBlockchainConditionsResult.entryPointContract!,
          userWallet.wallet_proxy,
          to_wallet_formatted,
          address,
          balance
        );

        // Store transaction out data as a generic object
        transactionsOutToSave.push({
          tx: executeTransactionResult.transactionHash,
          walletFrom: userWallet.wallet_proxy,
          walletTo: to_wallet_formatted,
          amount,
          token: symbol,
          type: 'withdraw',
          status: 'completed',
          chain_id: networkConfig.chainId
        });

        // Only if it's not the last one
        if (index < walletTokensBalance.length - 1) {
          delay(15000); // 15 seg delay
        }
      }
    }

    // Persist all transaction data to the database after the loop
    await Promise.all(
      transactionsOutToSave.map((transaction) =>
        mongoTransactionService.saveTransaction(transaction)
      )
    );
  } catch (error: unknown) {
    return { result: false, message: (error as Error).message };
  }

  await closeOperation(channel_user_id, ConcurrentOperationsEnum.WithdrawAll);
  return { result: true, message: '' };
}

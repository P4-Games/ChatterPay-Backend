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
import { sendUserOperationToBundler } from './web3/bundlerService';
import { mongoTransactionService } from './mongo/mongoTransactionService';
import { waitForUserOperationReceipt } from './web3/userOpExecutorService';
import { addPaymasterData, getPaymasterEntryPointDepositValue } from './web3/paymasterService';
import {
  signUserOperation,
  createTransferCallData,
  createGenericUserOperation
} from './web3/userOperationService';
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

    // Get the nonce
    Logger.log('sendTransferUserOperation', 'Getting Nonce');
    const nonce = await entryPointContract.getNonce(setupContractsResult.proxy.proxyAddress, 0);
    Logger.log('sendTransferUserOperation', 'Getted Nonce OK', nonce);

    // Create the base user operation
    Logger.log('sendTransferUserOperation', 'Creating Generic User Operation');
    const userOperation = await createGenericUserOperation(
      networkConfig.gas,
      callData,
      setupContractsResult.proxy.proxyAddress,
      nonce,
      'transfer'
    );
    Logger.log('sendTransferUserOperation', 'Created Generic User Operation OK', userOperation);

    // Add paymaster data
    Logger.log('sendTransferUserOperation', 'Adding Paymaster Data');
    const userOperationWithPaymaster = await addPaymasterData(
      userOperation,
      networkConfig.contracts.paymasterAddress!,
      setupContractsResult.backendSigner,
      networkConfig.contracts.entryPoint,
      callData,
      networkConfig.chainId
    );
    Logger.log(
      'sendTransferUserOperation',
      'Added Paymaster Data OK (userOp 2)',
      JSON.stringify(userOperationWithPaymaster)
    );

    Logger.log('sendTransferUserOperation', 'Signing User Operation');
    const userOperationSigned = await signUserOperation(
      userOperationWithPaymaster,
      networkConfig.contracts.entryPoint,
      setupContractsResult.signer
    );

    Logger.log(
      'sendTransferUserOperation',
      'Signed User Operation OK (userOp 3)',
      JSON.stringify(userOperationSigned)
    );
    Logger.log(
      'sendTransferUserOperation',
      'paymasterAndData length (must be 93 !!!!):',
      userOperationWithPaymaster.paymasterAndData.length
    );

    //  return;
    Logger.log(
      'sendTransferUserOperation',
      'Sending user operation to bundler',
      setupContractsResult.bundlerUrl
    );

    // Keep Paymater Deposit Value
    const paymasterDepositValuePrev = await getPaymasterEntryPointDepositValue(
      entryPointContract,
      networkConfig.contracts.paymasterAddress!
    );

    const bundlerResponse = await sendUserOperationToBundler(
      setupContractsResult.bundlerUrl,
      userOperationSigned,
      entryPointContract.address
    );
    Logger.log('sendTransferUserOperation', 'Bundler response:', bundlerResponse);
    Logger.log('sendTransferUserOperation', 'Sent User Operation to Bundler OK');

    Logger.log('sendTransferUserOperation', 'Waiting for transaction to be mined.');
    const receipt = await waitForUserOperationReceipt(
      setupContractsResult.provider,
      bundlerResponse
    );
    Logger.log('sendTransferUserOperation', 'Transaction receipt:', JSON.stringify(receipt));

    if (!receipt?.success) {
      throw new Error('sendTransferUserOperation: Transaction failed or not found');
    }

    const paymasterDepositValueNow = await getPaymasterEntryPointDepositValue(
      entryPointContract,
      networkConfig.contracts.paymasterAddress!
    );
    const cost = paymasterDepositValuePrev.value.sub(paymasterDepositValueNow.value);
    const costInEth = (
      parseFloat(paymasterDepositValuePrev.inEth) - parseFloat(paymasterDepositValueNow.inEth)
    ).toFixed(6);

    Logger.info(
      'sendTransferUserOperation',
      `Paymaster pre: ${paymasterDepositValuePrev.value.toString()} (${paymasterDepositValuePrev.inEth}), ` +
        `Paymaster now: ${paymasterDepositValueNow.value.toString()} (${paymasterDepositValueNow.inEth}), ` +
        `Cost: ${cost.toString()} (${costInEth} ETH)`
    );

    Logger.log(
      'sendTransferUserOperation',
      'Transaction confirmed in block:',
      receipt.receipt.blockNumber
    );
    Logger.log('sendTransferUserOperation', 'end!');

    return { success: true, transactionHash: receipt.receipt.transactionHash };
  } catch (error) {
    Logger.error(
      'sendTransferUserOperation',
      `Error, from: ${fromAddress}, to: ${toAddress}, ` +
        `token address: ${tokenAddress}, amount: ${amount}, error: `,
      JSON.stringify(error)
    );
    return { success: false, transactionHash: '' };
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
          status: 'completed'
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

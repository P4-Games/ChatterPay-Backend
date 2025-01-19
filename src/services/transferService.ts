import { ethers } from 'ethers';

import { IToken } from '../models/tokenModel';
import { Logger } from '../helpers/loggerHelper';
import { getTokenBalances } from './balanceService';
import { IBlockchain } from '../models/blockchainModel';
import { setupERC20 } from './web3/contractSetupService';
import { IUser, IUserWallet } from '../models/userModel';
import { addPaymasterData } from './web3/paymasterService';
import { mongoUserService } from './mongo/mongoUserService';
import { checkBlockchainConditions } from './blockchainService';
import { sendUserOperationToBundler } from './web3/bundlerService';
import { waitForUserOperationReceipt } from './web3/userOpExecutorService';
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
 * @param fromNumber
 * @param to
 * @param tokenAddress
 * @param amount
 * @returns
 */
export async function sendUserOperation(
  networkConfig: IBlockchain,
  setupContractsResult: SetupContractReturn,
  entryPointContract: ethers.Contract,
  fromNumber: string,
  to: string,
  tokenAddress: string,
  amount: string
): Promise<ExecueTransactionResult> {
  try {
    // Create transfer-specific call data
    const erc20 = await setupERC20(tokenAddress, setupContractsResult.signer);
    const callData = createTransferCallData(setupContractsResult.chatterPay, erc20, to, amount);

    // Get the nonce
    const nonce = await entryPointContract.getNonce(setupContractsResult.proxy.proxyAddress, 0);

    // Create the base user operation
    let userOperation = await createGenericUserOperation(
      callData,
      setupContractsResult.proxy.proxyAddress,
      nonce
    );

    // Add paymaster data
    userOperation = await addPaymasterData(
      userOperation,
      networkConfig.contracts.paymasterAddress!,
      setupContractsResult.backendSigner
    );

    // Sign the user operation
    userOperation = await signUserOperation(
      userOperation,
      networkConfig.contracts.entryPoint,
      setupContractsResult.signer
    );

    Logger.log('sendUserOperation', 'Sending user operation to bundler');
    const bundlerResponse = await sendUserOperationToBundler(
      setupContractsResult.bundlerUrl,
      userOperation,
      entryPointContract.address
    );
    Logger.log('sendUserOperation', 'Bundler response:', bundlerResponse);

    Logger.log('sendUserOperation', 'Waiting for transaction to be mined.');
    const receipt = await waitForUserOperationReceipt(
      setupContractsResult.provider,
      bundlerResponse
    );
    Logger.log('sendUserOperation', 'Transaction receipt:', JSON.stringify(receipt));

    if (!receipt?.success) {
      throw new Error('sendUserOperation: Transaction failed or not found');
    }

    Logger.log('sendUserOperation', 'Transaction confirmed in block:', receipt.receipt.blockNumber);
    Logger.log('sendUserOperation', 'end!');

    return { success: true, transactionHash: receipt.receipt.transactionHash };
  } catch (error) {
    Logger.error(
      'sendUserOperation',
      `Error, from: ${fromNumber}, to: ${to}, ` +
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
      networkConfig.chain_id
    );
    if (!userWallet) {
      return { result: false, message: `No wallet found for chain ${networkConfig.chain_id}` };
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

    for (let index = 0; index < walletTokensBalance.length; index += 1) {
      const tokenBalance = walletTokensBalance[index];
      const { balance, address } = tokenBalance;
      const amount = parseFloat(balance);

      if (amount > 0) {
        // We are aware that using await inside for loops should be avoided,
        // as it can cause performance issues. We tried using Promise.all,
        // but it resulted in the failure of the user operation calls.
        //
        // eslint-disable-next-line no-await-in-loop
        await sendUserOperation(
          networkConfig,
          checkBlockchainConditionsResult.setupContractsResult!,
          checkBlockchainConditionsResult.entryPointContract!,
          userWallet.wallet_proxy,
          to_wallet_formatted,
          address,
          balance
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

  await closeOperation(channel_user_id, ConcurrentOperationsEnum.WithdrawAll);
  return { result: true, message: '' };
}

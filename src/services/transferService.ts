/* eslint-disable no-restricted-syntax */
import type { ethers } from 'ethers';
import { Logger } from '../helpers/loggerHelper';
import type { IBlockchain } from '../models/blockchainModel';
import type { ExecueTransactionResult, SetupContractReturn } from '../types/commonType';
import { setupERC20 } from './web3/contractSetupService';
import {
  getPaymasterEntryPointDepositValue,
  logPaymasterEntryPointDeposit
} from './web3/paymasterService';
import { createTransferCallData, executeUserOperationWithRetry } from './web3/userOpService';

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
  amount: string,
  logKey: string
): Promise<ExecueTransactionResult> {
  try {
    Logger.log('sendTransferUserOperation', 'Getting ERC20 Contract');
    const erc20 = await setupERC20(tokenAddress, setupContractsResult.userPrincipal);
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
      setupContractsResult.userPrincipal,
      entryPointContract,
      callData,
      setupContractsResult.proxy.proxyAddress,
      'transfer',
      logKey,
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

import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { SIGNING_KEY } from '../config/constants';
import { executeSwap } from '../services/swapService';
import { setupERC20 } from '../services/contractSetupService';
import { saveTransaction } from '../services/transferService';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import { computeProxyAddressFromPhone } from '../services/predictWalletService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { getTokensAddresses, checkBlockchainConditions } from '../services/blockchainService';
import {
  openOperation,
  closeOperation,
  hasPhoneAnyOperationInProgress
} from '../services/userService';
import {
  TokenAddressesType,
  ExecuteSwapResultType,
  ConcurrentOperationsEnum,
  CheckBalanceConditionsResultType
} from '../types/common';
import {
  sendSwapNotification,
  sendInternalErrorNotification,
  sendUserInsufficientBalanceNotification,
  sendNoValidBlockchainConditionsNotification
} from '../services/notificationService';

interface SwapBody {
  channel_user_id: string;
  user_wallet: string;
  inputCurrency: string;
  outputCurrency: string;
  amount: number;
}

/**
 * Validates the input for the swap operation.
 *
 * @param inputs - The input data for the swap.
 * @param tokenAddresses - The token addresses for the input and output currencies.
 * @returns A string indicating the validation error, or an empty string if validation passes.
 */
const validateInputs = async (
  inputs: SwapBody,
  tokenAddresses: TokenAddressesType
): Promise<string> => {
  const { channel_user_id, inputCurrency, outputCurrency, amount } = inputs;

  if (!channel_user_id || !inputCurrency || !outputCurrency) {
    return 'Missing required fields: address, inputCurrency, or outputCurrency';
  }

  if (!isValidPhoneNumber(channel_user_id)) {
    return `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`;
  }

  if (inputCurrency === outputCurrency) {
    return 'Input and output currencies must be different';
  }

  if (amount === undefined || amount <= 0) {
    return 'Amount must be provided and greater than 0';
  }

  if (!tokenAddresses.tokenAddressInput || !tokenAddresses.tokenAddressOutput) {
    return 'Invalid token symbols for the current network';
  }

  return '';
};

/**
 * Handles the swap operation.
 *
 * @param request - The request object containing the swap details.
 * @param reply - The response object used to send the response.
 * @returns A response indicating the status of the swap.
 */
// eslint-disable-next-line consistent-return
export const swap = async (request: FastifyRequest<{ Body: SwapBody }>, reply: FastifyReply) => {
  try {
    /* ***************************************************** */
    /* 1. swap: input params                                 */
    /* ***************************************************** */
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const { channel_user_id, inputCurrency, outputCurrency, amount } = request.body;

    const { tokens: blockchainTokens, networkConfig } = request.server as FastifyInstance;

    const tokenAddresses: TokenAddressesType = getTokensAddresses(
      networkConfig,
      blockchainTokens,
      inputCurrency,
      outputCurrency
    );

    let validationError: string = await validateInputs(request.body, tokenAddresses);

    if (validationError) {
      return await returnErrorResponse(reply, 400, validationError);
    }

    /* ***************************************************** */
    /* 2. makeTransaction: open concurrent operation         */
    /* ***************************************************** */
    if (await hasPhoneAnyOperationInProgress(channel_user_id)) {
      validationError = `Concurrent swap operation for phone: ${channel_user_id}.`;
      Logger.log(`swap, ${validationError}`);
      return await returnErrorResponse(reply, 400, validationError);
    }
    await openOperation(channel_user_id, ConcurrentOperationsEnum.Swap);

    /* ***************************************************** */
    /* 3. swap: send initial response                        */
    /* ***************************************************** */
    await returnSuccessResponse(reply, 'Swap in progress, it may take a few minutes.');

    /* ***************************************************** */
    /* 4. swap: check user balance                           */
    /* ***************************************************** */

    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
    const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);
    const { proxyAddress } = await computeProxyAddressFromPhone(channel_user_id);

    // Get the contracts and decimals for the tokens
    const fromTokenContract = await setupERC20(tokenAddresses.tokenAddressInput, backendSigner);
    const fromTokenDecimals = await fromTokenContract.decimals();

    const toTokenContract = await setupERC20(tokenAddresses.tokenAddressOutput, backendSigner);
    const toTokenDecimals = await toTokenContract.decimals();

    // Get the current balances before the transaction
    const fromTokenCurrentBalance = await fromTokenContract.balanceOf(proxyAddress);
    const toTokenCurrentBalance = await toTokenContract.balanceOf(proxyAddress);

    const amountToCheck = ethers.utils.parseUnits(amount.toString(), fromTokenDecimals);
    const enoughBalance: boolean = fromTokenCurrentBalance.gte(amountToCheck);

    if (!enoughBalance) {
      await sendUserInsufficientBalanceNotification(proxyAddress, channel_user_id);
      await closeOperation(channel_user_id, ConcurrentOperationsEnum.Swap);
      return undefined;
    }

    /* ***************************************************** */
    /* 5. swap: check blockchain conditions                  */
    /* ***************************************************** */
    const checkBlockchainConditionsResult: CheckBalanceConditionsResultType =
      await checkBlockchainConditions(networkConfig, channel_user_id);

    if (!checkBlockchainConditionsResult.success) {
      await sendNoValidBlockchainConditionsNotification(proxyAddress, channel_user_id);
      await closeOperation(channel_user_id, ConcurrentOperationsEnum.Swap);
      return undefined;
    }

    /* ***************************************************** */
    /* 6. swap: make operation                               */
    /* ***************************************************** */

    const executeSwapResult: ExecuteSwapResultType = await executeSwap(
      networkConfig,
      checkBlockchainConditionsResult.setupContractsResult!,
      checkBlockchainConditionsResult.entryPointContract!,
      tokenAddresses,
      amount.toString()
    );
    if (!executeSwapResult.success) {
      await sendInternalErrorNotification(proxyAddress, channel_user_id);
      await closeOperation(channel_user_id, ConcurrentOperationsEnum.Swap);
      return undefined;
    }

    /* ***************************************************** */
    /* 7. swap: update database with result                  */
    /* ***************************************************** */

    // Get the new balances after the transaction
    const fromTokenNewBalance = await fromTokenContract.balanceOf(proxyAddress);
    const toTokenNewBalance = await toTokenContract.balanceOf(proxyAddress);

    // Calculate the tokens sent and received, considering the correct decimals
    const fromTokensSent = fromTokenCurrentBalance.sub(fromTokenNewBalance);
    const toTokensReceived = toTokenNewBalance.sub(toTokenCurrentBalance);

    // Ensure the values are in the correct units (converted to 'number' for saveTransaction)
    const fromTokensSentInUnits = parseFloat(
      ethers.utils.formatUnits(fromTokensSent, fromTokenDecimals)
    );
    const toTokensReceivedInUnits = parseFloat(
      ethers.utils.formatUnits(toTokensReceived, toTokenDecimals)
    );

    // Save transactions OUT
    Logger.log('swap', 'Updating swap transactions in database.');
    await saveTransaction(
      executeSwapResult.approveTransactionHash,
      proxyAddress,
      networkConfig.contracts.simpleSwapAddress,
      fromTokensSentInUnits,
      inputCurrency,
      'swap',
      'completed'
    );

    // Save transactions IN
    await saveTransaction(
      executeSwapResult.swapTransactionHash,
      networkConfig.contracts.simpleSwapAddress,
      proxyAddress,
      toTokensReceivedInUnits,
      outputCurrency,
      'swap',
      'completed'
    );

    /* ***************************************************** */
    /* 8. swap: send notification to user                    */
    /* ***************************************************** */

    await sendSwapNotification(
      channel_user_id,
      inputCurrency,
      fromTokensSentInUnits.toString(),
      toTokensReceivedInUnits.toString(),
      outputCurrency,
      executeSwapResult.swapTransactionHash
    );

    await closeOperation(channel_user_id, ConcurrentOperationsEnum.Swap);
    Logger.info(
      'swap',
      `Swap completed successfully approveTransactionHash: ${executeSwapResult.approveTransactionHash}, swapTransactionHash: ${executeSwapResult.swapTransactionHash}.`
    );
  } catch (error) {
    Logger.error('swap', error);
  }
};

import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { delaySeconds } from '../helpers/timeHelper';
import { executeSwap } from '../services/swapService';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import { setupERC20 } from '../services/web3/contractSetupService';
import { computeProxyAddressFromPhone } from '../services/predictWalletService';
import { mongoTransactionService } from '../services/mongo/mongoTransactionService';
import { SIGNING_KEY, COMMON_REPLY_OPERATION_IN_PROGRESS } from '../config/constants';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { getTokensAddresses, checkBlockchainConditions } from '../services/blockchainService';
import {
  openOperation,
  closeOperation,
  hasPhoneAnyOperationInProgress
} from '../services/userService';
import {
  TokenAddresses,
  TransactionData,
  ExecuteSwapResult,
  ConcurrentOperationsEnum,
  CheckBalanceConditionsResult
} from '../types/commonType';
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
  tokenAddresses: TokenAddresses
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
export const swap = async (
  request: FastifyRequest<{ Body: SwapBody; Querystring?: { lastBotMsgDelaySeconds?: number } }>,
  reply: FastifyReply
  // eslint-disable-next-line consistent-return
) => {
  try {
    /* ***************************************************** */
    /* 1. swap: input params                                 */
    /* ***************************************************** */
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const { channel_user_id, inputCurrency, outputCurrency, amount } = request.body;

    const lastBotMsgDelaySeconds = request.query?.lastBotMsgDelaySeconds ?? 0;
    const { tokens: blockchainTokens, networkConfig } = request.server as FastifyInstance;

    const tokenAddresses: TokenAddresses = getTokensAddresses(
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
    /* 2. swap: open concurrent operation         */
    /* ***************************************************** */
    const userOperations = await hasPhoneAnyOperationInProgress(channel_user_id);
    if (userOperations) {
      validationError = `Concurrent swap operation for phone: ${channel_user_id}.`;
      Logger.log(`swap, ${validationError}`);
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(
        reply,
        'You have another operation in progress. Please wait until it is finished.'
      );
    }
    await openOperation(channel_user_id, ConcurrentOperationsEnum.Swap);

    /* ***************************************************** */
    /* 3. swap: send initial response                        */
    /* ***************************************************** */
    // optimistic response
    Logger.log('swap', 'sending notification: operation in progress');
    await returnSuccessResponse(reply, COMMON_REPLY_OPERATION_IN_PROGRESS);

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
      validationError = `Insufficient balance, phone: ${channel_user_id}, wallet: ${proxyAddress}. Required: ${toTokenCurrentBalance}, Available: ${fromTokenCurrentBalance}.`;
      Logger.info('swap', validationError);
      await sendUserInsufficientBalanceNotification(proxyAddress, channel_user_id);
      await closeOperation(channel_user_id, ConcurrentOperationsEnum.Swap);
      return undefined;
    }

    /* ***************************************************** */
    /* 5. swap: check blockchain conditions                  */
    /* ***************************************************** */
    const checkBlockchainConditionsResult: CheckBalanceConditionsResult =
      await checkBlockchainConditions(networkConfig, channel_user_id);

    if (!checkBlockchainConditionsResult.success) {
      await sendNoValidBlockchainConditionsNotification(proxyAddress, channel_user_id);
      await closeOperation(channel_user_id, ConcurrentOperationsEnum.Swap);
      return undefined;
    }

    /* ***************************************************** */
    /* 6. swap: make operation                               */
    /* ***************************************************** */

    const executeSwapResult: ExecuteSwapResult = await executeSwap(
      networkConfig,
      checkBlockchainConditionsResult.setupContractsResult!,
      checkBlockchainConditionsResult.entryPointContract!,
      tokenAddresses,
      blockchainTokens,
      amount.toString(),
      proxyAddress
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
    const transactionOut: TransactionData = {
      tx: executeSwapResult.approveTransactionHash || '0x',
      walletFrom: proxyAddress,
      walletTo: networkConfig.contracts.routerAddress!,
      amount: fromTokensSentInUnits,
      token: inputCurrency,
      type: 'swap',
      status: 'completed'
    };
    await mongoTransactionService.saveTransaction(transactionOut);

    // Save transactions IN
    const transactionIn: TransactionData = {
      tx: executeSwapResult.swapTransactionHash || '0x',
      walletFrom: networkConfig.contracts.routerAddress!,
      walletTo: proxyAddress,
      amount: toTokensReceivedInUnits,
      token: outputCurrency,
      type: 'swap',
      status: 'completed'
    };
    await mongoTransactionService.saveTransaction(transactionIn);

    /* ***************************************************** */
    /* 8. swap: send notification to user                    */
    /* ***************************************************** */
    await closeOperation(channel_user_id, ConcurrentOperationsEnum.Swap);

    if (lastBotMsgDelaySeconds > 0) {
      Logger.log('swap', `Delaying bot notification ${lastBotMsgDelaySeconds} seconds.`);
      await delaySeconds(lastBotMsgDelaySeconds);
    }
    await sendSwapNotification(
      channel_user_id,
      inputCurrency,
      fromTokensSentInUnits.toString(),
      toTokensReceivedInUnits.toString(),
      outputCurrency,
      executeSwapResult.swapTransactionHash
    );

    Logger.info(
      'swap',
      `Swap completed successfully approveTransactionHash: ${executeSwapResult.approveTransactionHash}, swapTransactionHash: ${executeSwapResult.swapTransactionHash}.`
    );
  } catch (error) {
    Logger.error('swap', error);
  }
};

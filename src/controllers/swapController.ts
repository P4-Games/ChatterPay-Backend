import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { IUser } from '../models/userModel';
import { Logger } from '../helpers/loggerHelper';
import { delaySeconds } from '../helpers/timeHelper';
import { executeSwap } from '../services/swapService';
import { NotificationEnum } from '../models/templateModel';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import { getChatterpayTokenFee } from '../services/commonService';
import { setupERC20 } from '../services/web3/contractSetupService';
import { mongoUserService } from '../services/mongo/mongoUserService';
import { mongoTransactionService } from '../services/mongo/mongoTransactionService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import {
  getUser,
  openOperation,
  closeOperation,
  hasPhoneAnyOperationInProgress
} from '../services/userService';
import {
  SIGNING_KEY,
  COMMON_REPLY_WALLET_NOT_CREATED,
  COMMON_REPLY_OPERATION_IN_PROGRESS
} from '../config/constants';
import {
  swapTokensData,
  TransactionData,
  ExecuteSwapResult,
  ConcurrentOperationsEnum,
  CheckBalanceConditionsResult
} from '../types/commonType';
import {
  getSwapTokensData,
  checkBlockchainConditions,
  userReachedOperationLimit,
  userWithinTokenOperationLimits
} from '../services/blockchainService';
import {
  persistNotification,
  sendSwapNotification,
  getNotificationTemplate,
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
  tokenAddresses: swapTokensData
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

  if (!tokenAddresses.tokenInputAddress || !tokenAddresses.tokenOutputAddress) {
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
  let logKey = `[op:swap:${''}:${''}:${''}:${''}]`;

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

    const tokensData: swapTokensData = getSwapTokensData(
      networkConfig,
      blockchainTokens,
      inputCurrency,
      outputCurrency
    );

    let validationError: string = await validateInputs(request.body, tokensData);

    if (validationError) {
      return await returnErrorResponse(reply, 400, validationError);
    }

    /* ***************************************************** */
    /* 2. swap: check user has wallet                        */
    /* ***************************************************** */
    logKey = `[op:swap:${channel_user_id}:${inputCurrency}:${outputCurrency}:${amount}]`;
    const fromUser: IUser | null = await getUser(channel_user_id);
    if (!fromUser) {
      Logger.info('swap', logKey, COMMON_REPLY_WALLET_NOT_CREATED);
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
    }

    /* ***************************************************** */
    /* 3. swap: check operation limit                        */
    /* ***************************************************** */
    const userReachedOpLimit = await userReachedOperationLimit(
      request.server.networkConfig,
      channel_user_id,
      'swap'
    );
    if (userReachedOpLimit) {
      const { message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.daily_limit_reached
      );

      await persistNotification(channel_user_id, message, NotificationEnum.daily_limit_reached);

      Logger.info('swap', logKey, `${message}`);
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, message);
    }

    /* ***************************************************** */
    /* 4. makeTransaction: check amount limit                */
    /* ***************************************************** */
    const limitsResult = await userWithinTokenOperationLimits(
      channel_user_id,
      'swap',
      inputCurrency,
      networkConfig.chainId,
      amount
    );
    if (!limitsResult.isWithinLimits) {
      const { message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.amount_outside_limits
      );
      const formattedMessage = message
        .replace('[LIMIT_MIN]', limitsResult.min!.toString())
        .replace('[LIMIT_MAX]', limitsResult.max!.toString());
      Logger.info('swap', logKey, `${formattedMessage}`);

      await persistNotification(
        channel_user_id,
        formattedMessage,
        NotificationEnum.amount_outside_limits
      );

      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, formattedMessage);
    }

    /* ***************************************************** */
    /* 5. swap: check concurrent operation                    */
    /* ***************************************************** */
    const userOperations = await hasPhoneAnyOperationInProgress(channel_user_id);
    if (userOperations) {
      const { message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.concurrent_operation
      );
      await persistNotification(channel_user_id, message, NotificationEnum.concurrent_operation);

      validationError = `Concurrent swap operation for phone: ${channel_user_id}.`;
      Logger.log(`swap', ${logKey}, ${validationError}`);
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, message);
    }

    /* ***************************************************** */
    /* 6. swap: send initial response                        */
    /* ***************************************************** */
    // optimistic response
    await openOperation(channel_user_id, ConcurrentOperationsEnum.Swap);
    Logger.log('swap', logKey, 'sending notification: operation in progress');
    await returnSuccessResponse(reply, COMMON_REPLY_OPERATION_IN_PROGRESS);

    /* ***************************************************** */
    /* 7. swap: check user balance                           */
    /* ***************************************************** */
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
    const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);
    const proxyAddress = fromUser.wallets[0].wallet_proxy;

    // Get the contracts and decimals for the tokens
    const fromTokenContract = await setupERC20(tokensData.tokenInputAddress, backendSigner);
    const fromTokenDecimals = await fromTokenContract.decimals();

    const toTokenContract = await setupERC20(tokensData.tokenOutputAddress, backendSigner);
    const toTokenDecimals = await toTokenContract.decimals();

    // Get the current balances before the transaction
    const fromTokenCurrentBalance = await fromTokenContract.balanceOf(proxyAddress);
    const toTokenCurrentBalance = await toTokenContract.balanceOf(proxyAddress);

    const amountToCheck = ethers.utils.parseUnits(amount.toString(), fromTokenDecimals);
    const enoughBalance: boolean = fromTokenCurrentBalance.gte(amountToCheck);

    if (!enoughBalance) {
      validationError = `Insufficient balance, phone: ${channel_user_id}, wallet: ${proxyAddress}. Required: ${toTokenCurrentBalance}, Available: ${fromTokenCurrentBalance}.`;
      Logger.info('swap', logKey, validationError);
      await sendUserInsufficientBalanceNotification(proxyAddress, channel_user_id);
      await closeOperation(channel_user_id, ConcurrentOperationsEnum.Swap);
      return undefined;
    }

    /* ***************************************************** */
    /* 8. swap: check blockchain conditions                  */
    /* ***************************************************** */
    const checkBlockchainConditionsResult: CheckBalanceConditionsResult =
      await checkBlockchainConditions(networkConfig, fromUser);

    if (!checkBlockchainConditionsResult.success) {
      await sendNoValidBlockchainConditionsNotification(proxyAddress, channel_user_id);
      await closeOperation(channel_user_id, ConcurrentOperationsEnum.Swap);
      return undefined;
    }

    /* ***************************************************** */
    /* 9. swap: make operation                               */
    /* ***************************************************** */
    const executeSwapResult: ExecuteSwapResult = await executeSwap(
      networkConfig,
      checkBlockchainConditionsResult.setupContractsResult!,
      checkBlockchainConditionsResult.entryPointContract!,
      tokensData,
      blockchainTokens,
      amount.toString(),
      proxyAddress,
      logKey
    );
    if (!executeSwapResult.success) {
      await sendInternalErrorNotification(proxyAddress, channel_user_id, lastBotMsgDelaySeconds);
      await closeOperation(channel_user_id, ConcurrentOperationsEnum.Swap);
      return undefined;
    }

    /* ***************************************************** */
    /* 10. swap: update database with result                  */
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

    const chatterpayFee = await getChatterpayTokenFee(
      networkConfig.contracts.chatterPayAddress,
      checkBlockchainConditionsResult.setupContractsResult!.provider,
      tokensData.tokenInputAddress
    );

    // Save transactions OUT
    Logger.log('swap', logKey, 'Updating swap transactions in database.');
    const transactionOut: TransactionData = {
      tx: executeSwapResult.swapTransactionHash || '0x',
      walletFrom: proxyAddress,
      walletTo: networkConfig.contracts.routerAddress!,
      amount: fromTokensSentInUnits,
      fee: chatterpayFee,
      token: inputCurrency,
      type: 'swap',
      status: 'completed',
      chain_id: request.server.networkConfig.chainId
    };
    await mongoTransactionService.saveTransaction(transactionOut);

    // Save transactions IN
    const transactionIn: TransactionData = {
      tx: executeSwapResult.swapTransactionHash || '0x',
      walletFrom: networkConfig.contracts.routerAddress!,
      walletTo: proxyAddress,
      amount: toTokensReceivedInUnits,
      fee: 0, // no fee in token out
      token: outputCurrency,
      type: 'swap',
      status: 'completed',
      chain_id: request.server.networkConfig.chainId
    };
    await mongoTransactionService.saveTransaction(transactionIn);

    await mongoUserService.updateUserOperationCounter(channel_user_id, 'swap');

    /* ***************************************************** */
    /* 11. swap: send notification to user                   */
    /* ***************************************************** */

    await closeOperation(channel_user_id, ConcurrentOperationsEnum.Swap);

    if (lastBotMsgDelaySeconds > 0) {
      Logger.log('swap', logKey, `Delaying bot notification ${lastBotMsgDelaySeconds} seconds.`);
      await delaySeconds(lastBotMsgDelaySeconds);
    }
    await sendSwapNotification(
      channel_user_id,
      tokensData.tokenInputSymbol,
      fromTokensSentInUnits.toString(),
      toTokensReceivedInUnits.toString(),
      tokensData.tokenOutputSymbol,
      executeSwapResult.swapTransactionHash
    );

    Logger.info(
      'swap',
      logKey,
      `Swap completed successfully approveTransactionHash: ${executeSwapResult.approveTransactionHash}, swapTransactionHash: ${executeSwapResult.swapTransactionHash}.`
    );
  } catch (error) {
    Logger.error('swap', logKey, error);
  }
};

import { Web3 } from 'web3';
import { get } from '@google-cloud/trace-agent';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';
import { Span, Tracer } from '@google-cloud/trace-agent/build/src/plugin-types';

import { IToken } from '../models/tokenModel';
import { Logger } from '../helpers/loggerHelper';
import { delaySeconds } from '../helpers/timeHelper';
import { IUser, IUserWallet } from '../models/userModel';
import { NotificationEnum } from '../models/templateModel';
import { getChatterpayTokenFee } from '../services/commonService';
import { verifyWalletBalanceInRpc } from '../services/balanceService';
import { mongoUserService } from '../services/mongo/mongoUserService';
import Transaction, { ITransaction } from '../models/transactionModel';
import { sendTransferUserOperation } from '../services/transferService';
import { mongoTransactionService } from '../services/mongo/mongoTransactionService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { isValidPhoneNumber, isValidEthereumWallet } from '../helpers/validationHelper';
import {
  TransactionData,
  ExecueTransactionResult,
  ConcurrentOperationsEnum,
  CheckBalanceConditionsResult
} from '../types/commonType';
import {
  getTokenData,
  checkBlockchainConditions,
  userReachedOperationLimit,
  userWithinTokenOperationLimits
} from '../services/blockchainService';
import {
  getUser,
  openOperation,
  closeOperation,
  getOrCreateUser,
  getUserWalletByChainId,
  hasUserAnyOperationInProgress
} from '../services/userService';
import {
  INFURA_URL,
  INFURA_API_KEY,
  GCP_CLOUD_TRACE_ENABLED,
  COMMON_REPLY_WALLET_NOT_CREATED,
  COMMON_REPLY_OPERATION_IN_PROGRESS
} from '../config/constants';
import {
  persistNotification,
  getNotificationTemplate,
  sendInternalErrorNotification,
  sendOutgoingTransferNotification,
  sendReceivedTransferNotification,
  sendUserInsufficientBalanceNotification,
  sendNoValidBlockchainConditionsNotification
} from '../services/notificationService';

type PaginationQuery = { page?: string; limit?: string };
type MakeTransactionInputs = {
  channel_user_id: string;
  to: string;
  token: string;
  amount: string;
  chain_id?: string;
  user_notes?: string;
};

/**
 * Validates the inputs for making a transaction.
 */
const validateInputs = async (
  inputs: MakeTransactionInputs,
  currentChainId: number,
  tokenData: IToken | undefined
): Promise<string> => {
  const { channel_user_id, to, token, amount, chain_id } = inputs;

  if (!channel_user_id || !to || !token || !amount) {
    return 'One or more fields are empty';
  }
  if (Number.isNaN(parseFloat(amount))) {
    return 'The entered amount is invalid';
  }
  if (channel_user_id.trim() === to.trim()) {
    return 'You cannot send money to yourself';
  }
  if (!isValidEthereumWallet(channel_user_id) && !isValidPhoneNumber(channel_user_id)) {
    return `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a Wallet or phone number (without spaces or symbols)`;
  }
  if (!isValidEthereumWallet(to) && !isValidPhoneNumber(to)) {
    return `'${to}' is invalid. 'to' parameter must be a Wallet or phone number (without spaces or symbols)`;
  }
  if (token.length > 5) {
    return 'The token symbol is invalid';
  }

  const targetChainId = chain_id ? parseInt(chain_id, 10) : currentChainId;

  if (targetChainId !== currentChainId) {
    return 'The selected blockchain is currently unavailable';
  }

  if (!tokenData) {
    return 'The token is not available on the selected network';
  }

  return '';
};

/**
 * Checks the status of a transaction.
 */
export const checkTransactionStatus = async (
  request: FastifyRequest<{ Params: { trx_hash: string } }>,
  reply: FastifyReply
) => {
  const { trx_hash } = request.params;

  try {
    const web3 = new Web3(`${INFURA_URL}/${INFURA_API_KEY}`);

    const transaction = await Transaction.findOne({ trx_hash });
    if (!transaction) {
      return await returnErrorResponse(
        'checkTransactionStatus',
        '',
        reply,
        404,
        'Transaction not found'
      );
    }

    const receipt = await web3.eth.getTransactionReceipt(trx_hash);
    if (!receipt) {
      return await returnSuccessResponse(reply, 'pending');
    }

    transaction.status = receipt.status ? 'completed' : 'failed';
    await transaction.save();

    return await returnSuccessResponse(reply, transaction.status);
  } catch (error) {
    return returnErrorResponse('checkTransactionStatus', '', reply, 400, 'Bad Request');
  }
};

/**
 * Creates a new transaction.
 */
export const createTransaction = async (
  request: FastifyRequest<{ Body: ITransaction }>,
  reply: FastifyReply
) => {
  try {
    if (!request.body) {
      return await returnErrorResponse(
        'createTransaction',
        '',
        reply,
        400,
        'You have to send a body with this request'
      );
    }
    const newTransaction = new Transaction(request.body);
    await newTransaction.save();
    return await returnSuccessResponse(
      reply,
      'Transaction created successfully',
      newTransaction.toJSON()
    );
  } catch (error) {
    return returnErrorResponse(
      'createTransaction',
      '',
      reply,
      400,
      'Error creating transaction',
      (error as Error).message
    );
  }
};

/**
 * Retrieves all transactions with pagination.
 */
export const getAllTransactions = async (
  request: FastifyRequest<{ Querystring: PaginationQuery }>,
  reply: FastifyReply
) => {
  try {
    const page = parseInt(request.query.page ?? '1', 10);
    const limit = parseInt(request.query.limit ?? '50', 10);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      Transaction.find().skip(skip).limit(limit).lean(),
      Transaction.countDocuments()
    ]);

    return await returnSuccessResponse(reply, 'Transactions fetched successfully', {
      transactions,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      totalItems: total
    });
  } catch (error) {
    return returnErrorResponse(
      'getAllTransactions',
      '',
      reply,
      400,
      'Error fetching transactions',
      (error as Error).message
    );
  }
};

/**
 * Retrieves a transaction by ID.
 */
export const getTransactionById = async (
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) => {
  const { id } = request.params;

  try {
    const transaction = await Transaction.findById(id);
    if (!transaction) {
      return await returnErrorResponse(
        'getTransactionById',
        '',
        reply,
        404,
        'Transaction not found'
      );
    }
    return await returnSuccessResponse(
      reply,
      'Transaction fetched successfully',
      transaction.toJSON()
    );
  } catch (error) {
    return returnErrorResponse(
      'getTransactionById',
      '',
      reply,
      400,
      'Error fetching transaction',
      (error as Error).message
    );
  }
};

/**
 * Updates a transaction by ID.
 */
export const updateTransaction = async (
  request: FastifyRequest<{
    Params: { id: string };
    Body: Partial<ITransaction>;
  }>,
  reply: FastifyReply
) => {
  const { id } = request.params;

  try {
    if (!request.body) {
      return await returnErrorResponse(
        'updateTransaction',
        '',
        reply,
        400,
        'You have to send a body with this request'
      );
    }

    const updatedTransaction = await Transaction.findByIdAndUpdate(id, request.body, {
      new: true
    });
    if (!updatedTransaction) {
      return await returnErrorResponse(
        'updateTransaction',
        '',
        reply,
        404,
        'Transaction not found'
      );
    }
    return await returnSuccessResponse(
      reply,
      'Transaction updated successfully',
      updatedTransaction.toJSON()
    );
  } catch (error) {
    return returnErrorResponse(
      'updateTransaction',
      '',
      reply,
      400,
      'Error updating transaction',
      (error as Error).message
    );
  }
};

/**
 * Deletes a transaction by ID.
 */
export const deleteTransaction = async (
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) => {
  const { id } = request.params;

  try {
    const deletedTransaction = await Transaction.findByIdAndDelete(id);
    if (!deletedTransaction) {
      return await returnErrorResponse(
        'deleteTransaction',
        '',
        reply,
        404,
        'Transaction not found'
      );
    }
    return await returnSuccessResponse(reply, 'Transaction deleted successfully');
  } catch (error) {
    return returnErrorResponse(
      'deleteTransaction',
      '',
      reply,
      400,
      'Error deleting transaction',
      (error as Error).message
    );
  }
};

/**
 * Sanitize user notes for WhatsApp text channels.
 * - Allows: letters (all langs), marks, numbers, punctuation, symbols (incl. emojis), spaces/newlines.
 * - Removes: controls, surrogates, most invisibles (keeps ZWJ U+200D and VS16 U+FE0F for emoji ligatures).
 * - Optional: preserve WhatsApp formatting (* _ ~), strip backticks to avoid code formatting.
 * - Normalizes (NFKC), collapses whitespace, caps length.
 */
export function sanitizeUserNotesWhatsApp(
  input: string,
  options: { maxLen?: number; preserveWaFormatting?: boolean } = {}
): string {
  const { maxLen = 500, preserveWaFormatting = true } = options;
  if (!input) return '';

  // 1) Normalize
  let s = input.normalize('NFKC');

  // 2) Remove control (Cc) and surrogate (Cs) chars
  s = s.replace(/[\p{Cc}\p{Cs}]/gu, '');

  // 3) Remove most format (Cf) except ZWJ (200D) and VS16 (FE0F)
  s = Array.from(s)
    .filter((ch) => {
      const cp = ch.codePointAt(0)!;
      if (/\p{Cf}/u.test(ch)) return cp === 0x200d || cp === 0xfe0f;
      return true;
    })
    .join('');

  // 4) Keep only L/M/N/P/Z/S categories (covers letters, digits, punctuation, symbols/emojis, spaces)
  s = s.replace(/[^\p{L}\p{M}\p{N}\p{P}\p{Z}\p{S}]/gu, '');

  // 5) WhatsApp formatting policy
  if (preserveWaFormatting) {
    // Strip backticks to avoid code formatting (inline or triple)
    s = s.replace(/`+/g, '');
    // Keep *, _, ~ as-is for WA formatting
  } else {
    // Remove all formatting markers
    s = s.replace(/[*_~`]+/g, '');
  }

  // 6) Normalize line breaks & collapse whitespace
  s = s.replace(/\r\n?/g, '\n'); // CRLF/CR -> LF
  s = s.replace(/[ \t\f\v]+/g, ' '); // collapse spaces/tabs
  s = s.replace(/\n{3,}/g, '\n\n'); // max two consecutive newlines
  s = s.trim();

  // 7) Length guard
  if (s.length > maxLen) s = s.slice(0, maxLen);

  return s;
}

/**
 * Handles the make transaction request.
 *
 * @param request
 * @param reply
 * @returns
 */
export const makeTransaction = async (
  request: FastifyRequest<{
    Body: MakeTransactionInputs;
    Querystring?: { lastBotMsgDelaySeconds?: number };
  }>,
  reply: FastifyReply
  // eslint-disable-next-line consistent-return
) => {
  const isTracingEnabled = GCP_CLOUD_TRACE_ENABLED;
  const tracer: Tracer | undefined = isTracingEnabled ? get() : undefined;
  const rootSpan: Span | undefined = isTracingEnabled
    ? tracer?.createChildSpan({ name: 'makeTransaction' })
    : undefined;

  let logKey = `[op:transfer:${''}:${''}:${''}:${''}]`;

  try {
    const traceHeader = isTracingEnabled
      ? (request.headers['x-cloud-trace-context'] as string | undefined)
      : undefined;

    /* ***************************************************** */
    /* 1. makeTransaction: input params                      */
    /* ***************************************************** */
    if (!request.body) {
      rootSpan?.endSpan();
      return await returnErrorResponse(
        'makeTransaction',
        logKey,
        reply,
        400,
        'You have to send a body with this request'
      );
    }

    const { channel_user_id, to, token: tokenSymbol, amount, user_notes } = request.body;
    const lastBotMsgDelaySeconds = request.query?.lastBotMsgDelaySeconds || 0;
    const { networkConfig, tokens: tokensConfig } = request.server as FastifyInstance;
    const santizedUserNotes = sanitizeUserNotesWhatsApp(user_notes || '', {
      maxLen: 500,
      preserveWaFormatting: true
    });

    const tokenData: IToken | undefined = getTokenData(
      networkConfig,
      tokensConfig,
      tokenSymbol || '' // could be missing in body
    );

    let validationError: string = await validateInputs(
      request.body,
      networkConfig.chainId,
      tokenData
    );

    if (validationError) {
      rootSpan?.endSpan();
      return await returnErrorResponse(
        'makeTransaction',
        logKey,
        reply,
        400,
        'Error making transaction',
        validationError
      );
    }

    /* ***************************************************** */
    /* 2. makeTransaction: check user has wallet             */
    /* ***************************************************** */
    logKey = `[op:transfer:${channel_user_id || ''}:${to}:${amount}:${tokenSymbol}]`;
    const fromUser: IUser | null = await getUser(channel_user_id);
    if (!fromUser) {
      rootSpan?.endSpan();
      Logger.info('makeTransaction', logKey, COMMON_REPLY_WALLET_NOT_CREATED);
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
    }

    const userWallet: IUserWallet | null = getUserWalletByChainId(
      fromUser?.wallets,
      networkConfig.chainId
    );
    if (!userWallet) {
      validationError = `Wallet not found for user ${channel_user_id} and chain ${networkConfig.chainId}`;
      rootSpan?.endSpan();
      Logger.info('makeTransaction', logKey, validationError);
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, validationError);
    }

    /* ***************************************************** */
    /* 3. makeTransaction: check concurrent operation        */
    /* ***************************************************** */
    const concurrentOperationSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'checkConcurrentOperation' })
      : undefined;

    const userOperations = hasUserAnyOperationInProgress(fromUser);
    if (userOperations) {
      const { message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.concurrent_operation
      );
      await persistNotification(channel_user_id, message, NotificationEnum.concurrent_operation);

      validationError = `Concurrent transfer operation for wallet ${userWallet.wallet_proxy}, phone: ${fromUser.phone_number}.`;
      Logger.log('makeTransaction', logKey, validationError);
      concurrentOperationSpan?.endSpan();
      rootSpan?.endSpan();

      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, message);
    }

    /* ***************************************************** */
    /* 4. makeTransaction: check operation limit             */
    /* ***************************************************** */
    const userReachedOpLimit = await userReachedOperationLimit(
      request.server.networkConfig,
      channel_user_id,
      'transfer'
    );
    if (userReachedOpLimit) {
      const { message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.daily_limit_reached
      );

      await persistNotification(channel_user_id, message, NotificationEnum.daily_limit_reached);

      Logger.info('makeTransaction', logKey, `${message}`);
      concurrentOperationSpan?.endSpan();
      rootSpan?.endSpan();
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, message);
    }

    /* ***************************************************** */
    /* 5. makeTransaction: check amount limit                */
    /* ***************************************************** */
    const limitsResult = await userWithinTokenOperationLimits(
      channel_user_id,
      'transfer',
      tokenSymbol,
      networkConfig.chainId,
      parseFloat(amount)
    );
    if (!limitsResult.isWithinLimits) {
      const { message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.amount_outside_limits
      );
      const formattedMessage = message
        .replace('[LIMIT_MIN]', limitsResult.min!.toString())
        .replace('[LIMIT_MAX]', limitsResult.max!.toString());
      Logger.info('makeTransaction', logKey, `${formattedMessage}`);
      concurrentOperationSpan?.endSpan();
      rootSpan?.endSpan();

      await persistNotification(
        channel_user_id,
        formattedMessage,
        NotificationEnum.amount_outside_limits
      );

      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, formattedMessage);
    }

    /* ***************************************************** */
    /* 6. makeTransaction: send initial response             */
    /* ***************************************************** */
    await openOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
    concurrentOperationSpan?.endSpan();
    // optimistic response
    Logger.log('makeTransaction', logKey, 'sending notification: operation in progress');
    await returnSuccessResponse(reply, COMMON_REPLY_OPERATION_IN_PROGRESS);

    /* ***************************************************** */
    /* 7. makeTransaction: check user balance                */
    /* ***************************************************** */
    const balanceCheckSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'checkUserBalance' })
      : undefined;

    const checkBalanceResult = await verifyWalletBalanceInRpc(
      networkConfig.rpc,
      tokenData!.address,
      userWallet.wallet_proxy,
      amount
    );

    if (!checkBalanceResult.enoughBalance) {
      validationError = `Insufficient balance, phone: ${fromUser.phone_number}, wallet: ${userWallet.wallet_proxy}. Required: ${checkBalanceResult.amountToCheck}, Available: ${checkBalanceResult.walletBalance}.`;
      Logger.info('makeTransaction', logKey, validationError);
      await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
      await sendUserInsufficientBalanceNotification(
        userWallet.wallet_proxy,
        channel_user_id,
        traceHeader
      );
      balanceCheckSpan?.endSpan();
      rootSpan?.endSpan();
      return undefined;
    }
    balanceCheckSpan?.endSpan();

    /* ***************************************************** */
    /* 8. makeTransaction: check blockchain conditions       */
    /* ***************************************************** */
    const blockchainCheckSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'checkBlockchainConditions' })
      : undefined;

    const checkBlockchainConditionsResult: CheckBalanceConditionsResult =
      await checkBlockchainConditions(networkConfig, fromUser);

    if (!checkBlockchainConditionsResult.success) {
      await sendNoValidBlockchainConditionsNotification(
        userWallet.wallet_proxy,
        channel_user_id,
        traceHeader
      );
      await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
      blockchainCheckSpan?.endSpan();
      rootSpan?.endSpan();
      return undefined;
    }

    blockchainCheckSpan?.endSpan();

    /* ***************************************************** */
    /* 9. makeTransaction: get or create user 'to'           */
    /* ***************************************************** */
    const userCreationSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'getOrCreateUser' })
      : undefined;

    let toUser: IUser | null;
    let toAddress: string;

    if (to.startsWith('0x')) {
      toAddress = to;
      toUser = null;
    } else {
      const chatterpayProxyAddress: string = networkConfig.contracts.chatterPayAddress;
      const { factoryAddress } = networkConfig.contracts;
      toUser = await getOrCreateUser(to, chatterpayProxyAddress, factoryAddress);
      toAddress = toUser.wallets[0].wallet_proxy;
    }
    userCreationSpan?.endSpan();

    /* ***************************************************** */
    /* 10. makeTransaction: executeTransaction                */
    /* ***************************************************** */
    const transactionExecutionSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'executeTransaction' })
      : undefined;

    const executeTransactionResult: ExecueTransactionResult = await sendTransferUserOperation(
      networkConfig,
      checkBlockchainConditionsResult.setupContractsResult!,
      checkBlockchainConditionsResult.entryPointContract!,
      userWallet.wallet_proxy,
      toAddress,
      tokenData!.address,
      amount,
      logKey
    );

    if (!executeTransactionResult.success) {
      await sendInternalErrorNotification(channel_user_id, lastBotMsgDelaySeconds, traceHeader);
      await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
      transactionExecutionSpan?.endSpan();
      rootSpan?.endSpan();
      return undefined;
    }

    transactionExecutionSpan?.endSpan();

    /* ***************************************************** */
    /* 11. makeTransaction: update transaction in bdd        */
    /* ***************************************************** */
    const saveTransactionSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'saveTransactionPending' })
      : undefined;

    const chatterpayFee = await getChatterpayTokenFee(
      userWallet.wallet_proxy,
      checkBlockchainConditionsResult.setupContractsResult!.provider,
      tokenData!.address
    );

    Logger.log('makeTransaction', logKey, 'Updating transaction in database.');
    const transactionOut: TransactionData = {
      tx: executeTransactionResult.transactionHash,
      walletFrom: userWallet.wallet_proxy,
      walletTo: toAddress,
      amount: parseFloat(amount),
      fee: chatterpayFee,
      token: tokenSymbol,
      type: 'transfer',
      status: 'completed',
      chain_id: request.server.networkConfig.chainId,
      user_notes: santizedUserNotes
    };
    await mongoTransactionService.saveTransaction(transactionOut);
    saveTransactionSpan?.endSpan();

    await mongoUserService.updateUserOperationCounter(channel_user_id, 'transfer');

    /* ***************************************************** */
    /* 12. makeTransaction: send user notification           */
    /* ***************************************************** */
    const notificationSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'sendUserNotifications' })
      : undefined;

    await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);

    if (lastBotMsgDelaySeconds > 0) {
      Logger.log(
        'makeTransaction',
        logKey,
        `Delaying bot notification ${lastBotMsgDelaySeconds} seconds.`
      );
      await delaySeconds(lastBotMsgDelaySeconds);
    }

    const amountAfterFeeDecimals = tokenData?.display_decimals;
    const amountAfterFee = (parseFloat(amount) - chatterpayFee).toFixed(amountAfterFeeDecimals);

    await sendOutgoingTransferNotification(
      fromUser.phone_number,
      toUser?.phone_number ?? toAddress,
      toUser?.name ?? '',
      amount,
      tokenData!.symbol,
      santizedUserNotes,
      executeTransactionResult.transactionHash,
      traceHeader
    );

    // In case the to user is a ChatterPay, send the received notification
    if (toUser) {
      await sendReceivedTransferNotification(
        fromUser.phone_number,
        fromUser.name,
        toUser.phone_number,
        amountAfterFee.toString(),
        tokenData!.symbol,
        santizedUserNotes,
        traceHeader
      );
    }

    notificationSpan?.endSpan();
    rootSpan?.endSpan();
    Logger.info('makeTransaction', logKey, `Maketransaction completed successfully.`);
  } catch (error) {
    rootSpan?.addLabel('error', (error as Error).message);
    rootSpan?.endSpan();
    Logger.error('makeTransaction', logKey, error);
  }
};

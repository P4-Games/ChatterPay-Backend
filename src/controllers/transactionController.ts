import { Web3 } from 'web3';
import { get } from '@google-cloud/trace-agent';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';
import { Span, Tracer } from '@google-cloud/trace-agent/build/src/plugin-types';

import { Logger } from '../helpers/loggerHelper';
import { IUser, IUserWallet } from '../models/userModel';
import { sendUserOperation } from '../services/transferService';
import { verifyWalletBalanceInRpc } from '../services/balanceService';
import { mongoUserService } from '../services/mongo/mongoUserService';
import Transaction, { ITransaction } from '../models/transactionModel';
import { mongoTransactionService } from '../services/mongo/mongoTransactionService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { isValidPhoneNumber, isValidEthereumWallet } from '../helpers/validationHelper';
import { INFURA_URL, INFURA_API_KEY, GCP_CLOUD_TRACE_ENABLED } from '../config/constants';
import { getTokenAddress, checkBlockchainConditions } from '../services/blockchainService';
import {
  TransactionData,
  ExecueTransactionResult,
  ConcurrentOperationsEnum,
  CheckBalanceConditionsResult
} from '../types/commonType';
import {
  openOperation,
  closeOperation,
  getOrCreateUser,
  getUserWalletByChainId,
  getUserByWalletAndChainid,
  hasUserAnyOperationInProgress
} from '../services/userService';
import {
  sendInternalErrorNotification,
  sendReceivedTransferNotification,
  sendOutgoingTransferNotification,
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
};

/**
 * Validates the inputs for making a transaction.
 */
const validateInputs = async (
  inputs: MakeTransactionInputs,
  currentChainId: number,
  tokenAddress: string
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

  if (!tokenAddress) {
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
      return await returnErrorResponse(reply, 404, 'Transaction not found');
    }

    const receipt = await web3.eth.getTransactionReceipt(trx_hash);
    if (!receipt) {
      return await returnSuccessResponse(reply, 'pending');
    }

    transaction.status = receipt.status ? 'completed' : 'failed';
    await transaction.save();

    return await returnSuccessResponse(reply, transaction.status);
  } catch (error) {
    Logger.error('checkTransactionStatus', error);
    return returnErrorResponse(reply, 400, 'Bad Request');
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
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }
    const newTransaction = new Transaction(request.body);
    await newTransaction.save();
    return await returnSuccessResponse(
      reply,
      'Transaction created successfully',
      newTransaction.toJSON()
    );
  } catch (error) {
    Logger.error('createTransaction', error);
    return returnErrorResponse(reply, 400, 'Error creating transaction', (error as Error).message);
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
    Logger.error('getAllTransactions', error);
    return returnErrorResponse(reply, 400, 'Error fetching transactions', (error as Error).message);
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
      return await returnErrorResponse(reply, 404, 'Transaction not found');
    }
    return await returnSuccessResponse(
      reply,
      'Transaction fetched successfully',
      transaction.toJSON()
    );
  } catch (error) {
    Logger.error('getTransactionById', error);
    return returnErrorResponse(reply, 400, 'Error fetching transaction', (error as Error).message);
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
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const updatedTransaction = await Transaction.findByIdAndUpdate(id, request.body, {
      new: true
    });
    if (!updatedTransaction) {
      return await returnErrorResponse(reply, 404, 'Transaction not found');
    }
    return await returnSuccessResponse(
      reply,
      'Transaction updated successfully',
      updatedTransaction.toJSON()
    );
  } catch (error) {
    Logger.error('updateTransaction', error);
    return returnErrorResponse(reply, 400, 'Error updating transaction', (error as Error).message);
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
      return await returnErrorResponse(reply, 404, 'Transaction not found');
    }
    return await returnSuccessResponse(reply, 'Transaction deleted successfully');
  } catch (error) {
    Logger.error('deleteTransaction', error);
    return returnErrorResponse(reply, 400, 'Error deleting transaction', (error as Error).message);
  }
};

/**
 * Handles the make transaction request.
 *
 * @param request
 * @param reply
 * @returns
 */
export const makeTransaction = async (
  request: FastifyRequest<{ Body: MakeTransactionInputs }>,
  reply: FastifyReply
  // eslint-disable-next-line consistent-return
) => {
  const isTracingEnabled = GCP_CLOUD_TRACE_ENABLED;
  const tracer: Tracer | undefined = isTracingEnabled ? get() : undefined;
  const rootSpan: Span | undefined = isTracingEnabled
    ? tracer?.createChildSpan({ name: 'makeTransaction' })
    : undefined;

  try {
    const traceHeader = isTracingEnabled
      ? (request.headers['x-cloud-trace-context'] as string | undefined)
      : undefined;

    /* ***************************************************** */
    /* 1. makeTransaction: input params                      */
    /* ***************************************************** */
    if (!request.body) {
      rootSpan?.endSpan();
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const { channel_user_id, to, token: tokenSymbol, amount } = request.body;
    const { networkConfig, tokens: tokensConfig } = request.server as FastifyInstance;

    const tokenAddress: string = getTokenAddress(
      networkConfig,
      tokensConfig,
      tokenSymbol || '' // could be missing in body
    );

    let validationError: string = await validateInputs(
      request.body,
      networkConfig.chain_id,
      tokenAddress
    );

    if (validationError) {
      rootSpan?.endSpan();
      return await returnErrorResponse(reply, 400, 'Error making transaction', validationError);
    }

    const fromUser: IUser | null = await mongoUserService.getUser(channel_user_id);
    if (!fromUser) {
      validationError = 'User not found. You must have an account to make a transaction';
      rootSpan?.endSpan();
      return await returnErrorResponse(reply, 400, 'Error making transaction', validationError);
    }

    const userWallet: IUserWallet | null = getUserWalletByChainId(
      fromUser?.wallets,
      networkConfig.chain_id
    );
    if (!userWallet) {
      validationError = `Wallet not found for user ${channel_user_id} and chain ${networkConfig.chain_id}`;
      rootSpan?.endSpan();
      return await returnErrorResponse(reply, 400, 'Error making transaction', validationError);
    }

    /* ***************************************************** */
    /* 2. makeTransaction: open concurrent operation      */
    /* ***************************************************** */
    const concurrentOperationSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'checkConcurrentOperation' })
      : undefined;

    const userOperations = hasUserAnyOperationInProgress(fromUser);
    if (userOperations) {
      validationError = `Concurrent transfer operation for wallet ${userWallet.wallet_proxy}, phone: ${fromUser.phone_number}.`;
      Logger.log('makeTransaction', validationError);
      concurrentOperationSpan?.endSpan();
      rootSpan?.endSpan();
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(
        reply,
        'You have another operation in progress. Please wait until it is finished.'
      );
    }

    await openOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
    concurrentOperationSpan?.endSpan();

    /* ***************************************************** */
    /* 3. makeTransaction: send initial response             */
    /* ***************************************************** */
    await returnSuccessResponse(reply, 'The transfer is in progress, it may take a few minutes.');

    /* ***************************************************** */
    /* 4. makeTransaction: check user balance                */
    /* ***************************************************** */
    const balanceCheckSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'checkUserBalance' })
      : undefined;

    const checkBalanceResult = await verifyWalletBalanceInRpc(
      networkConfig.rpc,
      tokenAddress,
      userWallet.wallet_proxy,
      amount
    );

    if (!checkBalanceResult.enoughBalance) {
      validationError = `Insufficient balance, phone: ${fromUser.phone_number}, wallet: ${userWallet.wallet_proxy}. Required: ${checkBalanceResult.amountToCheck}, Available: ${checkBalanceResult.walletBalance}.`;
      Logger.log('makeTransaction', validationError);
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
    /* 5. makeTransaction: check blockchain conditions       */
    /* ***************************************************** */
    const blockchainCheckSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'checkBlockchainConditions' })
      : undefined;

    const checkBlockchainConditionsResult: CheckBalanceConditionsResult =
      await checkBlockchainConditions(networkConfig, channel_user_id);

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
    /* 6. makeTransaction: get or create user 'to'           */
    /* ***************************************************** */
    const userCreationSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'getOrCreateUser' })
      : undefined;

    let toUser: IUser | null;
    let toAddress: string;

    if (to.startsWith('0x')) {
      toUser = await getUserByWalletAndChainid(to, networkConfig.chain_id);
      if (!toUser) {
        Logger.error(
          'makeTransaction',
          `Invalid wallet-to ${to} for chainId ${networkConfig.chain_id}`
        );
        await sendNoValidBlockchainConditionsNotification(
          userWallet.wallet_proxy,
          channel_user_id,
          traceHeader
        );
        await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
        userCreationSpan?.endSpan();
        rootSpan?.endSpan();
        return undefined;
      }

      // we already validate that exists wallet for this chain_id with find in getUserByWalletAndChainid
      toAddress =
        getUserWalletByChainId(toUser.wallets, networkConfig.chain_id)?.wallet_proxy || '';
    } else {
      const chatterpayImplementation: string = networkConfig.contracts.chatterPayAddress;
      toUser = await getOrCreateUser(to, chatterpayImplementation);
      toAddress = toUser.wallets[0].wallet_proxy;
    }
    userCreationSpan?.endSpan();

    /* ***************************************************** */
    /* 7. makeTransaction: save trx with pending status      */
    /* ***************************************************** */

    // TODO: makeTransaction: save transaction with pending status

    /* ***************************************************** */
    /* 8. makeTransaction: executeTransaction                */
    /* ***************************************************** */
    const transactionExecutionSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'executeTransaction' })
      : undefined;

    const executeTransactionResult: ExecueTransactionResult = await sendUserOperation(
      networkConfig,
      checkBlockchainConditionsResult.setupContractsResult!,
      checkBlockchainConditionsResult.entryPointContract!,
      userWallet.wallet_proxy,
      toAddress,
      tokenAddress,
      amount
    );

    if (!executeTransactionResult.success) {
      await sendInternalErrorNotification(userWallet.wallet_proxy, channel_user_id, traceHeader);
      await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
      transactionExecutionSpan?.endSpan();
      rootSpan?.endSpan();
      return undefined;
    }

    transactionExecutionSpan?.endSpan();

    /* ***************************************************** */
    /* 9. makeTransaction: update transaction in bdd         */
    /* ***************************************************** */
    const saveTransactionSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'saveTransactionPending' })
      : undefined;

    Logger.log('makeTransaction', 'Updating transaction in database.');
    const transactionOut: TransactionData = {
      tx: executeTransactionResult.transactionHash,
      walletFrom: userWallet.wallet_proxy,
      walletTo: toAddress,
      amount: parseFloat(amount),
      token: tokenSymbol,
      type: 'transfer',
      status: 'completed'
    };
    await mongoTransactionService.saveTransaction(transactionOut);
    saveTransactionSpan?.endSpan();

    /* ***************************************************** */
    /* 10. makeTransaction: send user notification           */
    /* ***************************************************** */
    const notificationSpan = isTracingEnabled
      ? tracer?.createChildSpan({ name: 'sendUserNotifications' })
      : undefined;

    await sendOutgoingTransferNotification(
      fromUser.phone_number,
      toUser.phone_number,
      toUser.name,
      amount,
      tokenSymbol,
      executeTransactionResult.transactionHash,
      traceHeader
    );

    await sendReceivedTransferNotification(
      fromUser.phone_number,
      fromUser.name,
      toUser.phone_number,
      amount,
      tokenSymbol,
      traceHeader
    );

    await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);

    notificationSpan?.endSpan();
    rootSpan?.endSpan();
    Logger.info('makeTransaction', `Maketransaction completed successfully.`);
  } catch (error) {
    rootSpan?.addLabel('error', (error as Error).message);
    rootSpan?.endSpan();
    Logger.error('makeTransaction', error);
  }
};

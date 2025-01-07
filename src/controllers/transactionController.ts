import { Web3 } from 'web3';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { User, IUser } from '../models/user';
import { Logger } from '../helpers/loggerHelper';
import { INFURA_API_KEY } from '../config/constants';
import { getOrCreateUser } from '../services/userService';
import Transaction, { ITransaction } from '../models/transaction';
import { verifyWalletBalanceInRpc } from '../services/walletService';
import { saveTransaction, sendUserOperation } from '../services/transferService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { getTokenAddress, checkBlockchainConditions } from '../services/blockchainService';
import { ExecueTransactionResultType, CheckBalanceConditionsResultType } from '../types/common';
import {
  sendTransferNotification,
  sendInternalErrorNotification,
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
  if (channel_user_id === to) {
    return 'You cannot send money to yourself';
  }
  if (
    channel_user_id.length > 15 ||
    (to.startsWith('0x') && !Number.isNaN(parseInt(to, 10)) && to.length <= 15)
  ) {
    return 'The phone number is invalid';
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
    const web3 = new Web3(`https://mainnet.infura.io/v3/${INFURA_API_KEY}`);

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
    Logger.error('Error checking transaction status:', error);
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
    Logger.error('Error creating transaction:', error);
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
    Logger.error('Error fetching transactions:', error);
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
    Logger.error('Error fetching transaction:', error);
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
    Logger.error('Error updating transaction:', error);
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
    Logger.error('Error deleting transaction:', error);
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
  try {
    /* ***************************************************** */
    /* 1. makeTransaction: input params                      */
    /* ***************************************************** */
    if (!request.body) {
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
      return await returnErrorResponse(reply, 400, 'Error making transaction', validationError);
    }

    const fromUser: IUser | null = await User.findOne({ phone_number: channel_user_id });
    if (!fromUser) {
      validationError = 'User not found. You must have an account to make a transaction';
      return await returnErrorResponse(reply, 400, 'Error making transaction', validationError);
    }

    /* ***************************************************** */
    /* 2. makeTransaction: send initial response             */
    /* ***************************************************** */
    await returnSuccessResponse(reply, 'The transfer is in progress, it may take a few minutes.');

    /* ***************************************************** */
    /* 3. makeTransaction: check user balance                */
    /* ***************************************************** */
    const checkBalanceResult = await verifyWalletBalanceInRpc(
      networkConfig.rpc,
      tokenAddress,
      fromUser.wallet,
      amount
    );

    if (!checkBalanceResult.enoughBalance) {
      validationError = `Insufficient balance in wwallet ${fromUser.wallet}. Required: ${checkBalanceResult.amountToCheck}, Available: ${checkBalanceResult.walletBalance}.`;
      Logger.log(`makeTransaction: ${validationError}`);
      await sendUserInsufficientBalanceNotification(fromUser.wallet, channel_user_id);
      return undefined;
    }

    /* ***************************************************** */
    /* 4. makeTransaction: check blockchain conditions       */
    /* ***************************************************** */
    const checkBlockchainConditionsResult: CheckBalanceConditionsResultType =
      await checkBlockchainConditions(networkConfig, channel_user_id);

    if (!checkBlockchainConditionsResult.success) {
      await sendNoValidBlockchainConditionsNotification(fromUser.wallet, channel_user_id);
      return undefined;
    }

    /* ***************************************************** */
    /* 5. makeTransaction: get or create user 'to'           */
    /* ***************************************************** */
    let toUser: IUser | { wallet: string };
    if (to.startsWith('0x')) {
      toUser = { wallet: to };
    } else {
      toUser = await getOrCreateUser(to);
    }

    /* ***************************************************** */
    /* 6. makeTransaction: save trx with pending status      */
    /* ***************************************************** */

    // TODO: makeTransaction: save transaction with pending status

    /* ***************************************************** */
    /* 7. makeTransaction: executeTransaction                */
    /* ***************************************************** */
    const executeTransactionResult: ExecueTransactionResultType = await sendUserOperation(
      networkConfig,
      checkBlockchainConditionsResult.setupContractsResult!,
      checkBlockchainConditionsResult.entryPointContract!,
      fromUser.wallet,
      toUser.wallet,
      tokenAddress,
      amount
    );

    if (!executeTransactionResult.success) {
      await sendInternalErrorNotification(fromUser.wallet, channel_user_id);
      return undefined;
    }

    /* ***************************************************** */
    /* 8. makeTransaction: update transaction in bdd         */
    /* ***************************************************** */
    Logger.log('Updating transaction in database.');
    await saveTransaction(
      executeTransactionResult.transactionHash,
      fromUser.wallet,
      toUser.wallet,
      parseFloat(amount),
      tokenSymbol,
      'transfer',
      'completed'
    );

    /* ***************************************************** */
    /* 9. makeTransaction: sen user notification             */
    /* ***************************************************** */
    const fromName = fromUser.name ?? fromUser.phone_number ?? 'Alguien';
    const toNumber = 'phone_number' in toUser ? toUser.phone_number : toUser.wallet;

    await sendTransferNotification(toNumber, fromName, amount, tokenSymbol);

    await sendOutgoingTransferNotification(
      fromUser.wallet,
      fromUser.phone_number,
      toNumber,
      amount,
      tokenSymbol,
      executeTransactionResult.transactionHash
    );

    Logger.info(`Maketransaction completed successfully.`);
  } catch (error) {
    Logger.error('Error making transaction:', error);
  }
};

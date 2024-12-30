import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import web3 from '../utils/web3_config';
import { User, IUser } from '../models/user';
import { getOrCreateUser } from '../services/userService';
import { getTokenAddress } from '../services/blockchainService';
import { executeTransaction } from '../services/transferService';
import Transaction, { ITransaction } from '../models/transaction';
import { verifyWalletBalanceInRpc } from '../services/walletService';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';

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
    console.error('Error checking transaction status:', error);
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
    console.error('Error creating transaction:', error);
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
    console.error('Error fetching transactions:', error);
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
    console.error('Error fetching transaction:', error);
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
    console.error('Error updating transaction:', error);
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
    console.error('Error deleting transaction:', error);
    return returnErrorResponse(reply, 400, 'Error deleting transaction', (error as Error).message);
  }
};

/**
 * Handles the make transaction request.
 */
export const makeTransaction = async (
  request: FastifyRequest<{ Body: MakeTransactionInputs }>,
  reply: FastifyReply
) => {
  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const { channel_user_id, to, token: tokenSymbol, amount, chain_id } = request.body;
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

    const checkBalanceResult = await verifyWalletBalanceInRpc(
      networkConfig.rpc,
      tokenAddress,
      fromUser.wallet,
      amount
    );

    if (!checkBalanceResult.enoughBalance) {
      validationError = `Insufficient balance in wwallet ${fromUser.wallet}. Required: ${checkBalanceResult.amountToCheck}, Available: ${checkBalanceResult.walletBalance}.`;
      return await returnErrorResponse(reply, 400, 'Error making transaction', validationError);
    }

    let toUser: IUser | { wallet: string };
    if (to.startsWith('0x')) {
      toUser = { wallet: to };
    } else {
      toUser = await getOrCreateUser(to);
    }

    executeTransaction(
      request.server.networkConfig,
      fromUser,
      toUser,
      tokenAddress,
      tokenSymbol,
      amount,
      chain_id ? parseInt(chain_id, 10) : networkConfig.chain_id
    );

    return await returnSuccessResponse(
      reply,
      'The transfer is in progress, it may take a few minutes.'
    );
  } catch (error) {
    console.error('Error making transaction:', error);
    return returnErrorResponse(reply, 400, 'Error making transaction', (error as Error).message);
  }
};

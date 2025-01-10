import { Web3 } from 'web3';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { IUser, IUserWallet } from '../models/user';
import { INFURA_API_KEY } from '../config/constants';
import Transaction, { ITransaction } from '../models/transaction';
import { verifyWalletBalanceInRpc } from '../services/walletService';
import { saveTransaction, sendUserOperation } from '../services/transferService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { isValidPhoneNumber, isValidEthereumWallet } from '../helpers/validationHelper';
import { getTokenAddress, checkBlockchainConditions } from '../services/blockchainService';
import {
  ConcurrentOperationsEnum,
  ExecueTransactionResultType,
  CheckBalanceConditionsResultType
} from '../types/common';
import {
  getUser,
  openOperation,
  closeOperation,
  getOrCreateUser,
  getUserWalletByChainId,
  getUserByWalletAndChainid,
  hasUserOperationInProgress
} from '../services/userService';
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

    const fromUser: IUser | null = await getUser(channel_user_id);
    if (!fromUser) {
      validationError = 'User not found. You must have an account to make a transaction';
      return await returnErrorResponse(reply, 400, 'Error making transaction', validationError);
    }

    const userWallet: IUserWallet | null = getUserWalletByChainId(
      fromUser?.wallets,
      networkConfig.chain_id
    );
    if (!userWallet) {
      validationError = `Wallet not found for user ${channel_user_id} and chain ${networkConfig.chain_id}`;
      return await returnErrorResponse(reply, 400, 'Error making transaction', validationError);
    }

    /* ***************************************************** */
    /* 2. makeTransaction: open concurrent operation      */
    /* ***************************************************** */
    if (hasUserOperationInProgress(fromUser, ConcurrentOperationsEnum.Transfer)) {
      validationError = `Concurrent transfer operation for wallet ${userWallet.wallet_proxy}, phone: ${fromUser.phone_number}.`;
      Logger.log(`makeTransaction: ${validationError}`);
      return await returnErrorResponse(reply, 400, 'Error making transaction', validationError);
    }
    await openOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);

    /* ***************************************************** */
    /* 3. makeTransaction: send initial response             */
    /* ***************************************************** */
    await returnSuccessResponse(reply, 'The transfer is in progress, it may take a few minutes.');

    /* ***************************************************** */
    /* 4. makeTransaction: check user balance                */
    /* ***************************************************** */
    const checkBalanceResult = await verifyWalletBalanceInRpc(
      networkConfig.rpc,
      tokenAddress,
      userWallet.wallet_proxy,
      amount
    );

    if (!checkBalanceResult.enoughBalance) {
      validationError = `Insufficient balance, phone: ${fromUser.phone_number}, wallet: ${userWallet.wallet_proxy}. Required: ${checkBalanceResult.amountToCheck}, Available: ${checkBalanceResult.walletBalance}.`;
      Logger.log(`makeTransaction: ${validationError}`);
      await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
      await sendUserInsufficientBalanceNotification(userWallet.wallet_proxy, channel_user_id);
      return undefined;
    }

    /* ***************************************************** */
    /* 5. makeTransaction: check blockchain conditions       */
    /* ***************************************************** */
    const checkBlockchainConditionsResult: CheckBalanceConditionsResultType =
      await checkBlockchainConditions(networkConfig, channel_user_id);

    if (!checkBlockchainConditionsResult.success) {
      await sendNoValidBlockchainConditionsNotification(userWallet.wallet_proxy, channel_user_id);
      await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
      return undefined;
    }

    /* ***************************************************** */
    /* 6. makeTransaction: get or create user 'to'           */
    /* ***************************************************** */
    let toUser: IUser | null;
    let toAddress: string;

    if (to.startsWith('0x')) {
      toUser = await getUserByWalletAndChainid(to, networkConfig.chain_id);
      if (!toUser) {
        Logger.error(`Invalid wallet-to ${to} for chainId ${networkConfig.chain_id}`);
        await sendNoValidBlockchainConditionsNotification(userWallet.wallet_proxy, channel_user_id);
        await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
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

    /* ***************************************************** */
    /* 7. makeTransaction: save trx with pending status      */
    /* ***************************************************** */

    // TODO: makeTransaction: save transaction with pending status

    /* ***************************************************** */
    /* 8. makeTransaction: executeTransaction                */
    /* ***************************************************** */
    const executeTransactionResult: ExecueTransactionResultType = await sendUserOperation(
      networkConfig,
      checkBlockchainConditionsResult.setupContractsResult!,
      checkBlockchainConditionsResult.entryPointContract!,
      userWallet.wallet_proxy,
      toAddress,
      tokenAddress,
      amount
    );

    if (!executeTransactionResult.success) {
      await sendInternalErrorNotification(userWallet.wallet_proxy, channel_user_id);
      await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
      return undefined;
    }

    /* ***************************************************** */
    /* 9. makeTransaction: update transaction in bdd         */
    /* ***************************************************** */
    Logger.log('Updating transaction in database.');
    await saveTransaction(
      executeTransactionResult.transactionHash,
      userWallet.wallet_proxy,
      toAddress,
      parseFloat(amount),
      tokenSymbol,
      'transfer',
      'completed'
    );

    /* ***************************************************** */
    /* 10. makeTransaction: sen user notification             */
    /* ***************************************************** */
    const fromName = fromUser.name ?? fromUser.phone_number ?? 'Alguien';

    await sendTransferNotification(toUser.phone_number, fromName, amount, tokenSymbol);

    await sendOutgoingTransferNotification(
      userWallet.wallet_proxy,
      fromUser.phone_number,
      toAddress,
      amount,
      tokenSymbol,
      executeTransactionResult.transactionHash
    );

    await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
    Logger.info(`Maketransaction completed successfully.`);
  } catch (error) {
    Logger.error('Error making transaction:', error);
  }
};

import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import web3 from '../utils/web3_config';
import { User, IUser } from '../models/user';
import { sendUserOperation } from '../services/transferService';
import Transaction, { ITransaction } from '../models/transaction';
import { computeProxyAddressFromPhone } from '../services/predictWalletService';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';
import { sendTransferNotification, sendOutgoingTransferNotification } from './replyController';

type PaginationQuery = { page?: string; limit?: string };
type MakeTransactionInputs = {
    channel_user_id: string;
    to: string;
    token: string;
    amount: string;
    chain_id?: string;
};

/**
 * Gets token address from the decorator
 */
function getTokenAddress(fastify: FastifyInstance, tokenSymbol: string, chainId: number): string {
    const { tokens } = fastify;
    const token = tokens.find(
        t => t.symbol.toLowerCase() === tokenSymbol.toLowerCase() && t.chain_id === chainId
    );

    if (!token) {
        throw new Error(`Token ${tokenSymbol} not found for chain ${chainId}`);
    }

    return token.address;
}

/**
 * Validates the inputs for making a transaction.
 */
const validateInputs = async (inputs: MakeTransactionInputs, fastify: FastifyInstance): Promise<string> => {
    const { channel_user_id, to, token, amount, chain_id } = inputs;
    const { networkConfig } = fastify;

    if (!channel_user_id || !to || !token || !amount) {
        return 'Alguno o multiples campos están vacíos';
    }
    if (Number.isNaN(parseFloat(amount))) {
        return 'El monto ingresado no es correcto';
    }
    if (channel_user_id === to) {
        return 'No puedes enviar dinero a ti mismo';
    }
    if (
        channel_user_id.length > 15 ||
        (to.startsWith('0x') && !Number.isNaN(parseInt(to, 10)) && to.length <= 15)
    ) {
        return 'El número de telefono no es válido';
    }
    if (token.length > 5) {
        return 'El símbolo del token no es válido';
    }

    const targetChainId = chain_id ? parseInt(chain_id, 10) : networkConfig.chain_id;

    // Validate chain_id
    if (targetChainId !== networkConfig.chain_id) {
        return 'La blockchain seleccionada no está disponible actualmente';
    }

    // Validate token exists in the network
    try {
        getTokenAddress(fastify, token, targetChainId);
    } catch {
        return 'El token no está disponible en la red seleccionada';
    }

    return '';
};

/**
 * Gets or creates a user based on the phone number.
 */
const getOrCreateUser = async (phoneNumber: string): Promise<IUser> => {
    let user = await User.findOne({ phone_number: phoneNumber });

    if (!user) {
        console.log(
            `Número de telefono ${phoneNumber} no registrado en ChatterPay, registrando...`,
        );
        const predictedWallet = await computeProxyAddressFromPhone(phoneNumber);
        user = await User.create({
            phone_number: phoneNumber,
            wallet: predictedWallet.EOAAddress,
            privateKey: predictedWallet.privateKey,
            name: `+${phoneNumber}`,
        });

        console.log(
            `Número de telefono ${phoneNumber} registrado con la wallet ${predictedWallet.EOAAddress}`,
        );
    }

    return user;
};

/**
 * Executes a transaction between two users and handles the notifications.
 */
const executeTransaction = async (
    fastify: FastifyInstance,
    from: IUser, 
    to: IUser | { wallet: string }, 
    tokenSymbol: string, 
    amount: string, 
    chain_id: number
): Promise<string> => {
    console.log("Sending user operation...");

    // Get token address from decorator
    const tokenAddress = getTokenAddress(fastify, tokenSymbol, chain_id);

    const result = await sendUserOperation(
        fastify,
        from.phone_number,
        to.wallet,
        tokenAddress,
        amount,
        chain_id
    );

    if (!result || !result.transactionHash) {
        return "La transacción falló, los fondos se mantienen en tu cuenta";
    }

    await Transaction.create({
        trx_hash: result.transactionHash,
        wallet_from: from.wallet,
        wallet_to: to.wallet,
        type: 'transfer',
        date: new Date(),
        status: 'completed',
        amount: parseFloat(amount),
        token: tokenSymbol,
    });

    try {
        console.log('Trying to notificate transfer');
        const fromName = from.name ?? from.phone_number ?? 'Alguien';
        const toNumber = 'phone_number' in to ? to.phone_number : to.wallet;
        
        sendTransferNotification(toNumber, fromName, amount, tokenSymbol);
        sendOutgoingTransferNotification(
            from.phone_number,
            toNumber,
            amount,
            tokenSymbol,
            result.transactionHash,
        );
        
        return "";
    } catch (error) {
        console.error('Error sending notifications:', error);
        return "La transacción falló, los fondos se mantienen en tu cuenta";
    }
};

/**
 * Checks the status of a transaction.
 */
export const checkTransactionStatus = async (
    request: FastifyRequest<{ Params: { trx_hash: string } }>,
    reply: FastifyReply,
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
    reply: FastifyReply,
) => {
    try {
        const newTransaction = new Transaction(request.body);
        await newTransaction.save();
        return await returnSuccessResponse(reply, 'Transaction created successfully', newTransaction.toJSON());
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
    reply: FastifyReply,
) => {
    try {
        const page = parseInt(request.query.page ?? '1', 10);
        const limit = parseInt(request.query.limit ?? '50', 10);
        const skip = (page - 1) * limit;

        const [transactions, total] = await Promise.all([
            Transaction.find().skip(skip).limit(limit).lean(),
            Transaction.countDocuments(),
        ]);

        return await returnSuccessResponse(reply, 'Transactions fetched successfully', {
            transactions,
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total,
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
    reply: FastifyReply,
) => {
    const { id } = request.params;

    try {
        const transaction = await Transaction.findById(id);
        if (!transaction) {
            return await returnErrorResponse(reply, 404, 'Transaction not found');
        }
        return await returnSuccessResponse(reply, 'Transaction fetched successfully', transaction.toJSON());
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
    reply: FastifyReply,
) => {
    const { id } = request.params;

    try {
        const updatedTransaction = await Transaction.findByIdAndUpdate(id, request.body, {
            new: true,
        });
        if (!updatedTransaction) {
            return await returnErrorResponse(reply, 404, 'Transaction not found');
        }
        return await returnSuccessResponse(reply, 'Transaction updated successfully', updatedTransaction.toJSON());
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
    reply: FastifyReply,
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
    reply: FastifyReply,
) => {
    try {
        const { channel_user_id, to, token, amount, chain_id } = request.body;
        const { networkConfig } = request.server;

        const validationError = await validateInputs(request.body, request.server);
        if (validationError) {
            return await returnErrorResponse(reply, 400, 'Error making transaction', validationError);
        }

        const fromUser = await User.findOne({ phone_number: channel_user_id });
        if (!fromUser) {
            return await returnErrorResponse(reply, 400, 'Error making transaction', 'User not found. You must have an account to make a transaction');
        }

        let toUser: IUser | { wallet: string };
        if (to.startsWith('0x')) {
            toUser = { wallet: to };
        } else {
            toUser = await getOrCreateUser(to);
        }

        executeTransaction(
            request.server,
            fromUser,
            toUser,
            token,
            amount,
            chain_id ? parseInt(chain_id, 10) : networkConfig.chain_id,
        );

        return await returnSuccessResponse(reply, "La transferencia está en proceso, puede tardar unos minutos... ");
    } catch (error) {
        console.error('Error making transaction:', error);
        return returnErrorResponse(reply, 400, 'Error making transaction', (error as Error).message);
    }
};
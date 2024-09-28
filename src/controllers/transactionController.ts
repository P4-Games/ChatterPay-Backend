import { FastifyReply, FastifyRequest } from 'fastify';

import web3 from '../utils/web3_config';
import { User, IUser } from '../models/user';
import Blockchain from '../models/blockchain';
import { USDT_ADDRESS } from '../constants/contracts';
import { sendUserOperation } from '../services/walletService';
import Transaction, { ITransaction } from '../models/transaction';
import { computeProxyAddressFromPhone } from '../services/predictWalletService';
import { sendTransferNotification, sendOutgoingTransferNotification } from './replyController';

type PaginationQuery = { page?: string; limit?: string };
type MakeTransactionInputs = {
    channel_user_id: string;
    to: string;
    token: string;
    amount: string;
    chain_id: string;
};

const TOKEN_ADDRESS = USDT_ADDRESS; // Demo USDT en Devnet Scroll # add wETH

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
            return await reply.status(404).send({ message: 'Transaction not found' });
        }

        const receipt = await web3.eth.getTransactionReceipt(trx_hash);
        if (!receipt) {
            return await reply.status(200).send({ status: 'pending' });
        }

        transaction.status = receipt.status ? 'completed' : 'failed';
        await transaction.save();

        return await reply.status(200).send({ status: transaction.status });
    } catch (error) {
        console.error('Error checking transaction status:', error);
        return reply.status(400).send({ message: 'Bad Request' });
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
        return await reply.status(201).send(newTransaction);
    } catch (error) {
        console.error('Error creating transaction:', error);
        return reply.status(400).send({ message: 'Bad Request' });
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

        return await reply.status(200).send({
            transactions,
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total,
        });
    } catch (error) {
        console.error('Error fetching transactions:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
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
            return await reply.status(404).send({ message: 'Transaction not found' });
        }
        return await reply.status(200).send(transaction);
    } catch (error) {
        console.error('Error fetching transaction:', error);
        return reply.status(400).send({ message: 'Bad Request' });
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
            return await reply.status(404).send({ message: 'Transaction not found' });
        }
        return await reply.status(200).send(updatedTransaction);
    } catch (error) {
        console.error('Error updating transaction:', error);
        return reply.status(400).send({ message: 'Bad Request' });
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
            return await reply.status(404).send({ message: 'Transaction not found' });
        }
        return await reply.status(200).send({ message: 'Transaction deleted' });
    } catch (error) {
        console.error('Error deleting transaction:', error);
        return reply.status(400).send({ message: 'Bad Request' });
    }
};

/**
 * Middleware to authenticate using the token in the header.
 */
export const authenticate = (request: FastifyRequest) => {
    const token = request.headers.authorization;
    if (!token || token !== 'chatterPayToken') {
        throw new Error('Unauthorized');
    }
};

/**
 * Validates the inputs for making a transaction.
 */
const validateInputs = (inputs: MakeTransactionInputs): string => {
    const { channel_user_id, to, token, amount, chain_id } = inputs;

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
    try {
        const newChainID = chain_id ? parseInt(chain_id, 10) : 534351;
        Blockchain.findOne({ chain_id: newChainID });
    } catch {
        return 'La blockchain no esta registrada';
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
 * Executes a transaction between two users.
 */
const executeTransaction = async (from: IUser, to: IUser | { wallet: string }, token: string, amount: string, chain_id: number) => {
	console.log("Sending user operation...");
	
	const result = await sendUserOperation(
		from.wallet,
		from.phone_number,
		to.wallet,
		TOKEN_ADDRESS,
		amount,
		chain_id
	);

	/*
	Native transfer

	const result = await sendUserOperation(
		from.wallet,
		from.phone_number,
		to.wallet,
		"0.00001", // Amount in ETH
		534351 // Chain ID (optional, defaults to 534351 for Scroll)
	); 
	*/

	if (!result || !result.transactionHash) return;

    await Transaction.create({
        trx_hash: result?.transactionHash ?? '',
        wallet_from: from.wallet,
        wallet_to: to.wallet,
        type: 'transfer',
        date: new Date(),
        status: 'completed',
        amount: parseFloat(amount),
        token: 'USDT',
    });

    try {
        console.log('Trying to notificate transfer');
        const fromName = from.name ?? from.phone_number ?? 'Alguien';
        const toNumber = 'phone_number' in to ? to.phone_number : to.wallet;
        await sendTransferNotification(toNumber, fromName, amount, token);
        await sendOutgoingTransferNotification(
            from.phone_number,
            toNumber,
            amount,
            token,
            result.transactionHash,
        );
    } catch (error) {
        console.error('Error sending notifications:', error);
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

        const validationError = validateInputs({ channel_user_id, to, token, amount, chain_id });
        if (validationError) {
            return await reply.status(400).send({ message: validationError });
        }

        const fromUser = await User.findOne({ phone_number: channel_user_id });
        if (!fromUser) {
            return await reply
                .status(400)
                .send({ message: 'Debes tener una wallet creada para poder transferir' });
        }

        let toUser: IUser | { wallet: string };
        if (to.startsWith('0x')) {
            toUser = { wallet: to };
        } else {
            toUser = await getOrCreateUser(to);
        }

        await executeTransaction(fromUser, toUser, token, amount, parseInt(chain_id, 10) ?? 534351);

        return await reply
            .status(200)
            .send({ message: 'Transaccion en progreso... Esto puede tardar unos minutos.' });
    } catch (error) {
        console.error('Error making transaction:', error);
        return reply.status(400).send({ message: 'Bad Request' });
    }
};

/**
 * Handles the listen transactions request.
 */
export const listenTransactions = async (
    request: FastifyRequest<{
        Body: {
            address: string;
        };
    }>,
    reply: FastifyReply,
) => {
    try {
        authenticate(request);
        const { address } = request.body;
        // TODO: Use transaction service
        return await reply.status(200).send({ message: `Listening transactions for: ${address}` });
    } catch (error) {
        console.error('Error listening transactions:', error);
        return reply.status(400).send({ message: 'Bad Request' });
    }
};

import { FastifyRequest, FastifyReply } from "fastify";
import web3 from "../config";
import Transaction, { ITransaction } from "../models/transaction";
import { sendUserOperation } from "../services/walletService";
import User, { IUser } from "../models/user";
import Token, { IToken } from "../models/token";

// Verificar estado de una transacción
export const checkTransactionStatus = async (
	request: FastifyRequest,
	reply: FastifyReply
) => {
	const { trx_hash } = request.params as { trx_hash: string };

	try {
		const transaction = await Transaction.findOne({ trx_hash });

		if (!transaction) {
			return reply.status(404).send({ message: "Transaction not found" });
		}

		const receipt = await web3.eth.getTransactionReceipt(trx_hash);

		if (!receipt) {
			return reply.status(200).send({ status: "pending" });
		}

		transaction.status = receipt.status ? "completed" : "failed";
		await transaction.save();

		return reply.status(200).send({ status: transaction.status });
	} catch (error) {
		console.error("Error checking transaction status:", error);
		return reply.status(400).send({ message: "Bad Request" });
	}
};

// Crear una nueva transacción
export const createTransaction = async (
	request: FastifyRequest<{ Body: ITransaction }>,
	reply: FastifyReply
) => {
	try {
		const newTransaction = new Transaction(request.body);
		await newTransaction.save();
		return reply.status(201).send(newTransaction);
	} catch (error) {
		console.error("Error creating transaction:", error);
		return reply.status(400).send({ message: "Bad Request" });
	}
};

// Obtener todas las transacciones
export const getAllTransactions = async (
	request: FastifyRequest<{ Querystring: { page?: string, limit?: string } }>,
	reply: FastifyReply
) => {
	try {
		const page = parseInt(request.query.page || '1', 10);
		const limit = parseInt(request.query.limit || '50', 10);
		const skip = (page - 1) * limit;

		const transactions = await Transaction.find()
			.skip(skip)
			.limit(limit)
			.lean();

		const total = await Transaction.countDocuments();

		return reply.status(200).send({
			transactions,
			currentPage: page,
			totalPages: Math.ceil(total / limit),
			totalItems: total,
		});
	} catch (error) {
		console.error("Error fetching transactions:", error);
		return reply.status(500).send({ message: "Internal Server Error" });
	}
};

// Obtener una transacción por ID
export const getTransactionById = async (
	request: FastifyRequest,
	reply: FastifyReply
) => {
	const { id } = request.params as { id: string };

	try {
		const transaction = await Transaction.findById(id);

		if (!transaction) {
			return reply.status(404).send({ message: "Transaction not found" });
		}

		return reply.status(200).send(transaction);
	} catch (error) {
		console.error("Error fetching transaction:", error);
		return reply.status(400).send({ message: "Bad Request" });
	}
};

// Actualizar una transacción por ID
export const updateTransaction = async (
	request: FastifyRequest<{
		Params: { id: string };
		Body: Partial<ITransaction>;
	}>,
	reply: FastifyReply
) => {
	const { id } = request.params as { id: string };

	try {
		const updatedTransaction = await Transaction.findByIdAndUpdate(
			id,
			request.body,
			{ new: true }
		);

		if (!updatedTransaction) {
			return reply.status(404).send({ message: "Transaction not found" });
		}

		return reply.status(200).send(updatedTransaction);
	} catch (error) {
		console.error("Error updating transaction:", error);
		return reply.status(400).send({ message: "Bad Request" });
	}
};

// Eliminar una transacción por ID
export const deleteTransaction = async (
	request: FastifyRequest<{ Params: { id: string } }>,
	reply: FastifyReply
) => {
	const { id } = request.params as { id: string };

	try {
		const deletedTransaction = await Transaction.findByIdAndDelete(id);

		if (!deletedTransaction) {
			return reply.status(404).send({ message: "Transaction not found" });
		}

		return reply.status(200).send({ message: "Transaction deleted" });
	} catch (error) {
		console.error("Error deleting transaction:", error);
		return reply.status(400).send({ message: "Bad Request" });
	}
};

// Middleware para autenticar usando el token en el encabezado
export const authenticate = (request: FastifyRequest) => {
	const token = request.headers["authorization"];
	if (!token || token !== "chatterPayToken") {
		throw new Error("Unauthorized");
	}
};

// Realizar una transaccion
export const makeTransaction = async (
	request: FastifyRequest<{
		Body: {
			channel_user_id: string;
			to: string;
			token: string;
			amount: string;
		};
	}>,
	reply: FastifyReply
) => {
	try {
		authenticate(request);

		const { channel_user_id, to, token, amount } = request.body;

		const fromUser: IUser[] = await User.find({"channel_user_id": channel_user_id});
		const from = fromUser[0].wallet;

		const toUser: IUser[] = await User.find({"channel_user_id": channel_user_id});
		const toWallet = toUser[0].wallet;

		const tokenDB: IToken[] = await Token.find({"name": token})
		const tokenAddress = tokenDB[0].address;

		const chain_id = 2227728; // devnet

		//Handle function of userop
		const result = await sendUserOperation(
			from,
			to,
			tokenAddress,
			amount,
			chain_id
		);

		const newTransaction = new Transaction({
			trx_hash: result.transactionHash,
			wallet_from: from,
			wallet_to: to,
			type: "transfer",
			date: new Date(),
			status: result.transactionHash ? "completed" : "failed",
			amount,
			token: tokenAddress,
		});

		await newTransaction.save();

		return reply.status(201).send(newTransaction);
	} catch (error) {
		console.error("Error making transaction:", error);
		return reply.status(400).send({ message: "Bad Request" });
	}
};

export const listenTransactions = async (
	request: FastifyRequest<{
		Body: {
			address: string;
		};
	}>,
	reply: FastifyReply
) => {
	try {
		authenticate(request);

		const { address } = request.body;

		//TODO: Use transaction service

		reply
			.status(200)
			.send({ message: "Listening transactions for: " + address });
	} catch (error) {
		console.error("Error listening transactions:", error);
		return reply.status(400).send({ message: "Bad Request" });
	}
};

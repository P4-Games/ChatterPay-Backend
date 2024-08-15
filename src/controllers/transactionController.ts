import { FastifyRequest, FastifyReply } from "fastify";
import web3 from "../config";
import Transaction, { ITransaction } from "../models/transaction";
import { sendUserOperation } from "../services/walletService";
import User from "../models/user";
import { sendTransferNotification, sendTransferNotification2 } from "./replyController";
import { computeProxyAddressFromPhone } from "../services/predictWalletService";
import Blockchain from "../models/blockchain";
import { USDT_ADDRESS } from "../constants/contracts";

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

type UserType = {
    input: string;
    wallet: string;
    name: string;
    privateKey?: string;
    number: string;
};

type MakeTransactionInputs = {
    channel_user_id: string;
    to: string;
    token: string;
    amount: string;
    chain_id: string;
};

const validateInputs = (inputs: MakeTransactionInputs): string => {
    const { channel_user_id, to, token, amount, chain_id } = inputs;
    
    if (!channel_user_id || !to || !token || !amount) {
        return "Alguno o multiples campos están vacíos";
    }
    if (isNaN(parseFloat(amount))) {
        return "El monto ingresado no es correcto";
    }
    if (channel_user_id === to) {
        return "No puedes enviar dinero a ti mismo";
    }
    if (channel_user_id.length > 15 || (to.startsWith("0x") && !isNaN(parseInt(to)) && to.length <= 15)) {
        return "El número de telefono no es válido";
    }
    if (token.length > 5) {
        return "El símbolo del token no es válido";
    }
    try {
        const newChainID = chain_id ? parseInt(chain_id) : 534351;
        Blockchain.findOne({ chain_id: newChainID });
    } catch {
        return "La blockchain no esta registrada";
    }
    return "";
};

const getOrCreateUser = async (phoneNumber: string): Promise<UserType> => {
    let user = await User.findOne({ phone_number: phoneNumber });
	
    if (!user) {
        console.log(`Número de telefono ${phoneNumber} no registrado en ChatterPay, registrando...`);
        const predictedWallet = await computeProxyAddressFromPhone(phoneNumber);
        user = await User.create({
            phone_number: phoneNumber,
            wallet: predictedWallet.EOAAddress,
            privateKey: predictedWallet.privateKey,
            name: `+${phoneNumber}`,
        });
		
        console.log(`Número de telefono ${phoneNumber} registrado con la wallet ${predictedWallet.EOAAddress}`);
    }

    return {
        input: phoneNumber,
        wallet: user.wallet,
        privateKey: user.privateKey,
        name: user.name || `+${phoneNumber}`,
        number: user.phone_number,
    };
};

export const tokenAddress = USDT_ADDRESS; // Demo USDT en Devnet Scroll # add wETH 

const executeTransaction = async (from: UserType, to: UserType, token: string, amount: string, chain_id: number) => {
    console.log("Sending user operation...");
    const result = await sendUserOperation(
        from.wallet,
        from.number,
        to.wallet,
        tokenAddress,
        amount,
        chain_id
    );

    if (!result) return;

    Transaction.create({
        trx_hash: result?.transactionHash ?? "",
        wallet_from: from.wallet,
        wallet_to: to.wallet,
        type: "transfer",
        date: new Date(),
        status: "completed",
        amount: parseFloat(amount),
        token: "USDT",
    });

    try {
        console.log("Trying to notificate transfer");
        let fromName = from.name || from.number || "Alguien";
        sendTransferNotification(to.number, fromName, amount, token);
        sendTransferNotification2(from.number, to.number, amount, token, result.transactionHash);
    } catch (error) {
        console.error("Error sending notifications:", error);
    }
};

export const makeTransaction = async (
    request: FastifyRequest<{ Body: MakeTransactionInputs }>,
    reply: FastifyReply
) => {
    try {
        const { channel_user_id, to, token, amount, chain_id } = request.body;

        const validationError = validateInputs({ channel_user_id, to, token, amount, chain_id });
        if (validationError) {
            return reply.status(400).send({ message: validationError });
        }

		let user = await User.findOne({ phone_number: channel_user_id });
	
    	if (!user) {
			return reply.status(400).send({ message: "Debes tener una wallet creada para poder transferir" });
		}

        const fromUser = await getOrCreateUser(channel_user_id);
        const toUser = to.startsWith("0x") 
            ? { input: to, wallet: to, name: "", number: "" } 
            : await getOrCreateUser(to);

        executeTransaction(fromUser, toUser, token, amount, parseInt(chain_id) || 534351);

        return reply.status(200).send({ message: "Transaccion en progreso... Esto puede tardar unos minutos." });
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

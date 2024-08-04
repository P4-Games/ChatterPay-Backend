import { FastifyRequest, FastifyReply } from "fastify";
import web3 from "../config";
import Transaction, { ITransaction } from "../models/transaction";
import { sendUserOperation } from "../services/walletService";
import User, { IUser } from "../models/user";
import Token, { IToken } from "../models/token";
import { sendTransferNotification, sendTransferNotification2 } from "./replyController";
import { ComputedAddress, computeProxyAddressFromPhone, PhoneNumberToAddress } from "../services/predictWalletService";
import { ethers } from "ethers";
import { SCROLL_CONFIG } from "../constants/networks";
import { createUser } from "./userController";

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
}

type MakeTransactionInputs = {
	channel_user_id: string;
	to: string;
	token: string;
	amount: string;
};

const validateInputs = (inputs: MakeTransactionInputs): string => {
	let error = "";
	const { channel_user_id, to, token, amount } = inputs;

	if (!channel_user_id || !to || !token || !amount) {
		error = "Alguno o multiples campos están vacíos";
	}

	if (isNaN(parseFloat(amount))) {
		error = "El monto ingresado no es correcto";
	}

	if (channel_user_id === to) {
		error = "No puedes enviar dinero a ti mismo";
	}

	if (channel_user_id.length > 15 || to.length > 15) {
		error = "El número de telefono no es válido";
	}

	if (token.length > 5) {
		error = "El símbolo del token no es válido";
	}

	return error;
};

const execute = async (channel_user_id: string, to: string, token: string, amount: string) => {

	let createdAddress = "";

	const fromUser: IUser[] = await User.find({"phone_number": channel_user_id});
	
	let from: UserType = {
		input: channel_user_id,
		wallet: fromUser?.[0]?.wallet ?? "",
		privateKey: fromUser?.[0]?.privateKey ?? "",
		name: fromUser?.[0]?.name ?? "",
		number: fromUser?.[0]?.phone_number ?? "",
	};
	
	if(!from.wallet) {
		console.log("Número de telefono del remitente no registrado en ChatterPay, registrando...");

		const predictedWallet: ComputedAddress = await computeProxyAddressFromPhone(channel_user_id);

		User.create(new User({
			phone_number: channel_user_id,
			wallet: predictedWallet.proxyAddress,
			privateKey: predictedWallet.privateKey,
			code: null,
			photo: null,
			email: null,
			name: null,
		}));

		console.log(`Número de telefono ${channel_user_id} registrado con la wallet ${predictedWallet.EOAAddress}`);

		from.number = channel_user_id;
		from.wallet = predictedWallet.proxyAddress;
		from.privateKey = predictedWallet.privateKey;
		from.name = `+${channel_user_id}`;

		createdAddress = predictedWallet.EOAAddress;
	}else{
		from.name = fromUser?.[0]?.name ?? `+${channel_user_id}`; 
	}

	// El usuario destino puede ser tanto un numero de telefono registerado o no, como ser una wallet, puede ser una wallet ya registrada
	// Si la wallet ya está registrada hay que notificar al usuario

	const toRegisteredUser: IUser[] = await User.find({"phone_number": to});
	
	let toUser: UserType = {
		input: to,
		wallet: toRegisteredUser?.[0]?.wallet ?? "",
		name: toRegisteredUser?.[0]?.name ?? "",
		number: toRegisteredUser?.[0]?.phone_number ?? "",
	};

	if(!toUser.input.startsWith("0x") && !toUser.wallet) {
		console.log("Número de telefono del destinatario no registrado en ChatterPay, registrando...");
		const predictedWallet: ComputedAddress = await computeProxyAddressFromPhone(toUser.input)
		
		toUser.wallet = predictedWallet.proxyAddress;
		createdAddress = predictedWallet.EOAAddress;

		User.create(new User({
			phone_number: to,
			wallet: predictedWallet.proxyAddress,
			privateKey: predictedWallet.privateKey,
			code: null,
			email: null,
			photo: "/assets/images/avatars/generic_user.jpg",
			name: null,
		}));

		console.log(`Número de telefono ${to} registrado con la wallet ${predictedWallet.EOAAddress}`);
	} 

	const tokenAddress = "0x9a01399df4e464b797e0f36b20739a1bf2255dc8"; // Demo USDT en Devnet Scroll

	console.log("Sending user operation...");
	//Handle function of userop
	const result = await sendUserOperation(
		from.wallet,
		toUser.wallet,
		tokenAddress,
		amount,
		createdAddress
	);

	if(!result) return;

	const newTransaction = new Transaction({
		trx_hash: result.transactionHash,
		wallet_from: from.wallet,
		wallet_to: toUser.wallet,
		type: "transfer",
		date: new Date(),
		status: result.transactionHash ? "completed" : "failed",
		amount: parseFloat(amount),
		token: "USDT",
	})

	await Transaction.create(newTransaction);

	await newTransaction.save();

	try{
		console.log("Trying to notificate transfer");
		
		let fromName = from?.name ?? from?.number ?? "Alguien";

		sendTransferNotification(to, fromName, amount, token);
		console.log("Notification sent!");
		sendTransferNotification2(channel_user_id, to, amount, token, result.transactionHash);
	} catch (error:any) {
		console.error(error)
	}
}

// Realizar una transaccion
export const makeTransaction = async (
	request: FastifyRequest<{
		Body: MakeTransactionInputs; 
	}>,
	reply: FastifyReply
) => {
	try {
		authenticate(request);

		/**
		 * channel_user_id: Numero del telefono del usuario que envia la solicitud
		 * to: Numero del telefono del usuario que recibe la solicitud
		 */
		const { channel_user_id, to, token, amount } = request.body;
		
		const validationError = validateInputs({ channel_user_id, to, token, amount });

		if(validationError){
			return reply.status(400).send({ message: validationError });
		}

		execute(channel_user_id, to, token, amount);
		
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

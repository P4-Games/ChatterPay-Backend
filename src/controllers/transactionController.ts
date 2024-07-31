import { FastifyRequest, FastifyReply } from 'fastify';
import web3 from '../config';
import Transaction, { ITransaction } from '../models/transaction';

// Verificar estado de una transacción
export const checkTransactionStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  const { trx_hash } = request.params as { trx_hash: string };

  try {
    const transaction = await Transaction.findOne({ trx_hash });

    if (!transaction) {
      return reply.status(404).send({ message: 'Transaction not found' });
    }

    const receipt = await web3.eth.getTransactionReceipt(trx_hash);

    if (!receipt) {
      return reply.status(200).send({ status: 'pending' });
    }

    transaction.status = receipt.status ? 'completed' : 'failed';
    await transaction.save();

    return reply.status(200).send({ status: transaction.status });
  } catch (error) {
    console.error('Error checking transaction status:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Crear una nueva transacción
export const createTransaction = async (request: FastifyRequest<{ Body: ITransaction }>, reply: FastifyReply) => {
  try {
    const newTransaction = new Transaction(request.body);
    await newTransaction.save();
    return reply.status(201).send(newTransaction);
  } catch (error) {
    console.error('Error creating transaction:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Obtener todas las transacciones
export const getAllTransactions = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const transactions = await Transaction.find();
    return reply.status(200).send(transactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Obtener una transacción por ID
export const getTransactionById = async (request: FastifyRequest, reply: FastifyReply) => {
  const { id } = request.params as { id: string };

  try {
    const transaction = await Transaction.findById(id);

    if (!transaction) {
      return reply.status(404).send({ message: 'Transaction not found' });
    }

    return reply.status(200).send(transaction);
  } catch (error) {
    console.error('Error fetching transaction:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Actualizar una transacción por ID
export const updateTransaction = async (request: FastifyRequest<{ Params: { id: string }, Body: Partial<ITransaction> }>, reply: FastifyReply) => {
  const { id } = request.params as { id: string };

  try {
    const updatedTransaction = await Transaction.findByIdAndUpdate(id, request.body, { new: true });

    if (!updatedTransaction) {
      return reply.status(404).send({ message: 'Transaction not found' });
    }

    return reply.status(200).send(updatedTransaction);
  } catch (error) {
    console.error('Error updating transaction:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Eliminar una transacción por ID
export const deleteTransaction = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params as { id: string };

  try {
    const deletedTransaction = await Transaction.findByIdAndDelete(id);

    if (!deletedTransaction) {
      return reply.status(404).send({ message: 'Transaction not found' });
    }

    return reply.status(200).send({ message: 'Transaction deleted' });
  } catch (error) {
    console.error('Error deleting transaction:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

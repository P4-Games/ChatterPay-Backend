import { FastifyInstance } from 'fastify';

import {
  makeTransaction,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  getAllTransactions,
  getTransactionById,
  listenTransactions,
  checkTransactionStatus
} from '../controllers/transactionController';

/**
 * Configures routes related to transactions.
 * @param fastify - Fastify instance
 */
const transactionRoutes: (fastify: FastifyInstance) => Promise<void> = async (fastify) => {
  // Route to check the status of a transaction
  fastify.get('/transaction/:trx_hash/status', checkTransactionStatus);
  // Route to create a new transaction
  fastify.post('/transactions/', createTransaction);
  // Route to get all transactions
  fastify.get('/transactions/', getAllTransactions);
  // Route to get a transaction by its ID
  fastify.get('/transactions/:id', getTransactionById);
  // Route to update a transaction
  fastify.put('/transactions/:id', updateTransaction);
  // Route to delete a transaction
  fastify.delete('/transactions/:id', deleteTransaction);
  // Route to make a transaction
  fastify.post('/make_transaction/', makeTransaction);
  // Route to listen for transactions
  fastify.post('/listen_transactions/', listenTransactions);
}

export default transactionRoutes;
import { FastifyInstance } from 'fastify';
import {
  checkTransactionStatus,
  createTransaction,
  getAllTransactions,
  getTransactionById,
  updateTransaction,
  deleteTransaction,
  makeTransaction
} from '../controllers/transactionController';

const transactionRoutes = async (fastify: FastifyInstance) => {
  fastify.get('/transaction/:trx_hash/status', checkTransactionStatus);
  fastify.post('/transactions', createTransaction);
  fastify.get('/transactions', getAllTransactions);
  fastify.get('/transactions/:id', getTransactionById);
  fastify.put('/transactions/:id', updateTransaction);
  fastify.delete('/transactions/:id', deleteTransaction);
  fastify.post('/make_transaction/', makeTransaction)
};

export default transactionRoutes;

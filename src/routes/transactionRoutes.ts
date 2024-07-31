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
import { sendUserOperation } from '../services/walletService';

const transactionRoutes = async (fastify: FastifyInstance) => {
  fastify.get('/transaction/:trx_hash/status', checkTransactionStatus);
  fastify.post('/transactions', createTransaction);
  fastify.get('/transactions', getAllTransactions);
  fastify.get('/transactions/:id', getTransactionById);
  fastify.put('/transactions/:id', updateTransaction);
  fastify.delete('/transactions/:id', deleteTransaction);
  fastify.post('/make_transaction/', makeTransaction)

  //Test route for sending a transaction
  fastify.post<{
    Body: {
      userId: string;
      to: string;
      tokenAddress: string;
      amount: string;
    }
  }>('/send', async (request, reply) => {
    const { userId, to, tokenAddress, amount, chain_id } = request.body;

    try {
      const result = await sendUserOperation(userId, to, tokenAddress, amount, chain_id);
      reply.send(result);
    } catch (error: any) {
      reply.status(500).send({ error: 'Failed to send transaction', details: error.message });
    }
  });
};

export default transactionRoutes;

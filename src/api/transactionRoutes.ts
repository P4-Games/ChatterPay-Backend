import { FastifyInstance } from 'fastify';

import {
  makeTransaction,
  createTransaction,
  deleteTransaction,
  updateTransaction,
  getAllTransactions,
  getTransactionById,
  checkTransactionStatus
} from '../controllers/transactionController';

/**
 * Configures routes related to transactions.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
const transactionRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to check the status of a transaction
   * @route GET /transaction/:trx_hash/status
   * @param {string} trx_hash - The unique identifier (hash) of the transaction
   * @returns {Object} The status of the transaction
   */
  fastify.get('/transaction/:trx_hash/status', checkTransactionStatus);

  /**
   * Route to create a new transaction
   * @route POST /transactions/
   * @returns {Object} The created transaction details
   */
  fastify.post('/transactions/', createTransaction);

  /**
   * Route to get all transactions
   * @route GET /transactions/
   * @returns {Array} List of all transactions
   */
  fastify.get('/transactions/', getAllTransactions);

  /**
   * Route to get a transaction by its ID
   * @route GET /transactions/:id
   * @param {string} id - The unique identifier of the transaction
   * @returns {Object} The details of the specified transaction
   */
  fastify.get('/transactions/:id', getTransactionById);

  /**
   * Route to update a transaction
   * @route PUT /transactions/:id
   * @param {string} id - The unique identifier of the transaction to update
   * @returns {Object} The updated transaction details
   */
  fastify.put('/transactions/:id', updateTransaction);

  /**
   * Route to delete a transaction
   * @route DELETE /transactions/:id
   * @param {string} id - The unique identifier of the transaction to delete
   * @returns {Object} Confirmation of deletion
   */
  fastify.delete('/transactions/:id', deleteTransaction);

  /**
   * Route to make a transaction
   * @route POST /make_transaction/
   * @returns {Object} The result of the transaction operation
   */
  fastify.post('/make_transaction/', makeTransaction);
};

export default transactionRoutes;

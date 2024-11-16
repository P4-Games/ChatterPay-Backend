import { FastifyInstance } from 'fastify';

import {
    makeTransaction,
    createTransaction,
    updateTransaction,
    deleteTransaction,
    getAllTransactions,
    getTransactionById,
    checkTransactionStatus,
} from '../controllers/transactionController';
import { executeContractCall } from '../controllers/genericTransactionController';

/**
 * Configures routes related to transactions.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>}
 */
const transactionRoutes = async (fastify: FastifyInstance): Promise<void> => {
    /**
     * Route to check the status of a transaction
     * @route GET /transaction/:trx_hash/status
     */
    fastify.get('/transaction/:trx_hash/status', checkTransactionStatus);

    /**
     * Route to create a new transaction
     * @route POST /transactions/
     */
    fastify.post('/transactions/', createTransaction);

    /**
     * Route to get all transactions
     * @route GET /transactions/
     */
    fastify.get('/transactions/', getAllTransactions);

    /**
     * Route to get a transaction by its ID
     * @route GET /transactions/:id
     */
    fastify.get('/transactions/:id', getTransactionById);

    /**
     * Route to update a transaction
     * @route PUT /transactions/:id
     */
    fastify.put('/transactions/:id', updateTransaction);

    /**
     * Route to delete a transaction
     * @route DELETE /transactions/:id
     */
    fastify.delete('/transactions/:id', deleteTransaction);

    /**
     * Route to make a transaction
     * @route POST /make_transaction/
     */
    fastify.post('/make_transaction/', makeTransaction);
    
    /**
     * Route to make a generic transaction
     * @route POST /execute_contract_call/
     */
    fastify.post('/execute_contract_call/', executeContractCall);
};

export default transactionRoutes;

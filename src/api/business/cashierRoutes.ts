import { FastifyInstance } from 'fastify';

import { createCashier, deleteCashier, updateCashier, getCashierById, getAllCashiers } from '../../controllers/cashierController';

export async function cashierRoutes(fastify: FastifyInstance) {
    /**
     * Creates a new cashier record with the provided cashier details
     */
    fastify.post('/business/cashier', createCashier);

    /**
     * Retrieves a list of all cashiers in the system
     */
    fastify.get('/business/cashier', getAllCashiers);

    /**
     * Fetches a specific cashier by their ID
     */
    fastify.get('/business/cashier/:id', getCashierById);

    /**
     * Updates an existing cashier record with new information
     */
    fastify.put('/business/cashier/:id', updateCashier);

    /**
     * Removes a cashier record from the system
     */
    fastify.delete('/business/cashier/:id', deleteCashier);
}
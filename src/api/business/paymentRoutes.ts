import { FastifyInstance } from 'fastify';

import { 
    createPaymentOrder,
    deletePaymentOrder,
    getAllPaymentOrders,
    getPaymentOrderById,
    updatePaymentOrderStatus,
    getPaymentOrdersByCashier,
    getLatestPaymentOrderByCashier
} from '../../controllers/paymentController';

export async function paymentRoutes(fastify: FastifyInstance) {
    /**
     * Creates a new payment order with the provided details
     */
    fastify.post('/business/payment', createPaymentOrder);

    /**
     * Retrieves a list of all payment orders in the system
     */
    fastify.get('/business/payment', getAllPaymentOrders);

    /**
     * Fetches a specific payment order by its ID
     */
    fastify.get('/business/payment/:id', getPaymentOrderById);

    /**
     * Updates an existing payment order's status
     */
    fastify.put('/business/payment/:id', updatePaymentOrderStatus);

    /**
     * Removes a payment order from the system
     */
    fastify.delete('/business/payment/:id', deletePaymentOrder);

    /**
     * Gets all payment orders for a specific cashier
     */
    fastify.get('/business/cashier-payments/:cashierId', getPaymentOrdersByCashier);

    /**
     * Gets the latest pending payment order for a specific cashier
     */
    fastify.get('/business/cashier-payments/:cashierId/latest', getLatestPaymentOrderByCashier);
}
import { FastifyInstance } from 'fastify';

import { verifyConnect, connectWithChatterPayAccount } from '../../controllers/connectController';

export async function connectRoutes(fastify: FastifyInstance) {
    /**
     * Generates a connection request
     */
    fastify.post('/business/connect', connectWithChatterPayAccount);

    /**
     * Retrieves a list of all cashiers in the system
     */
    fastify.get('/business/verify', verifyConnect);
}
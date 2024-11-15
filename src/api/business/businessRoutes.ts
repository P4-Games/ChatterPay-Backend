import { FastifyInstance } from 'fastify';

import { createBusiness, deleteBusiness, updateBusiness, getBusinessById, getAllBusinesses } from '../../controllers/businessController';

export async function businessRoutes(fastify: FastifyInstance) {
    /**
     * Creates a new business record with the provided business details
     */
    fastify.post('/business', createBusiness);

    /**
     * Retrieves a list of all businesses in the system
     */
    fastify.get('/business', getAllBusinesses);

    /**
     * Fetches a specific business by its ID
     */
    fastify.get('/business/:id', getBusinessById);

    /**
     * Updates an existing business record with new information
     */
    fastify.put('/business/:id', updateBusiness);

    /**
     * Removes a business record from the system
     */
    fastify.delete('/business/:id', deleteBusiness);
}
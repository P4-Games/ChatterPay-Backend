import { FastifyInstance } from 'fastify';

import { getQRCodeDetails } from '../../controllers/paymentController';


export async function QRPublicRoutes(fastify: FastifyInstance) {
    /**
     * Retrieves a QR Code ID and the associated business information, to perform the payment (public route)
     */
    fastify.get('/qr/:id', getQRCodeDetails);
}
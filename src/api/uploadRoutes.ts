import { FastifyInstance } from 'fastify';

import { uploadPDF, uploadImage } from '../controllers/ImageController';

/**
 * Configures routes related to upload.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>}
 */
const uploadRoutes = async (fastify: FastifyInstance): Promise<void> => {
    /**
     * Route to upload an image
     * @route POST /upload
     */
    fastify.post('/upload', uploadImage);
    fastify.post('/upload_pdf', uploadPDF);
};

export default uploadRoutes;

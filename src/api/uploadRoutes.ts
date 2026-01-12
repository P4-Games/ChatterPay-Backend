import type { FastifyInstance } from 'fastify';

import { uploadImage } from '../controllers/ImageController';

/**
 * Configures routes related to upload.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once the route is registered
 */
const uploadRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to upload an image
   * @route POST /upload
   * @returns {Object} The result of the upload operation, typically containing image metadata
   */
  fastify.post('/upload', uploadImage);
};

export default uploadRoutes;

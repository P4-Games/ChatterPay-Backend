// src/utils/shutdown.ts

import mongoose from 'mongoose';
import { FastifyInstance } from 'fastify';

/**
 * Sets up a graceful shutdown process for the server and database connection.
 * 
 * @param {FastifyInstance} server - The Fastify server instance
 */
export function setupGracefulShutdown(server: FastifyInstance): void {
    process.on('SIGINT', async () => {
        try {
            await server.close();
            await mongoose.connection.close();
            console.log('Server and MongoDB connection closed');
            process.exit(0);
        } catch (err) {
            console.error('Error during shutdown:', err);
            process.exit(1);
        }
    });
}
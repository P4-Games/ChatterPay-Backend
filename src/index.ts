import mongoose from 'mongoose';
import { start } from '@google-cloud/trace-agent';
import { FastifyInstance } from 'fastify/types/instance';

import { startServer } from './config/server';
import { Logger } from './helpers/loggerHelper';
import { connectToDatabase } from './config/database';
import { $B, GCP_CLOUD_TRACE_ENABLED } from './config/constants';

/**
 * Sets up a graceful shutdown process for the server and database connection.
 *
 * @param {FastifyInstance} server - The Fastify server instance
 */
function setupGracefulShutdown(server: FastifyInstance): void {
  process.on('SIGINT', async () => {
    try {
      await server.close();
      await mongoose.connection.close();
      Logger.log('setupGracefulShutdown', 'Server and MongoDB connection closed');
      process.exit(0);
    } catch (err) {
      Logger.error('setupGracefulShutdown', err);
      process.exit(1);
    }
  });
}

/**
 * Initializes Cloud Trace for the application.
 * Should be called before any other operations to ensure tracing works.
 */
function initializeCloudTrace(): void {
  if (GCP_CLOUD_TRACE_ENABLED) {
    try {
      start({
        // logLevel: 4,
        samplingRate: 20, // capture up to 20 requests per second for tracing.
        serviceContext: {
          service: `chatterpay-service-${$B}`,
          version: '1.0.0'
        }
      });
      Logger.log('Cloud Trace initialized.');
    } catch (error) {
      Logger.error(`Error initializing cloud Trace: ${(error as Error).message}`);
    }
  } else {
    Logger.log('Cloud Trace is not enabled.');
  }
}

/**
 * The main function that initializes the application.
 * It connects to the database, starts the server, and sets up graceful shutdown.
 *
 * @throws {Error} If there's an error starting the application
 */
async function main(): Promise<void> {
  try {
    initializeCloudTrace();
    await connectToDatabase();
    const server = await startServer();
    setupGracefulShutdown(server);
  } catch (err) {
    Logger.error('main', 'Error starting application:', err);
    process.exit(1);
  }
}

main();

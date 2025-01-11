import mongoose from 'mongoose';
import { FastifyInstance } from 'fastify/types/instance';

import { startServer } from './config/server';
import { Logger } from './helpers/loggerHelper';
import { connectToDatabase } from './config/database';

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
 * The main function that initializes the application.
 * It connects to the database, starts the server, and sets up graceful shutdown.
 *
 * @throws {Error} If there's an error starting the application
 */
async function main(): Promise<void> {
  try {
    await connectToDatabase();
    const server = await startServer();
    setupGracefulShutdown(server);
  } catch (err) {
    Logger.error('main', 'Error starting application:', err);
    process.exit(1);
  }
}

main();

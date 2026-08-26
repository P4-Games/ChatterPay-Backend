import { start } from '@google-cloud/trace-agent';
import type { FastifyInstance } from 'fastify/types/instance';
import mongoose from 'mongoose';
import { $B, GCP_CLOUD_TRACE_ENABLED } from './config/constants';
import { connectToDatabaseWithRetry } from './config/database';
import { startServer } from './config/server';
import { Logger } from './helpers/loggerHelper';
import { assertCardanoDerivationUnchanged } from './services/cardano/cardanoDerivationCheck';
import { registerPolymarketApiAdapter } from './services/polymarket/polymarketProxyHelper';

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
    registerPolymarketApiAdapter();

    // The database has to be up before the server is built: networkConfigPlugin
    // reads the token list while registering, and mongoose would buffer that
    // query until it times out. Retrying here means a transient connection error
    // delays startup instead of killing the container, which is what used to
    // leave port 8080 closed until Cloud Run's startup probe gave up.
    await connectToDatabaseWithRetry();

    // Before the port opens: an address issued by a deployment whose derivation moved is an address
    // nobody can sign for, and no request should be served until that is ruled out.
    assertCardanoDerivationUnchanged();

    const server = await startServer();
    setupGracefulShutdown(server);
  } catch (err) {
    Logger.error('main', 'Error starting application:', err);
    process.exit(1);
  }
}

main();

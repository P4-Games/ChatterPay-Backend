import { startServer } from './config/server';
import { connectToDatabase } from './config/database';
import { setupGracefulShutdown } from './utils/shutdown';

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
        console.error('Error starting application:', err);
        process.exit(1);
    }
}

main();
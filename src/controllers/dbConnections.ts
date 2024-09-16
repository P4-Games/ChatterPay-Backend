import mongoose from 'mongoose';

/**
 * Represents a map of database connections.
 */
interface ConnectionMap {
    [key: string]: mongoose.Connection;
}

/**
 * Stores active database connections.
 */
const connections: ConnectionMap = {};

/**
 * Connects to a MongoDB database.
 * @param url - The MongoDB connection URL.
 * @returns A promise resolving to a mongoose Connection object.
 * @throws An error if the connection fails.
 */
export const connectToMongoDB = async (url: string): Promise<mongoose.Connection> => {
    if (connections[url]) {
        console.log(`Using existing MongoDB connection for ${url}`);
        return connections[url];
    }

    try {
        const connection = await mongoose.createConnection(url).asPromise();
        connections[url] = connection;
        console.log(`New MongoDB connection successful for ${url}`);
        return connection;
    } catch (error) {
        console.error(`Error connecting to MongoDB (${url}):`, error);
        throw new Error(`Failed to connect to MongoDB: ${(error as Error).message}`);
    }
};

/**
 * Retrieves an existing database connection.
 * @param url - The MongoDB connection URL.
 * @returns The mongoose Connection object if it exists, undefined otherwise.
 */
export const getConnection = (url: string): mongoose.Connection | undefined => connections[url];

/**
 * Closes all active database connections.
 * @returns A promise that resolves when all connections are closed.
 */
export const closeConnections = async (): Promise<void> => {
    const closePromises = Object.entries(connections).map(async ([url, connection]) => {
        try {
            await connection.close();
            console.log(`Closed connection for ${url}`);
            delete connections[url];
        } catch (error) {
            console.error(`Error closing connection for ${url}:`, error);
        }
    });

    await Promise.all(closePromises);
};
import mongoose from 'mongoose';

interface ConnectionMap {
    [key: string]: mongoose.Connection;
}

const connections: ConnectionMap = {};

export const connectToMongoDB = async (url: string): Promise<mongoose.Connection> => {
    if (connections[url]) {
        console.log(`Using existing MongoDB connection for ${url}`);
        return connections[url];
    }

    try {
        const connection = await mongoose.createConnection(url).asPromise();
        connections[url] = connection;
        console.log(`Nueva conexión a MongoDB exitosa para ${url}`);
        return connection;
    } catch (error) {
        console.error(`Error al conectar a MongoDB (${url}):`, error);
        throw error;
    }
};

export const getConnection = (url: string): mongoose.Connection | undefined => {
    return connections[url];
};

export const closeConnections = async (): Promise<void> => {
    for (const url in connections) {
        await connections[url].close();
        console.log(`Closed connection for ${url}`);
    }
};
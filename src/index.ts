import Fastify from 'fastify';
import mongoose from 'mongoose';
import transactionRoutes from './routes/transactionRoutes';
import userRoutes from './routes/userRoutes';
import tokenRoutes from './routes/tokenRoutes';
import blockchainRoutes from './routes/blockchainRoutes';

const server = Fastify({
    logger: true // Esto habilitará el logging detallado
});

const PORT = process.env.PORT || 3000;
const MongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/chatterpay'

async function startServer() {
    try {
        // Conectar a MongoDB
        await mongoose.connect(MongoURI);
        console.log('MongoDB connected');
        // Registrar las rutas
        server.register(transactionRoutes);
        server.register(userRoutes);
        server.register(tokenRoutes)
        server.register(blockchainRoutes)

        // Iniciar el servidor
        await server.listen({ port: Number(PORT), host: '0.0.0.0' });
        console.log(`Server listening at ${server.server.address()}`);
    } catch (err) {
        console.error('Error starting server:', err);
        process.exit(1);
    }
}

startServer();

// Manejar el cierre graceful
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
import Fastify from 'fastify';
import mongoose from 'mongoose';
import transactionRoutes from './routes/transactionRoutes';
import userRoutes from './routes/userRoutes';
import tokenRoutes from './routes/tokenRoutes';
import blockchainRoutes from './routes/blockchainRoutes';
import aaveRoutes from './routes/aaveRoutes';
import fastifySwaggerUi from "@fastify/swagger-ui";

const server = Fastify({
    logger: true // Esto habilitará el logging detallado
});

const PORT = process.env.PORT || 3000;
const MongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/chatterpay'

async function startServer() {
    try {
        // Conectar a MongoDB
        //await mongoose.connect(MongoURI);
        console.log('MongoDB connected');
        //Swagger
        await server.register(require('@fastify/swagger'), {
            openapi: {
                openapi: '3.0.0',
                info: {
                    title: 'ChatterPay Backend',
                    description: 'API Rest documentation for ChatterPay.',
                    version: '0.1.0'
                },
                servers: [
                    {
                        url: 'http://localhost:3000',
                        description: 'Development server'
                    },
                    {
                        url: "https://chatterpay-back-ylswtey2za-uc.a.run.app/",
                        description: "Production server"
                    }
                ],
                tags: [
                    { name: 'user', description: 'User related end-points' },
                    { name: 'code', description: 'Code related end-points' }
                ],
                components: {
                    securitySchemes: {
                        apiKey: {
                            type: 'apiKey',
                            name: 'apiKey',
                            in: 'header'
                        }
                    }
                },
            }
        })

        const swaggerUiOptions = {
            routePrefix: "/docs",
            exposeRoute: true,
        };
        
        server.register(fastifySwaggerUi, swaggerUiOptions);
        // Registrar las rutas
        server.register(transactionRoutes);
        server.register(userRoutes);
        server.register(tokenRoutes);
        server.register(aaveRoutes);
        server.register(blockchainRoutes);

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
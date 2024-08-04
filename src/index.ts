import Fastify, { FastifyError, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import transactionRoutes from './routes/transactionRoutes';
import userRoutes from './routes/userRoutes';
import tokenRoutes from './routes/tokenRoutes';
import blockchainRoutes from './routes/blockchainRoutes';
import aaveRoutes from './routes/aaveRoutes';
import fastifySwaggerUi from "@fastify/swagger-ui";
import { demoERC20Routes } from './routes/demoERC20Routes';

const server = Fastify({
    logger: true // Esto habilitará el logging detallado
});

const PORT = process.env.PORT || 3000;
const MongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/chatterpay'

function parseCustomJSON(str: string): any {
    // Remove leading/trailing whitespace
    str = str.trim();
    
    // Check if the string starts and ends with curly braces
    if (str[0] !== '{' || str[str.length - 1] !== '}') {
        throw new Error('Invalid JSON: must be an object');
    }
    
    // Remove curly braces
    str = str.slice(1, -1);
    
    // Split by commas, but not within quotes
    const pairs = str.match(/('[^']*'|[^,]+)/g) || [];
    
    const result: {[key: string]: string} = {};
    
    for (let pair of pairs) {
        // Split each pair by colon
        const [key, value] = pair.split(':').map(s => s.trim());
        
        // Remove quotes from key and value
        const cleanKey = key.replace(/^'|'$/g, '').trim();
        const cleanValue = value.replace(/^'|'$/g, '').trim();
        
        result[cleanKey] = cleanValue;
    }
    
    return result;
}

async function startServer() {
    try {
        // Conectar a MongoDB
        await mongoose.connect(MongoURI);
        console.log('MongoDB connected');

        // Custom parser for handling problematic JSON
        server.addContentTypeParser('application/json', { parseAs: 'string' }, (req: FastifyRequest, body: string, done: (err: FastifyError | null, body?: any) => void) => {
            try {
                let parsedBody;
                try {
                    // First, try standard JSON parse
                    parsedBody = JSON.parse(body);
                } catch (jsonError) {
                    // If standard parse fails, use our custom parser
                    console.warn('Standard JSON parse failed. Attempting custom parse.');
                    parsedBody = parseCustomJSON(body);
                }
                done(null, parsedBody);
            } catch (err) {
                console.error('Failed to parse JSON:', body);
                done(new Error('Invalid JSON') as FastifyError, undefined);
            }
        });

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
        server.register(demoERC20Routes);

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
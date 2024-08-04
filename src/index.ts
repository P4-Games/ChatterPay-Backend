import Fastify, { FastifyError, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import transactionRoutes from './routes/transactionRoutes';
import userRoutes from './routes/userRoutes';
import tokenRoutes from './routes/tokenRoutes';
import blockchainRoutes from './routes/blockchainRoutes';
import aaveRoutes from './routes/aaveRoutes';
import fastifySwaggerUi from "@fastify/swagger-ui";
import { demoERC20Routes } from './routes/demoERC20Routes';
import querystring from 'querystring';

const server = Fastify({
    logger: true // Esto habilitará el logging detallado
});

const PORT = process.env.PORT || 3000;
const MongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/chatterpay'

function parseBody(body: string): any {
    body = body.trim();
    
    // Check if it's JSON-like (starts with { or [)
    if (body.startsWith('{') || body.startsWith('[')) {
        try {
            return JSON.parse(body);
        } catch (error) {
            console.warn('JSON parse failed, attempting to fix malformed JSON');
            // Attempt to fix common JSON issues (like single quotes)
            const fixedBody = body.replace(/'/g, '"').replace(/(\w+):/g, '"$1":');
            return JSON.parse(fixedBody);
        }
    } 
    // If it contains '=' and '&', it's likely URL-encoded
    else if (body.includes('=') && body.includes('&')) {
        console.log('Parsing URL-encoded data');
        return querystring.parse(body);
    }
    
    throw new Error('Unrecognized data format');
}

async function startServer() {
    try {
        // Conectar a MongoDB
        await mongoose.connect(MongoURI);
        console.log('MongoDB connected');

        // Custom parser for handling both JSON and URL-encoded data
        server.addContentTypeParser(['application/json', 'application/x-www-form-urlencoded'], { parseAs: 'string' }, (req: FastifyRequest, body: string, done: (err: FastifyError | null, body?: any) => void) => {
            try {
                const parsedBody = parseBody(body);
                done(null, parsedBody);
            } catch (err) {
                console.error('Failed to parse body:', body);
                done(new Error('Invalid body format') as FastifyError, undefined);
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
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi, { FastifySwaggerUiOptions } from '@fastify/swagger-ui';
import { FastifyInstance } from 'fastify';

/**
 * Sets up Swagger documentation for the Fastify server.
 *
 * @param {FastifyInstance} server - The Fastify server instance
 */
export async function setupSwagger(server: FastifyInstance): Promise<void> {
    await server.register(fastifySwagger, {
        openapi: {
            openapi: '3.0.0',
            info: {
                title: 'ChatterPay Backend',
                description: 'API Rest documentation for ChatterPay.',
                version: '0.1.0',
            },
            servers: [
                {
                    url: 'http://localhost:3000',
                    description: 'Local server',
                },
                {
                    url: 'https://dev.back.chatterpay.net/',
                    description: 'Development server',
                },
                {
                    url: 'https://back.chatterpay.net/',
                    description: 'Production server',
                },
            ],
            tags: [
                { name: 'user', description: 'User related end-points' },
                { name: 'code', description: 'Code related end-points' },
            ],
            components: {
                securitySchemes: {
                    apiKey: {
                        type: 'apiKey',
                        name: 'apiKey',
                        in: 'header',
                    },
                },
            },
        },
    });

    const swaggerUiOptions: FastifySwaggerUiOptions = {
        routePrefix: '/docs',
    };

    await server.register(fastifySwaggerUi, swaggerUiOptions);
}

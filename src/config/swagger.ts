import { FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi, { FastifySwaggerUiOptions } from "@fastify/swagger-ui";

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
    });

    const swaggerUiOptions: FastifySwaggerUiOptions = {
        routePrefix: "/docs",
    };

    await server.register(fastifySwaggerUi, swaggerUiOptions);
}
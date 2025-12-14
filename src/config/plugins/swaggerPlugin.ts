import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi, { type FastifySwaggerUiOptions } from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

import { IS_DEVELOPMENT } from '../constants';

/**
 * Sets up Swagger documentation for the Fastify server.
 * @param {FastifyInstance} server - The Fastify server instance
 * @returns {Promise<void>} Resolves once Swagger is successfully set up
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
          description: 'Local server'
        },
        {
          url: `https://${IS_DEVELOPMENT ? 'dev.' : ''}back.chatterpay.net/`,
          description: `${IS_DEVELOPMENT ? 'Development' : 'Production'} server`
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
      }
    }
  });

  const swaggerUiOptions: FastifySwaggerUiOptions = {
    routePrefix: '/docs'
  };

  await server.register(fastifySwaggerUi, swaggerUiOptions);
}

import Fastify, { FastifyInstance } from 'fastify';
import { it, expect, describe, afterEach, beforeEach } from 'vitest';

import { pingRoutes } from '../../src/api/pingRoutes';

describe('pingRoutes', () => {
  let fastify: FastifyInstance;

  beforeEach(async () => {
    // Create a new Fastify instance before each test
    fastify = Fastify();
    // Register the pingRoutes with the Fastify instance
    await pingRoutes(fastify);
  });

  afterEach(async () => {
    // Close the Fastify instance after each test to release resources
    await fastify.close();
  });

  it('should respond with status 200 and the correct payload on GET /ping', async () => {
    // Inject a request to the /ping route
    const response = await fastify.inject({
      method: 'GET',
      url: '/ping'
    });

    // Assert the HTTP status code
    expect(response.statusCode).toBe(200);

    // Assert the JSON payload of the response
    expect(response.json()).toEqual({ status: 'ok', message: 'pong' });
  });
});

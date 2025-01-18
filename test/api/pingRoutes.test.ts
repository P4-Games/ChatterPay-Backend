import Fastify, { FastifyInstance } from 'fastify';
import { it, expect, describe, beforeEach } from 'vitest';

import { pingRoutes } from '../../src/api/pingRoutes';

// Test suite for pingRoutes
describe('pingRoutes', () => {
  let fastify: FastifyInstance;

  beforeEach(async () => {
    // Create a new Fastify instance before each test
    fastify = Fastify();
    // Register the pingRoutes with the Fastify instance
    await pingRoutes(fastify);
  });

  it('should respond with status 200 and correct payload on GET /ping', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/ping'
    });
    // Assert the status code
    expect(response.statusCode).toBe(200);
    // Assert the response payload
    expect(response.json()).toEqual({ status: 'ok', message: 'pong' });
  });
});

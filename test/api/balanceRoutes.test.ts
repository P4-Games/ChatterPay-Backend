import Fastify, { FastifyInstance } from 'fastify';
import { it, vi, expect, describe, beforeEach } from 'vitest';

import { balanceRoutes } from '../../src/api/balanceRoutes';

vi.mock('../../src/controllers/balanceController', () => ({
  walletBalance: vi.fn(async (req, res) => res.send({ balance: 100 })),
  balanceByPhoneNumber: vi.fn(async (req, res) => res.send({ balance: 200 })),
  checkExternalDeposits: vi.fn(async (req, res) => res.send({ deposits: [] }))
}));

describe('balanceRoutes', () => {
  let fastify: FastifyInstance;

  beforeEach(async () => {
    fastify = Fastify();
    await balanceRoutes(fastify);
  });

  it('should respond with the wallet balance on GET /balance/:wallet', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/balance/testWallet'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ balance: 100 });
  });

  it('should respond with the phone balance on GET /balance_by_phone/', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/balance_by_phone/'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ balance: 200 });
  });

  it('should respond with deposit information on GET /check_deposits', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/check_deposits'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deposits: [] });
  });
});

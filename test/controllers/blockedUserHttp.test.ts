import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CHATIZALO_TOKEN,
  DEFAULT_CHAIN_ID,
  FRONTEND_TOKEN,
  USER_BLOCKED_ERROR_CODE,
  USER_BLOCKED_MESSAGES
} from '../../src/config/constants';
import { buildServer } from '../../src/config/server';
import Blockchain from '../../src/models/blockchainModel';
import { UserModel } from '../../src/models/userModel';

/**
 * The block, and the `/nfts/` crash it was found next to, driven over real HTTP.
 *
 * Both are middleware-and-dispatch behaviour that a unit test structurally cannot reach: the block
 * lives in a `preHandler` hook registered on the root server instance, and the 500 came from a
 * validator throwing before the handler's own 400 could run. What is proven here is what a client
 * actually receives.
 *
 * A real socket rather than `server.inject()`, for the same reason as `cardanoHttp.test.ts`:
 * `light-my-request` reads a Node internal Bun does not expose, and this repository runs on Bun.
 */

const EVM_CHAIN_ID = DEFAULT_CHAIN_ID;

/** `CORS_ORIGINS` is `*` in development, but the middleware still demands the header be present. */
const ORIGIN = 'http://localhost';

const BLOCKED_PHONE = '5491133334444';
const ACTIVE_PHONE = '5491155556666';

let server: FastifyInstance;
let baseUrl: string;

/** The EVM network document the server needs to boot, with only what the schema requires. */
async function seedEvmNetwork(): Promise<void> {
  await Blockchain.create({
    name: 'Scroll Sepolia',
    family: 'evm',
    manteca_name: 'SCROLL',
    chainId: EVM_CHAIN_ID,
    rpc: 'http://127.0.0.1:1',
    rpcBundler: 'http://127.0.0.1:1',
    logo: '',
    explorer: 'https://sepolia.scrollscan.com/tx/',
    // Non-empty: Mongoose treats '' as missing on a required String path.
    marketplaceOpenseaUrl: 'https://sepolia.scrollscan.com/nft',
    environment: 'TEST',
    supportsEIP1559: true,
    externalDeposits: { lastBlockProcessed: 0, lastBlockTimestampProcessed: 0 },
    contracts: {},
    gas: { useFixedValues: false, operations: { transfer: {}, swap: {} } },
    balances: {
      paymasterMinBalance: '0.05',
      paymasterTargetBalance: '0.1',
      backendSignerMinBalance: '0.05',
      userSignerMinBalance: '0.05',
      userSignerBalanceToTransfer: '0.05'
    },
    limits: {
      transfer: { L1: { D: 14 }, L2: { D: 100 } },
      swap: { L1: { D: 14 }, L2: { D: 100 } },
      mint_nft: { L1: { D: 14 }, L2: { D: 100 } },
      mint_nft_copy: { L1: { D: 14 }, L2: { D: 100 } }
    }
  });
}

async function seedUsers(): Promise<void> {
  await UserModel.create([
    {
      phone_number: BLOCKED_PHONE,
      blocked: true,
      settings: { notifications: { language: 'es' } }
    },
    { phone_number: ACTIVE_PHONE, settings: { notifications: { language: 'es' } } }
  ]);
}

/** Sends a request the way a real client would. */
async function call(
  path: string,
  init: { method?: string; body?: unknown; token?: string | undefined } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` })
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });

  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

beforeAll(async () => {
  await seedEvmNetwork();

  server = await buildServer();
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}, 180_000);

/** The shared setup clears every collection between tests, so the rows have to be put back. */
beforeEach(async () => {
  await seedEvmNetwork();
  await seedUsers();
});

afterAll(async () => {
  await server?.close();
});

describe('GET /nfts/ without a channel_user_id', () => {
  // The route is public, so this was reachable with one unauthenticated curl. The validator threw
  // a TypeError on the missing query param, which escaped as a 500 before the handler's own 400
  // could run — that is the error found in the production logs of 2026-08-29.
  it('answers 400 rather than crashing with a 500', async () => {
    const { status, body } = await call('/nfts/', { token: undefined });

    expect(status).toBe(400);
    expect(body).toMatchObject({
      status: 'error',
      data: { code: 400, message: expect.stringContaining('channel_user_id') }
    });
  });

  it('still answers 400 when the parameter is present but not a phone number', async () => {
    const { status } = await call('/nfts/?channel_user_id=abc', { token: undefined });
    expect(status).toBe(400);
  });
});

describe('a blocked account', () => {
  it('is refused with 403 when the frontend calls on its behalf', async () => {
    const { status, body } = await call('/get_security_status/', {
      method: 'POST',
      body: { channel_user_id: BLOCKED_PHONE },
      token: FRONTEND_TOKEN
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({
      status: 'error',
      data: { message: USER_BLOCKED_MESSAGES.es, details: USER_BLOCKED_ERROR_CODE }
    });
  });

  // The bot renders the message body and cannot act on a status code, so every refusal on its
  // endpoints is a 200 carrying the reason. The block has to follow that same contract.
  it('is refused with 200 and an error body when the bot calls on its behalf', async () => {
    const { status, body } = await call('/get_security_status/', {
      method: 'POST',
      body: { channel_user_id: BLOCKED_PHONE },
      token: CHATIZALO_TOKEN
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: 'error',
      data: { code: 200, message: USER_BLOCKED_MESSAGES.es, details: USER_BLOCKED_ERROR_CODE }
    });
  });

  it('is refused on a GET that names it in the query string', async () => {
    const { status, body } = await call(`/notifications?channel_user_id=${BLOCKED_PHONE}`, {
      token: FRONTEND_TOKEN
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({ data: { details: USER_BLOCKED_ERROR_CODE } });
  });
});

describe('an account that is not blocked', () => {
  // The point is only that the hook let the request reach its handler: whatever the handler then
  // answers is its own business, and must not be the block.
  it('reaches the handler untouched', async () => {
    const { body } = await call('/get_security_status/', {
      method: 'POST',
      body: { channel_user_id: ACTIVE_PHONE },
      token: FRONTEND_TOKEN
    });

    expect(body?.data).not.toMatchObject({ details: USER_BLOCKED_ERROR_CODE });
  });
});

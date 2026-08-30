import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CHATIZALO_TOKEN,
  DEFAULT_CHAIN_ID,
  FRONTEND_TOKEN,
  USER_BLOCKED_ERROR_CODE
} from '../../src/config/constants';
import { buildServer } from '../../src/config/server';
import Blockchain from '../../src/models/blockchainModel';
import { TemplateType } from '../../src/models/templateModel';
import { UserModel } from '../../src/models/userModel';
import { cacheService } from '../../src/services/cache/cacheService';
import { CacheNames } from '../../src/types/commonType';

const TEMPLATE_ES = 'Cuenta suspendida. Contactanos por los canales de soporte.';
const EXPECTED_MESSAGE = TEMPLATE_ES;

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

async function seedTemplate(): Promise<void> {
  await TemplateType.collection.insertOne({
    notifications: {
      user_blocked: {
        title: { en: 'Suspended', es: 'Suspendida', pt: 'Suspensa' },
        message: { en: TEMPLATE_ES, es: TEMPLATE_ES, pt: TEMPLATE_ES }
      }
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
  await seedTemplate();
  cacheService.clearCache(CacheNames.NOTIFICATION);
});

afterAll(async () => {
  await server?.close();
});

describe('GET /nfts/ without a channel_user_id', () => {
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
  it('is refused with 403 on a route that reports errors by status code', async () => {
    const { status, body } = await call(`/notifications?channel_user_id=${BLOCKED_PHONE}`, {
      token: FRONTEND_TOKEN
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({
      status: 'error',
      data: { message: EXPECTED_MESSAGE, details: USER_BLOCKED_ERROR_CODE }
    });
  });

  it('is refused with 200 and an error body on a route that reports errors as success', async () => {
    const { status, body } = await call('/get_security_status/', {
      method: 'POST',
      body: { channel_user_id: BLOCKED_PHONE },
      token: CHATIZALO_TOKEN
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: 'error',
      data: { code: 200, message: EXPECTED_MESSAGE, details: USER_BLOCKED_ERROR_CODE }
    });
  });

  it('is refused the same way on one route whichever credential called it', async () => {
    const asBot = await call('/get_security_status/', {
      method: 'POST',
      body: { channel_user_id: BLOCKED_PHONE },
      token: CHATIZALO_TOKEN
    });
    const asFrontend = await call('/get_security_status/', {
      method: 'POST',
      body: { channel_user_id: BLOCKED_PHONE },
      token: FRONTEND_TOKEN
    });

    expect(asFrontend.status).toBe(asBot.status);
    expect(asFrontend.body).toMatchObject({ data: { details: USER_BLOCKED_ERROR_CODE } });
  });
});

describe('an account that is not blocked', () => {
  it('reaches the handler untouched', async () => {
    const { body } = await call('/get_security_status/', {
      method: 'POST',
      body: { channel_user_id: ACTIVE_PHONE },
      token: FRONTEND_TOKEN
    });

    expect(body?.data).not.toMatchObject({ details: USER_BLOCKED_ERROR_CODE });
  });
});

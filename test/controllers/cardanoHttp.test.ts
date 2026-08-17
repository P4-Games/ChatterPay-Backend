import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../src/config/cardanoConfig';
import { buildServer } from '../../src/config/server';
import Blockchain from '../../src/models/blockchainModel';
import Token from '../../src/models/tokenModel';
import { UserModel } from '../../src/models/userModel';
import { deriveCardanoAccount } from '../../src/services/cardano/cardanoWalletService';

/**
 * The application driven over HTTP, not through its services.
 *
 * This is the first test in the repository that exercises a real request. `buildServer()` was split
 * out of `startServer()` for exactly this, and what it proves is the part unit tests structurally
 * cannot: that the dispatch at the top of `make_transaction` really sends a Cardano request to the
 * Cardano controller, and really leaves everything else where it was.
 *
 * **Why a real socket instead of `server.inject()`.** Fastify's `inject` goes through
 * `light-my-request`, which reads `response._header` — a Node internal Bun does not expose, so the
 * call dies inside the library before the handler's answer is serialized. Binding an ephemeral port
 * and using `fetch` works on both runtimes, which matters because this repository is run under Bun.
 *
 * No chain calls happen here: the provider points at a closed port, so an accidental network access
 * fails instantly and visibly rather than making the suite depend on Koios.
 */

/** Chain id of the EVM network this instance operates on, per `.env`. */
const EVM_CHAIN_ID = Number(process.env.DEFAULT_CHAIN_ID ?? 534351);

/** `CORS_ORIGINS` is `*` in development, but the middleware still demands the header be present. */
const ORIGIN = 'http://localhost';

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

async function seedCardanoNetwork(): Promise<void> {
  await Blockchain.create({
    name: 'Cardano Preprod',
    family: 'cardano',
    chainId: CARDANO_PREPROD_CHAIN_ID,
    environment: 'TEST',
    explorer: 'https://preprod.cardanoscan.io/transaction/',
    cardano: {
      network: 'testnet',
      providerUrl: 'http://127.0.0.1:1',
      ttlSlots: 900,
      depositConfirmations: 3
    },
    limits: { transfer: { L1: { D: 14 }, L2: { D: 100 } } }
  });
}

async function seedTokens(): Promise<void> {
  const limits = {
    transfer: { L1: { min: 1, max: 1000 }, L2: { min: 1, max: 1000 } },
    swap: { L1: { min: 1, max: 1000 }, L2: { min: 1, max: 1000 } }
  };
  await Token.create([
    {
      name: 'USDC',
      symbol: 'USDC',
      display_symbol: 'USDC',
      chain_id: EVM_CHAIN_ID,
      decimals: 6,
      display_decimals: 2,
      address: '0x1111111111111111111111111111111111111111',
      type: 'erc20',
      ramp_enabled: true,
      operations_limits: limits
    },
    {
      name: 'Cardano ADA',
      symbol: 'ADA',
      display_symbol: 'ADA',
      chain_id: CARDANO_PREPROD_CHAIN_ID,
      decimals: 6,
      display_decimals: 2,
      address: 'cardano:testnet:lovelace',
      type: 'variable',
      ramp_enabled: false,
      operations_limits: limits
    }
  ]);
}

/** Sends a request the way a real client would. */
async function call(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {}
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...(init.auth === false
        ? {}
        : { authorization: `Bearer ${process.env.CHATIZALO_TOKEN ?? ''}` })
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  return { status: response.status, text: await response.text() };
}

/**
 * Booted once for the whole file.
 *
 * `buildServer()` takes around thirty seconds here — it pulls in every controller, and the module
 * graph sits on a Windows filesystem mounted into WSL. Building it per test would spend minutes
 * booting and blow past the per-test timeout, which is what made an earlier version of this file
 * look like it was hanging.
 */
beforeAll(async () => {
  process.env.CARDANO_NETWORK = 'preprod';
  // A closed port: an accidental chain call fails instantly instead of reaching out.
  process.env.CARDANO_PROVIDER_URL = 'http://127.0.0.1:1';
  process.env.CARDANO_PROVIDER_TIMEOUT_MS = '1000';

  // Seeded before booting: the network config plugin snapshots the catalogue at startup.
  await seedEvmNetwork();
  await seedCardanoNetwork();
  await seedTokens();

  server = await buildServer();
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}, 180_000);

/**
 * The shared setup clears every collection between tests, so the rows the handlers read have to be
 * put back. The server's own snapshot survives — it is only a cache of the same data.
 */
beforeEach(async () => {
  await seedEvmNetwork();
  await seedCardanoNetwork();
  await seedTokens();
});

afterAll(async () => {
  await server?.close();
});

describe('GET /balance/:wallet - a Cardano address', () => {
  it('answers a base address, the shape this deployment actually issues', async () => {
    // 108 characters. Fastify's default `maxParamLength` is 100, and over it the router does not
    // error — it answers **404**, so this endpoint silently stopped existing for every Cardano
    // wallet the moment base addresses replaced enterprise ones. The previous fixture was 59
    // characters, which is why the suite stayed green through a broken endpoint.
    process.env.CARDANO_ENABLED = 'true';
    const address = deriveCardanoAccount('5491100000009').address;
    expect(address.length).toBeGreaterThan(100);

    const { status, text } = await call(`/balance/${address}`);

    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body.data.wallets).toEqual([address]);
  });

  it('answers a bech32 address with the same shape an EVM address gets', async () => {
    process.env.CARDANO_ENABLED = 'true';
    const address = 'addr_test1vrhdandhv2ngazdseql7v5fkg5utnu629anv9zt25x8vrsqn2mhal';

    const { status, text } = await call(`/balance/${address}`);

    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(Array.isArray(body.data.balances)).toBe(true);
    expect(body.data.wallets).toEqual([address]);
    // No rows: the provider is unreachable, so every balance is zero, and a zero balance is not a
    // row here for the same reason it is not one on the EVM branch. The degradation is what is
    // being asserted -- the endpoint answers instead of going down.
    expect(body.data.balances).toEqual([]);
    expect(body.data.cardano.utxoCount).toBe(0);
  });

  it('still rejects a string that is neither a Cardano nor an EVM address', async () => {
    const { status } = await call('/balance/not-an-address');
    expect(status).toBe(400);
  });
});

describe('GET /balance_by_phone - the Cardano wallet is discoverable', () => {
  it('returns the Cardano address for a user who has never touched the chain', async () => {
    // The entry point of the whole flow: in V1 the user funds their own Cardano wallet, so they
    // have to be able to see the address before they have used it. The address is derived, not
    // looked up, which is what makes that possible — and nothing is written to get it.
    process.env.CARDANO_ENABLED = 'true';
    const phone = '5491100000001';
    await UserModel.create({
      phone_number: phone,
      wallets: [
        {
          wallet_proxy: '0x1111111111111111111111111111111111111111',
          wallet_eoa: '0x2222222222222222222222222222222222222222',
          chain_id: EVM_CHAIN_ID,
          status: 'active'
        }
      ]
    });

    const { status, text } = await call(`/balance_by_phone/?channel_user_id=${phone}`);

    expect(status).toBe(200);
    const body = JSON.parse(text);
    const expected = deriveCardanoAccount(phone).address;
    expect(body.data.wallets).toContain(expected);
    // The address is discoverable through `wallets` even with nothing in it. The balance list stays
    // consistent with the EVM one and carries no zero rows.
    expect(body.data.balances.some((row: { token: string }) => row.token === 'ADA')).toBe(false);

    // Derived, never provisioned: reading a balance must not write a wallet.
    const stored = await UserModel.findOne({ phone_number: phone });
    expect(stored?.wallets).toHaveLength(1);
  });

  it('leaves the portfolio untouched when Cardano is off', async () => {
    process.env.CARDANO_ENABLED = 'false';
    const phone = '5491100000002';
    await UserModel.create({
      phone_number: phone,
      wallets: [
        {
          wallet_proxy: '0x3333333333333333333333333333333333333333',
          wallet_eoa: '0x4444444444444444444444444444444444444444',
          chain_id: EVM_CHAIN_ID,
          status: 'active'
        }
      ]
    });

    const { text } = await call(`/balance_by_phone/?channel_user_id=${phone}`);

    const body = JSON.parse(text);
    expect(body.data.balances.some((row: { token: string }) => row.token === 'ADA')).toBe(false);
  });
});

describe('POST /make_transaction - dispatch', () => {
  const body = {
    channel_user_id: '5491100000001',
    to: '5491100000002',
    token: 'ADA',
    amount: '2'
  };

  it('sends an ADA request to the Cardano controller', async () => {
    // With the family switched off, the Cardano controller answers with a message only it produces.
    // That makes this a test of the dispatch rather than of the chain: no provider is touched.
    process.env.CARDANO_ENABLED = 'false';

    const { status, text } = await call('/make_transaction/', { method: 'POST', body });

    expect(status).toBe(200);
    expect(text).toContain('Cardano is not available');
  });

  it('sends a request naming the Cardano network there too', async () => {
    process.env.CARDANO_ENABLED = 'false';

    const { text } = await call('/make_transaction/', {
      method: 'POST',
      body: {
        ...body,
        to: 'addr_test1vz74kulhkqmrdrrg6u57we4pzckf07wj5e906zdpeddpz2ct8f930',
        network: 'cardano'
      }
    });

    expect(text).toContain('Cardano is not available');
  });

  it('leaves an EVM request on the EVM path', async () => {
    // The regression that matters: adding a chain must not divert the transfers that already work.
    process.env.CARDANO_ENABLED = 'true';

    const { text } = await call('/make_transaction/', {
      method: 'POST',
      body: { ...body, token: 'USDC' }
    });

    expect(text).not.toContain('Cardano is not available');
  });

  it('rejects an unauthenticated request before any of this', async () => {
    const { status } = await call('/make_transaction/', {
      method: 'POST',
      body,
      auth: false
    });

    expect(status).toBeGreaterThanOrEqual(400);
  });
});

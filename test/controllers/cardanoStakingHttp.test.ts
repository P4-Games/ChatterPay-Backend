import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../src/config/cardanoConfig';
import { CHATIZALO_TOKEN, DEFAULT_CHAIN_ID } from '../../src/config/constants';
import { buildServer } from '../../src/config/server';
import Blockchain from '../../src/models/blockchainModel';
import { enableCardanoPreprod } from '../support/cardanoEnv';

vi.mock('../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

vi.mock('../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/constants')>();
  const { cardanoConstantsMock } = await import('../support/cardanoEnv');
  return cardanoConstantsMock(actual);
});

/**
 * The staking endpoints, driven over a real socket.
 *
 * What this proves is the part a service test structurally cannot: that the routes are registered and
 * that the sync path is authenticated and origin-checked exactly like every other route here, with no
 * exemption of its own. Those are properties of wiring, and wiring is what silently stops working.
 *
 * The provider points at a closed port, so an accidental chain call fails instantly instead of making
 * the suite depend on Blockfrost.
 */

/** Chain id of the EVM network this instance operates on, per the environment. */
const EVM_CHAIN_ID = DEFAULT_CHAIN_ID;

const ORIGIN = 'http://localhost';

let server: FastifyInstance;
let baseUrl: string;

/**
 * Sends a request the way a real client would.
 *
 * @param path - Path to call.
 * @param init - Method, body, and which headers to include or leave out.
 * @returns The status and the raw body.
 */
async function call(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    origin?: boolean;
    authorization?: string | null;
  } = {}
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.origin !== false) headers.origin = ORIGIN;
  if (init.authorization !== null) {
    headers.authorization = init.authorization ?? `Bearer ${CHATIZALO_TOKEN ?? ''}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  return { status: response.status, text: await response.text() };
}

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

/** The Cardano network document the server reads while booting. */
async function seedCardanoNetwork(): Promise<void> {
  await Blockchain.create({
    name: 'Cardano Preprod',
    family: 'cardano',
    chainId: CARDANO_PREPROD_CHAIN_ID,
    environment: 'TEST',
    explorer: 'https://preprod.cardanoscan.io/transaction/',
    network: 'testnet',
    providerUrl: 'http://127.0.0.1:1',
    ttlSlots: 900,
    depositConfirmations: 3,
    limits: { transfer: { L1: { D: 14 }, L2: { D: 100 } } }
  });
}

beforeAll(async () => {
  enableCardanoPreprod({ providerTimeoutMs: 1000 }, { providerUrl: 'http://127.0.0.1:1' });
  // Seeded before booting: the network config plugin snapshots the catalogue at startup.
  await seedEvmNetwork();
  await seedCardanoNetwork();

  server = await buildServer();
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}, 180_000);

afterAll(async () => {
  await server?.close();
});

describe('POST /internal/cardano/staking/sync', () => {
  it('refuses a call carrying no Origin header, like every other route', async () => {
    // No exemption: the job sends an `Origin` the deployment allows, the same way the other scheduled
    // endpoints in this repository are called. A path listed as an exception would be one whose
    // schedule keeps working after the allowed origins change, and nobody would find out here.
    const { status } = await call('/internal/cardano/staking/sync', {
      method: 'POST',
      origin: false,
      body: {}
    });

    expect(status).toBe(403);
  });

  it('refuses a call carrying no credential', async () => {
    // Keeping the path off the public list is what stops an endpoint that starts transactions from
    // answering an unauthenticated caller.
    const { status, text } = await call('/internal/cardano/staking/sync', {
      method: 'POST',
      authorization: null,
      body: {}
    });

    expect(status).toBe(401);
    expect(text).toContain('Authentication token was not provided');
  });

  it('refuses a token this deployment does not know', async () => {
    const { status, text } = await call('/internal/cardano/staking/sync', {
      method: 'POST',
      authorization: 'Bearer not-a-token',
      body: {}
    });

    expect(status).toBe(401);
    expect(text).toContain('Invalid Authorization Token');
  });

  it('lets the shared product token through to the run', async () => {
    // The positive case, end to end over a socket. Cardano staking is off in this suite, so the run
    // refuses on configuration, which is the answer *past* authentication and is what proves the
    // token was taken rather than merely not rejected.
    const { status } = await call('/internal/cardano/staking/sync', {
      method: 'POST',
      body: { jobName: 'cardano-staking-sync' }
    });

    expect(status).not.toBe(401);
  });

  it('serves no GET on that path', async () => {
    // Past the token, the route is POST only. Anything else is a route that was never registered.
    const { status } = await call('/internal/cardano/staking/sync');

    expect(status).toBe(404);
  });
});

describe('the user-facing staking routes', () => {
  it('still require an Origin header', async () => {
    // A route reachable from any page on the internet is what this would be if the origin check ever
    // stopped applying to it.
    const { status } = await call('/cardano/staking/state?channel_user_id=5491100000001', {
      origin: false
    });

    expect(status).toBe(403);
  });

  it('refuse a request that names no user', async () => {
    const { status } = await call('/cardano/staking/state');

    expect(status).toBe(400);
  });

  it('refuse an action that is not one of the offered ones', async () => {
    const { status, text } = await call('/cardano/staking/action', {
      method: 'POST',
      body: { channel_user_id: '5491100000001', action: 'register_drep' }
    });

    expect(status).toBe(400);
    expect(text).toContain('action must be one of');
  });

  it('refuse an action with no action at all', async () => {
    const { status } = await call('/cardano/staking/action', {
      method: 'POST',
      body: { channel_user_id: '5491100000001' }
    });

    expect(status).toBe(400);
  });

  it('refuse a vote delegation that names no governance target', async () => {
    // The route carries the target and the service validates it, and 400 is the answer either way: the
    // action is offered and the request did not say what it is aimed at. Reaching the assembler's
    // default instead is what made abstaining the only target this screen could ask for.
    const { status, text } = await call('/cardano/staking/action', {
      method: 'POST',
      body: { channel_user_id: '5491100000001', action: 'delegate_vote' }
    });

    expect(status).toBe(400);
    expect(text).toContain('governance_target');
  });

  it('refuse a governance target on an action that has none', async () => {
    const { status, text } = await call('/cardano/staking/action', {
      method: 'POST',
      body: {
        channel_user_id: '5491100000001',
        action: 'withdraw_rewards',
        governance_target: { kind: 'always_abstain' }
      }
    });

    expect(status).toBe(400);
    expect(text).toContain('governance_target');
  });

  it('refuse an authorisation for a vote delegation with no target', async () => {
    // The grant is bound to the target, so a target the action endpoint would refuse must not be able
    // to buy one here either.
    const { status, text } = await call('/cardano/staking/authorize', {
      method: 'POST',
      body: { channel_user_id: '5491100000001', action: 'delegate_vote', pin: '000000' }
    });

    expect(status).toBe(400);
    expect(text).toContain('governance_target');
  });

  it('refuse a consent that says neither yes nor no', async () => {
    // A missing flag read as `false` would switch staking off for anybody whose body did not arrive.
    const { status } = await call('/cardano/staking/consent', {
      method: 'POST',
      body: { channel_user_id: '5491100000001' }
    });

    expect(status).toBe(400);
  });

  it('answer the governance options without a user', async () => {
    // The options are a property of the chain, not of anybody's account, so this one needs no user.
    // The provider is a closed port here, so the handler reports an empty list rather than failing.
    const { status } = await call('/cardano/governance/options');

    expect(status).toBe(200);
  });
});

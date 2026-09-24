import { createSign, generateKeyPairSync } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../src/config/cardanoConfig';
import { CHATIZALO_TOKEN, DEFAULT_CHAIN_ID } from '../../src/config/constants';
import { buildServer } from '../../src/config/server';
import Blockchain from '../../src/models/blockchainModel';
import { resetGoogleOidcKeys } from '../../src/services/googleOidcService';
import { enableCardanoPreprod, setCardanoSyncAuth } from '../support/cardanoEnv';

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
 * Google's key set, when the suite is standing in for Google.
 *
 * `null` means behave as if the endpoint were unreachable, which is the ordinary state: only the
 * positive case below puts a key set here.
 */
const googleKeys: { value: unknown | null } = vi.hoisted(() => ({ value: null }));

// Only the certificate fetch is intercepted; everything else goes to the real axios. Replacing axios
// wholesale would also replace the provider's transport, and this file boots the whole application.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  const get: typeof actual.default.get = async (url, config) => {
    if (typeof url === 'string' && url.includes('googleapis.com/oauth2/v3/certs')) {
      if (googleKeys.value === null) throw new Error('google is unreachable in this suite');
      return { data: googleKeys.value } as never;
    }
    return actual.default.get(url, config);
  };
  const wrapped = Object.assign(Object.create(actual.default), actual.default, { get });
  return { ...actual, default: wrapped, get };
});

/**
 * The staking endpoints, driven over a real socket.
 *
 * What this proves is the part a service test structurally cannot: that the routes are registered,
 * that the sync path is genuinely exempt from the `Origin` check, and that the exemption did not
 * accidentally extend to the user-facing ones. Those are properties of wiring, and wiring is what
 * silently stops working.
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
    cardano: {
      network: 'testnet',
      providerUrl: 'http://127.0.0.1:1',
      ttlSlots: 900,
      depositConfirmations: 3
    },
    limits: { transfer: { L1: { D: 14 }, L2: { D: 100 } } }
  });
}

beforeAll(async () => {
  enableCardanoPreprod({ providerUrl: 'http://127.0.0.1:1', providerTimeoutMs: 1000 });
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
  it('is reachable without an Origin header', async () => {
    // The point of the exemption. A scheduler sends no `Origin`, so an endpoint behind that check is
    // an endpoint no scheduler can reach — and the failure would look like a CORS problem rather than
    // like a design mistake.
    const { status } = await call('/internal/cardano/staking/sync', {
      method: 'POST',
      origin: false,
      body: {}
    });

    expect(status).not.toBe(403);
  });

  it('refuses a call carrying no identity token', async () => {
    const { status } = await call('/internal/cardano/staking/sync', {
      method: 'POST',
      authorization: null,
      body: {}
    });

    expect(status).toBe(401);
  });

  it('refuses the internal bearer token that the rest of the product uses', async () => {
    // Deliberate: this endpoint verifies who is calling, and a shared token answers a different
    // question. Accepting it here would make the OIDC verification decorative.
    const { status } = await call('/internal/cardano/staking/sync', { method: 'POST', body: {} });

    expect(status).toBe(401);
  });

  it('reaches its own verification rather than the shared-token check', async () => {
    // The bug this test was written and then failed to find at first. The global auth hook demands a
    // token *it* recognises, so a Google identity token was rejected before the handler's OIDC
    // verification ever ran — which would have made the endpoint unreachable by any scheduler. The
    // refusal has to come from the OIDC layer, and the reason it carries is how that is visible.
    const { status, text } = await call('/internal/cardano/staking/sync', {
      method: 'POST',
      authorization: 'Bearer not-a-token',
      body: {}
    });

    expect(status).toBe(401);
    expect(text).not.toContain('Invalid Authorization Token');
  });

  it('says why it refused, so a scheduler can be configured against it', async () => {
    // Unconfigured verifies nothing and therefore allows nobody. That failure mode is the reason the
    // route can be exempt from the shared-token check without becoming open.
    const { text } = await call('/internal/cardano/staking/sync', {
      method: 'POST',
      authorization: 'Bearer not-a-token',
      body: {}
    });

    expect(text).toContain('not_configured');
  });

  it('does not answer a GET', async () => {
    const { status } = await call('/internal/cardano/staking/sync');

    expect(status).toBe(404);
  });
});

describe('the user-facing staking routes', () => {
  it('still require an Origin header', async () => {
    // The exemption is one path, not a prefix. A user route that inherited it would be reachable from
    // any page on the internet.
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

describe('a Google identity token the endpoint accepts', () => {
  const AUDIENCE = 'https://backend.example.net/internal/cardano/staking/sync';
  const SCHEDULER = 'cardano-staking-sync@chatterpay-dev.iam.gserviceaccount.com';
  const KEY_ID = 'suite-key-1';
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });

  /**
   * Mints a token, signed for real.
   *
   * @param claims - Claims to override.
   * @returns The token.
   */
  function token(claims: Record<string, unknown> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: KEY_ID, typ: 'JWT' };
    const payload = {
      iss: 'https://accounts.google.com',
      aud: AUDIENCE,
      email: SCHEDULER,
      email_verified: true,
      iat: now,
      exp: now + 3600,
      ...claims
    };
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const signing = `${encode(header)}.${encode(payload)}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signing);
    return `${signing}.${signer.sign(pair.privateKey).toString('base64url')}`;
  }

  beforeEach(() => {
    resetGoogleOidcKeys();
    setCardanoSyncAuth(AUDIENCE, SCHEDULER);
    googleKeys.value = {
      keys: [
        {
          ...(pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
          kid: KEY_ID,
          use: 'sig',
          alg: 'RS256'
        }
      ]
    };
  });

  afterEach(() => {
    googleKeys.value = null;
    setCardanoSyncAuth('', '');
    resetGoogleOidcKeys();
  });

  it('lets a correctly signed token through to the run', async () => {
    // The positive case, end to end over a socket: signed by the key the endpoint fetches, for this
    // audience, by an accepted principal. Cardano staking is off in this suite, so the run refuses on
    // configuration — which is the answer *past* authentication and is what proves the token was taken.
    const { status, text } = await call('/internal/cardano/staking/sync', {
      method: 'POST',
      authorization: `Bearer ${token()}`,
      body: { jobName: 'cardano-staking-sync' }
    });

    expect(status).not.toBe(401);
    expect(status).not.toBe(403);
    expect(text).not.toContain('not_configured');
  });

  it('refuses the same token minted for another audience', async () => {
    // Google mints a valid token for whatever audience is asked for, so this one is genuine and proves
    // a genuine identity. The audience is what binds a token to this endpoint.
    const { status } = await call('/internal/cardano/staking/sync', {
      method: 'POST',
      authorization: `Bearer ${token({ aud: 'https://some-other-service.example.net' })}`,
      body: {}
    });

    expect(status).toBe(401);
  });

  it('refuses a correctly signed token from an identity it does not accept', async () => {
    const { status } = await call('/internal/cardano/staking/sync', {
      method: 'POST',
      authorization: `Bearer ${token({ email: 'somebody@example.net' })}`,
      body: {}
    });

    expect(status).toBe(403);
  });

  it('refuses an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { status } = await call('/internal/cardano/staking/sync', {
      method: 'POST',
      authorization: `Bearer ${token({ iat: now - 7200, exp: now - 3600 })}`,
      body: {}
    });

    expect(status).toBe(401);
  });
});

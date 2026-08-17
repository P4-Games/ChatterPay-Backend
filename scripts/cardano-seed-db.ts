/**
 * Seeds everything Cardano needs in MongoDB, idempotently.
 *
 * Runs the three data changes of `CARDANO_INTEGRATION_PLAN.md` §5.6 in the order they depend on
 * each other: indexes, then the network, then its token. Every write is an upsert keyed on the
 * natural identity of the row (`chainId`, `address`), so running this twice changes nothing and
 * running it after a partial failure finishes the job.
 *
 * Nothing here is destructive: it never deletes, and it never overwrites a field a human may have
 * tuned in place (limits, provider URL) unless `--force` says so.
 *
 * Usage:
 *   MONGO_URI=... bun run scripts/cardano-seed-db.ts [--dry-run] [--force]
 *
 * On WSL, a MongoDB running on the Windows host is not reachable at 127.0.0.1: use the host IP
 * from `ip route show default`, e.g. mongodb://172.30.64.1:27017/chatterpay-dev
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { getCardanoConfig } from '../src/config/cardanoConfig';
import Blockchain from '../src/models/blockchainModel';
import Token from '../src/models/tokenModel';

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

/** Sentinel used where an EVM token would carry a contract address. ADA has no contract. */
const ADA_ADDRESS_SENTINEL = (network: string): string => `cardano:${network}:lovelace`;

function log(action: string, detail: string): void {
  const prefix = DRY_RUN ? '\x1b[33m[dry-run]\x1b[0m' : '        ';
  console.log(`${prefix} ${action.padEnd(10)} ${detail}`);
}

async function seedBlockchain(): Promise<void> {
  const config = getCardanoConfig();
  const label = config.network === 'mainnet' ? 'Cardano' : 'Cardano Preprod';

  const existing = await Blockchain.findOne({ chainId: config.chainId });
  if (existing && !FORCE) {
    log('skip', `blockchains: chainId ${config.chainId} ya existe (--force para sobrescribir)`);
    return;
  }

  const doc = {
    name: label,
    family: 'cardano' as const,
    chainId: config.chainId,
    environment: config.network === 'mainnet' ? 'PROD' : 'TEST',
    explorer: config.explorerUrl,
    logo: '',
    cardano: {
      network: config.network,
      providerUrl: config.providerUrl,
      ttlSlots: config.ttlSlots,
      depositConfirmations: config.depositConfirmations
    },
    // Transfer limits are product policy and apply to every family.
    //
    // `D` is the *daily operation count* per user level, not an amount — the same shape the EVM
    // rows use. Getting this wrong is silent rather than loud: `userReachedOperationLimit` reads
    // `limits.transfer[level]['D']`, and an object with any other key leaves that `undefined`, so
    // `count >= undefined` is always false and the limit simply never applies.
    //
    // Per-amount limits live on the token (`tokens.operations_limits`), not here.
    limits: {
      transfer: { L1: { D: 14 }, L2: { D: 100 } }
    }
  };

  log(existing ? 'update' : 'insert', `blockchains: ${label} (chainId ${config.chainId})`);
  if (DRY_RUN) return;
  await Blockchain.updateOne({ chainId: config.chainId }, { $set: doc }, { upsert: true });
}

async function seedToken(): Promise<void> {
  const config = getCardanoConfig();
  const address = ADA_ADDRESS_SENTINEL(config.network);

  const existing = await Token.findOne({ address });
  if (existing && !FORCE) {
    log('skip', `tokens: ADA ya existe (--force para sobrescribir)`);
    return;
  }

  const doc = {
    name: 'Cardano ADA',
    symbol: 'ADA',
    display_symbol: 'ADA',
    chain_id: config.chainId,
    // Lovelace: six decimals, a property of Cardano rather than of this deployment.
    decimals: 6,
    display_decimals: 2,
    address,
    type: 'variable',
    ramp_enabled: false,
    logo: '',
    operations_limits: {
      // `min` clears the min-ADA of an output (~0.85 ADA on Preprod). Below it a transfer is not
      // expensive, it is invalid.
      transfer: { L1: { min: 1, max: 100 }, L2: { min: 1, max: 500 } },
      // Swaps are out of scope for V1; the schema requires the shape, so it declares zero range.
      swap: { L1: { min: 0, max: 0 }, L2: { min: 0, max: 0 } }
    }
  };

  log(existing ? 'update' : 'insert', `tokens: ADA (${address})`);
  if (DRY_RUN) return;
  await Token.updateOne({ address }, { $set: doc }, { upsert: true });
}

async function createIndexes(): Promise<void> {
  // `users` has no index on `wallets` today. With Cardano every user carries two or more entries,
  // and at least one existing query already scans the collection to find one.
  const indexes = [
    { key: { 'wallets.wallet_proxy': 1 }, name: 'wallets_proxy' },
    { key: { 'wallets.chain_id': 1, 'wallets.wallet_proxy': 1 }, name: 'wallets_chain_proxy' }
  ];

  const collection = mongoose.connection.db!.collection('users');
  const existing = new Set((await collection.indexes()).map((index) => index.name));

  for (const index of indexes) {
    if (existing.has(index.name)) {
      log('skip', `index: users.${index.name} ya existe`);
      continue;
    }
    log('create', `index: users.${index.name}`);
    if (DRY_RUN) continue;
    await collection.createIndex(index.key as Record<string, 1>, {
      name: index.name,
      background: true
    });
  }
}

async function main(): Promise<number> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ falta MONGO_URI');
    return 1;
  }

  const config = getCardanoConfig();
  console.log(`\nred      : Cardano ${config.network} (chainId ${config.chainId})`);
  console.log(`provider : ${config.providerUrl}`);
  console.log(`mongo    : ${uri.replace(/\/\/[^@]*@/, '//***@')}`);
  console.log(DRY_RUN ? '\nmodo     : DRY RUN (no escribe nada)\n' : '');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await createIndexes();
    await seedBlockchain();
    await seedToken();
  } finally {
    await mongoose.disconnect();
  }

  console.log(`\n${DRY_RUN ? 'Dry run terminado.' : '✅ Seed terminado.'}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('\n❌ error:', error);
    process.exit(1);
  });

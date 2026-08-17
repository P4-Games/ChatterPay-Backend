/**
 * Registers a Cardano native asset (USDCx, USDM, USDA, …) in the token catalogue.
 *
 * Deliberately a separate script that takes the policy id explicitly, and deliberately **not** a
 * table of hardcoded stablecoins in the repository. The reason is the failure mode: a wrong policy
 * id does not produce an error. It produces a perfectly valid transfer of an asset that is not the
 * one the user believes they are sending, and nothing downstream can tell the difference.
 *
 * So the values arrive from whoever verified them, and this script's job is to refuse anything that
 * is not structurally a Cardano asset before it reaches the database.
 *
 * **Where to verify a policy id — cross-check all three:**
 *   1. https://github.com/cardano-foundation/cardano-token-registry (mappings/<policyId><assetNameHex>.json)
 *   2. The issuer's own documentation.
 *   3. Cardanoscan: https://cardanoscan.io/token/<policyId><assetNameHex>
 *
 * Usage:
 *   MONGO_URI=... bun run scripts/cardano-add-token.ts \
 *     --symbol USDM --policy-id <56 hex chars> --asset-name-ascii USDM --decimals 6 \
 *     [--asset-name <hex>] [--token-type stable|variable] [--min 1] [--max 1000] [--dry-run] [--force]
 *
 * Note that `--asset-name` is the **hex** encoding of the name and `--asset-name-ascii` is the
 * readable form; pass one or the other. An empty name is legal, so passing neither is allowed and
 * means exactly that.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { getCardanoConfig } from '../src/config/cardanoConfig';
import Token from '../src/models/tokenModel';

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function fail(message: string): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

async function main(): Promise<number> {
  const uri = process.env.MONGO_URI;
  if (!uri) fail('falta MONGO_URI');

  const symbol = arg('symbol');
  const policyId = arg('policy-id')?.toLowerCase();
  const decimalsRaw = arg('decimals');

  if (!symbol) fail('falta --symbol');
  if (!policyId) fail('falta --policy-id');
  if (decimalsRaw === undefined) fail('falta --decimals');

  // A minting policy hash is blake2b-224: 28 bytes, 56 hex characters. Nothing else is one, and a
  // value that merely looks close is the exact mistake this check exists to catch.
  if (!/^[0-9a-f]{56}$/.test(policyId)) {
    fail(`--policy-id debe ser 56 caracteres hex (28 bytes); recibí ${policyId.length}: '${policyId}'`);
  }

  const asciiName = arg('asset-name-ascii');
  const hexName = arg('asset-name')?.toLowerCase();
  if (asciiName && hexName) fail('pasá --asset-name o --asset-name-ascii, no ambos');

  const assetName = hexName ?? (asciiName ? Buffer.from(asciiName, 'utf8').toString('hex') : '');
  if (assetName && !/^([0-9a-f]{2})+$/.test(assetName)) {
    fail(`--asset-name debe ser hex; recibí '${assetName}'`);
  }
  // CIP-14: an asset name is at most 32 bytes.
  if (assetName.length > 64) {
    fail(`el asset name excede 32 bytes (${assetName.length / 2})`);
  }

  // `stable` or `variable`, the same two values every EVM row uses. It drives how the token is
  // priced and displayed, so it is asked for rather than assumed: USDM is a stablecoin, a governance
  // token on the same chain is not.
  const tokenType = arg('token-type') ?? 'stable';
  if (tokenType !== 'stable' && tokenType !== 'variable') {
    fail(`--token-type debe ser 'stable' o 'variable'; recibí '${tokenType}'`);
  }

  const decimals = Number.parseInt(decimalsRaw, 10);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    fail(`--decimals debe ser un entero entre 0 y 18; recibí '${decimalsRaw}'`);
  }

  const config = getCardanoConfig();
  const unit = `${policyId}${assetName}`;
  const min = Number(arg('min') ?? '1');
  const max = Number(arg('max') ?? '1000');

  console.log(`\nred        : Cardano ${config.network} (chainId ${config.chainId})`);
  console.log(`símbolo    : ${symbol}`);
  console.log(`policy id  : ${policyId}`);
  console.log(`asset name : ${assetName || '(vacío)'}${asciiName ? ` ("${asciiName}")` : ''}`);
  console.log(`unit       : ${unit}`);
  console.log(`decimales  : ${decimals}`);
  console.log(`\nVerificá este policy id en cardanoscan antes de seguir:`);
  console.log(`  https://cardanoscan.io/token/${unit}\n`);

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    const existing = await Token.findOne({ address: unit });
    if (existing && !FORCE) {
      console.log(`skip: '${symbol}' ya está registrado (--force para sobrescribir)\n`);
      return 0;
    }

    // A second row with the same ticker on the same network would make symbol lookup ambiguous, and
    // the lookup is what a transfer request resolves against.
    const clash = await Token.findOne({
      symbol: new RegExp(`^${symbol}$`, 'i'),
      chain_id: config.chainId,
      address: { $ne: unit }
    });
    if (clash) {
      fail(
        `ya existe otro token con símbolo '${symbol}' en esta red, con unit '${clash.address}'. ` +
          `Dos activos con el mismo ticker hacen ambigua la resolución de una transferencia.`
      );
    }

    const doc = {
      name: symbol,
      symbol,
      display_symbol: symbol,
      chain_id: config.chainId,
      decimals,
      display_decimals: Math.min(decimals, 2),
      address: unit,
      type: tokenType,
      ramp_enabled: false,
      logo: '',
      operations_limits: {
        transfer: { L1: { min, max }, L2: { min, max } },
        swap: { L1: { min: 0, max: 0 }, L2: { min: 0, max: 0 } }
      }
    };

    console.log(`${DRY_RUN ? '[dry-run] ' : ''}${existing ? 'update' : 'insert'}: tokens/${symbol}`);
    if (!DRY_RUN) await Token.updateOne({ address: unit }, { $set: doc }, { upsert: true });

    console.log(`\n${DRY_RUN ? 'Dry run terminado.' : `✅ '${symbol}' registrado.`}\n`);
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('\n❌ error:', error);
    process.exit(1);
  });

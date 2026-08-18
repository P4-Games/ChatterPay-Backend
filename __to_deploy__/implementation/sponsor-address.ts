/**
 * Calcula la address del sponsor wallet de Cardano.
 *
 * Correr en el entorno que tenga el SEED_INTERNAL_SALT correcto:
 *
 *   bun run __to_deploy__/docu/implementation/sponsor-address.ts
 *
 * O seteando las variables explícitamente:
 *
 *   SEED_INTERNAL_SALT='...' BUN_ENV='production' bun run __to_deploy__/docu/implementation/sponsor-address.ts
 *
 * La address se deriva del mismo master secret que las wallets de los usuarios. No se puede
 * reemplazar por una wallet externa porque el backend necesita la clave privada para firmar
 * cada transferencia patrocinada.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { blake2b } from '@noble/hashes/blake2';
import { sha256 } from '@noble/hashes/sha2';
import { bech32 } from '@scure/base';

const SEED_BYTES = 32;
const CREDENTIAL_HASH_BYTES = 28;
const BECH32_LIMIT = 256;
const SCHEME_VERSION = 'v1';

type CardanoNetwork = 'testnet' | 'mainnet';

const NETWORK_ID: Record<CardanoNetwork, number> = { testnet: 0, mainnet: 1 };
const HRP: Record<CardanoNetwork, string> = { testnet: 'addr_test', mainnet: 'addr' };
const CHAIN_ID: Record<CardanoNetwork, number> = { testnet: 900000000001, mainnet: 900764824073 };

// ---- derivation (mirrors cardanoSignerService.ts) ----

function sponsorSeed(
  salt: string,
  env: string,
  walletId: string,
  network: CardanoNetwork,
  chainId: number
): Buffer {
  const ikm = Buffer.from(`${salt}${env}${walletId}`, 'utf8');
  const hkdfSalt = Buffer.from(`chatterpay:cardano:${network}`, 'utf8');
  const info = Buffer.from(`ed25519:sponsor:${SCHEME_VERSION}:${chainId}`, 'utf8');
  return Buffer.from(hkdf(sha256, ikm, hkdfSalt, info, SEED_BYTES));
}

function publicKeyOf(seed: Buffer): string {
  return Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
}

function credential(pubKeyHex: string): Uint8Array {
  return blake2b(Buffer.from(pubKeyHex, 'hex'), { dkLen: CREDENTIAL_HASH_BYTES });
}

function baseAddress(paymentPubHex: string, stakePubHex: string, network: CardanoNetwork): string {
  const header = (0 << 4) | NETWORK_ID[network]; // type 0 = base key-key
  const payload = Uint8Array.from([header, ...credential(paymentPubHex), ...credential(stakePubHex)]);
  return bech32.encode(HRP[network], bech32.toWords(payload), BECH32_LIMIT);
}

// ---- main ----

const salt = process.env.SEED_INTERNAL_SALT;
const env = process.env.BUN_ENV ?? 'localhost';
const walletId = process.env.CARDANO_SPONSOR_WALLET_ID ?? 'chatterpay-sponsor';

if (!salt) {
  console.error('SEED_INTERNAL_SALT is not set. Set it in .env or pass it explicitly.');
  process.exit(1);
}

for (const network of ['testnet', 'mainnet'] as CardanoNetwork[]) {
  const chainId = CHAIN_ID[network];
  const seed = sponsorSeed(salt, env, walletId, network, chainId);
  const paymentPub = publicKeyOf(seed);

  const stakeSeed = Buffer.from(
    hkdf(
      sha256,
      seed,
      Buffer.from(`chatterpay:cardano:${network}`, 'utf8'),
      Buffer.from('ed25519:sponsor-stake:v1', 'utf8'),
      SEED_BYTES
    )
  );
  const stakePub = publicKeyOf(stakeSeed);
  const address = baseAddress(paymentPub, stakePub, network);

  console.log(`${network.padEnd(8)} ${address}`);
}

console.log(`\nWallet ID : ${walletId}`);
console.log(`BUN_ENV   : ${env}`);
console.log(`Salt      : (${salt.length} chars, set)`);

/**
 * Opens the Cardano staking collections and gives every existing Cardano wallet an account row.
 *
 * **Nothing is enabled by this migration.** Every account it creates is `awaiting_consent` with
 * `preference.enabled: false`, because this database holds no evidence that anyone accepted staking
 * terms, and a backfill is not consent. It signs nothing, submits nothing, and never writes to
 * `users` — the user document is read and left byte for byte as it was.
 *
 * What it does, in order:
 *
 * 1. Builds the indexes the staking models declare. Only builds: an index on the collection that
 *    the schema does not declare is reported and left alone.
 * 2. Derives each Cardano wallet's stake credential and reward address from its stored staking
 *    public key, and checks the derived credential against the one already inside the wallet's own
 *    bech32 address. A wallet whose two disagree is reported and skipped, never written.
 * 3. Creates the account row.
 *
 * **On-chain state is deliberately not read here.** Step 3 of the specification asks for the
 * credential's registration status, and this migration leaves `onChain.asOf` null instead, which is
 * exactly what "never read" already means in that schema. Reading it would need provider
 * credentials and network access inside a migration, and the daily sync fills it on its first pass
 * with the same code every later read uses. A migration that fetches on-chain state would be a
 * second, less tested copy of it.
 */

import mongoose, { Types } from 'mongoose';

import { CARDANO_MAINNET_CHAIN_ID, CARDANO_PREPROD_CHAIN_ID } from '../config/cardanoConfig';
import CardanoStakingAccount from '../models/cardanoStakingAccountModel';
import { declaredIndexNames, STAKING_COLLECTIONS } from '../models/cardanoStakingCollections';
import {
  decodeCardanoAddress,
  rewardAddress,
  stakeCredentialHex
} from '../services/cardano/cardanoAddressService';
import type { CardanoNetwork } from '../types/cardanoType';
import type {
  Migration,
  MigrationFinding,
  MigrationOptions,
  MigrationReport,
  MigrationWriter
} from './migrationRunner';

export const MIGRATION_NAME = '0001-cardano-staking-bootstrap';

/** Which network a Cardano chain id belongs to. */
const NETWORK_BY_CHAIN_ID: Readonly<Record<number, CardanoNetwork>> = {
  [CARDANO_PREPROD_CHAIN_ID]: 'testnet',
  [CARDANO_MAINNET_CHAIN_ID]: 'mainnet'
};

/** CIP-19 address type this deployment issues, and the only one carrying a staking credential here. */
const BASE_ADDRESS_TYPE = 0;

/** How many users are read from Mongo at a time. */
const SCAN_BATCH_SIZE = 200;

/** Collections this migration reads from, by name rather than through a model. See {@link collection}. */
const USERS_COLLECTION = 'users';
const ACCOUNTS_COLLECTION = 'cardano_staking_accounts';

/**
 * A collection, straight from the driver.
 *
 * Every read this migration makes goes through here rather than through a Mongoose model. Mongoose
 * initialises a model on its first operation, and that initialisation can create the collection and
 * build its indexes -- which in a dry run would be writes that no branch of this file asked for.
 * The driver does neither, so "a dry run writes nothing" stops depending on a lazy-initialisation
 * setting being read at the right moment. Writes still go through the models, via the writer.
 *
 * @param name - Collection to read.
 * @returns The driver-level collection handle.
 */
function collection(name: string) {
  const db = mongoose.connection.db;
  if (db === undefined) throw new Error('MIGRATION_NO_DATABASE_CONNECTION');
  return db.collection(name);
}

/** The shape of a user this migration reads. Nothing else is loaded, and nothing is written back. */
interface ScannedWallet {
  wallet_proxy?: string;
  chain_id?: number;
  address_type?: string;
  cardano_stake_public_key?: string;
}

interface ScannedUser {
  _id: Types.ObjectId;
  wallets?: ScannedWallet[];
}

/** What the backfill decided about one wallet. */
type WalletVerdict = 'inserted' | 'already_present' | 'skipped';

/**
 * Builds the declared indexes, and reports anything on the collections that the schemas do not
 * declare.
 *
 * Extra indexes are named, never dropped. `syncIndexes` would drop them, and a migration that drops
 * an index it does not recognise removes the support of a query nobody in this run knows about.
 * Reverting *schema* is what a rollback of this migration means; deciding about a foreign index is
 * a separate, deliberate act.
 *
 * @param writer - The run's writer. In a dry run it performs nothing.
 * @param findings - Collected findings, appended to.
 * @param counts - Counters, updated in place.
 */
async function buildIndexes(
  writer: MigrationWriter,
  findings: MigrationFinding[],
  counts: Record<string, number>
): Promise<void> {
  for (const { model, collection: name } of STAKING_COLLECTIONS) {
    const declared = new Set(declaredIndexNames(model));
    const before = await presentIndexes(name);

    const missing = [...declared].filter((declaredName) => !before.includes(declaredName));
    await writer.createIndexes(model, `${name} (${missing.length} missing)`);
    counts.indexedCollections += 1;
    counts.indexesCreated += missing.length;

    for (const found of before) {
      // `_id_` is the collection's own, and no schema declares it.
      if (found === '_id_' || declared.has(found)) continue;
      findings.push({
        code: 'undeclared_index',
        subject: `${name}.${found}`,
        detail: 'index present on the collection and not declared by the schema; left in place'
      });
    }

    if (writer.dryRun) continue;

    // Read the collection back rather than trusting the create to have done what it said. An index
    // build can fail on its own -- a duplicate key already in the data is the ordinary way a unique
    // index refuses to come into being -- and that failure has to be a finding, because the whole
    // safety of this rollout rests on uniqueness the collection has not got.
    const after = await presentIndexes(name);
    const stillMissing = [...declared].filter((declaredName) => !after.includes(declaredName));
    counts.indexesVerified += declared.size - stillMissing.length;

    for (const absent of stillMissing) {
      findings.push({
        code: 'index_verification_failed',
        subject: `${name}.${absent}`,
        detail: 'declared index is still absent after the migration tried to build it'
      });
    }
  }
}

/**
 * The index names a collection currently has.
 *
 * @param name - Collection to inspect.
 * @returns The names, or nothing at all when the collection does not exist yet -- which on a first
 *   run is the ordinary case and means everything is still to create.
 */
async function presentIndexes(name: string): Promise<string[]> {
  try {
    return (await collection(name).listIndexes().toArray()).map((index) => String(index.name));
  } catch {
    return [];
  }
}

/**
 * Derives the staking identifiers of one wallet and checks them against the wallet's own address.
 *
 * The check is the point. The stake credential is written inside a CIP-19 base address, and it is
 * also derivable from the stored staking public key; if the two disagree, one of them belongs to a
 * different wallet, and an account row built from either would attach a deposit and a reward stream
 * to the wrong user. There is no safe way to guess which side is right, so neither is written.
 *
 * @param wallet - The Cardano wallet entry, as stored.
 * @param network - Network the wallet's chain id resolves to.
 * @returns The derived identifiers, or the reason they cannot be trusted.
 */
function deriveStakingIdentifiers(
  wallet: ScannedWallet,
  network: CardanoNetwork
): { credentialHex: string; reward: string } | { code: string; detail: string } {
  const storedKey = wallet.cardano_stake_public_key;
  if (storedKey === undefined || storedKey === '') {
    return {
      code: 'missing_stake_public_key',
      detail: 'wallet has no cardano_stake_public_key; nothing can be derived'
    };
  }

  let credentialHex: string;
  let reward: string;
  try {
    // The stored key carries a `0x` prefix; the derivation strips it itself.
    credentialHex = stakeCredentialHex(storedKey);
    reward = rewardAddress(storedKey, network);
  } catch (error) {
    return {
      code: 'underivable_credential',
      detail: `cardano_stake_public_key is not a usable key: ${(error as Error).message}`
    };
  }

  const address = wallet.wallet_proxy ?? '';
  const decoded = decodeCardanoAddress(address);
  if (decoded === null) {
    return { code: 'unreadable_wallet_address', detail: `wallet_proxy is not a Cardano address` };
  }
  if (decoded.network !== network) {
    return {
      code: 'network_mismatch',
      detail: `wallet_proxy is a ${decoded.network} address on a ${network} chain id`
    };
  }
  if (decoded.addressType !== BASE_ADDRESS_TYPE) {
    return {
      code: 'not_a_base_address',
      detail: `wallet_proxy is address type ${decoded.addressType}, which carries no staking credential`
    };
  }
  if (decoded.stakeCredentialHex !== credentialHex) {
    return {
      code: 'credential_mismatch',
      detail:
        'credential derived from cardano_stake_public_key differs from the one in wallet_proxy'
    };
  }

  return { credentialHex, reward };
}

/**
 * Creates the account for one wallet, or explains why it did not.
 *
 * @param user - User the wallet belongs to.
 * @param wallet - The Cardano wallet entry.
 * @param writer - The run's writer.
 * @param findings - Collected findings, appended to.
 * @param seenCredentials - Credentials already claimed within this run, keyed `chainId:hex`.
 * @returns What was decided about this wallet.
 */
async function backfillWallet(
  user: ScannedUser,
  wallet: ScannedWallet,
  writer: MigrationWriter,
  findings: MigrationFinding[],
  seenCredentials: Map<string, string>
): Promise<WalletVerdict> {
  const subject = `${user._id.toHexString()} ${wallet.wallet_proxy ?? '(no address)'}`;
  const chainId = wallet.chain_id;
  const network = chainId === undefined ? undefined : NETWORK_BY_CHAIN_ID[chainId];

  if (chainId === undefined || network === undefined) {
    findings.push({
      code: 'unknown_chain_id',
      subject,
      detail: `chain_id ${String(chainId)} is not a Cardano network`
    });
    return 'skipped';
  }

  const derived = deriveStakingIdentifiers(wallet, network);
  if ('code' in derived) {
    findings.push({ code: derived.code, subject, detail: derived.detail });
    return 'skipped';
  }

  const credentialKey = `${chainId}:${derived.credentialHex}`;
  const claimedBy = seenCredentials.get(credentialKey);
  if (claimedBy !== undefined && claimedBy !== user._id.toHexString()) {
    findings.push({
      code: 'duplicate_credential',
      subject,
      detail: `the same stake credential is also derived for user ${claimedBy}; neither was written`
    });
    return 'skipped';
  }
  seenCredentials.set(credentialKey, user._id.toHexString());

  // An account that already exists is never rewritten. Reconciling an account whose stored
  // identifiers differ from the derived ones is an operator decision: one of the two is a wallet
  // that changed under a live deposit, and overwriting it would erase the evidence of which.
  const existing = await collection(ACCOUNTS_COLLECTION).findOne({ userId: user._id, chainId });
  if (existing !== null) {
    const differs =
      existing.stakeCredentialHex !== derived.credentialHex ||
      existing.rewardAddress !== derived.reward ||
      existing.walletAddress !== wallet.wallet_proxy;
    if (differs) {
      findings.push({
        code: 'account_differs',
        subject,
        detail: 'an account exists with different identifiers; left untouched'
      });
      return 'skipped';
    }
    return 'already_present';
  }

  const owner = await collection(ACCOUNTS_COLLECTION).findOne(
    { chainId, stakeCredentialHex: derived.credentialHex },
    { projection: { userId: 1 } }
  );
  if (owner !== null) {
    findings.push({
      code: 'credential_owned_by_another_account',
      subject,
      detail: `stake credential already belongs to user ${String(owner.userId)}`
    });
    return 'skipped';
  }

  const outcome = await writer.insert(
    CardanoStakingAccount,
    {
      userId: user._id,
      chainId,
      walletAddress: wallet.wallet_proxy,
      rewardAddress: derived.reward,
      stakeCredentialHex: derived.credentialHex,
      // Spelled out rather than left to the schema defaults, because these three are the whole
      // safety property of the backfill and a default that changes later must not change what a
      // past run meant.
      termsConsent: null,
      preference: { enabled: false, version: 0, updatedAt: new Date() },
      state: 'awaiting_consent'
    },
    subject
  );

  if (outcome === 'duplicate') {
    // The pre-checks above missed it, which means another writer inserted between them and here.
    findings.push({
      code: 'credential_collision_on_insert',
      subject,
      detail: 'a unique index refused the row; another process created it first'
    });
    return 'skipped';
  }

  return 'inserted';
}

/**
 * Runs the migration.
 *
 * @param options - How the run was invoked.
 * @param writer - The only route to writing.
 * @returns What happened, or would have.
 */
async function run(options: MigrationOptions, writer: MigrationWriter): Promise<MigrationReport> {
  const findings: MigrationFinding[] = [];
  const counts: Record<string, number> = {
    indexedCollections: 0,
    indexesCreated: 0,
    indexesVerified: 0,
    usersScanned: 0,
    walletsScanned: 0,
    accountsCreated: 0,
    accountsAlreadyPresent: 0,
    walletsSkipped: 0
  };

  await buildIndexes(writer, findings, counts);

  const filter: Record<string, unknown> = { 'wallets.address_type': 'cardano_base' };
  if (options.userId !== null) filter._id = new Types.ObjectId(options.userId);
  // Paging by ascending `_id` is what makes an interrupted run resumable without a checkpoint of
  // its own: `--resume-after` picks up exactly where the report said it stopped.
  if (options.resumeAfter !== null) {
    filter._id = { ...(filter._id as object), $gt: new Types.ObjectId(options.resumeAfter) };
  }

  const seenCredentials = new Map<string, string>();
  let lastProcessedId: string | null = null;

  const cursor = collection(USERS_COLLECTION)
    .find(filter, { projection: { _id: 1, wallets: 1 } })
    .sort({ _id: 1 })
    .batchSize(SCAN_BATCH_SIZE);

  for await (const raw of cursor) {
    const user = raw as unknown as ScannedUser;
    if (options.limit !== null && counts.usersScanned >= options.limit) break;

    counts.usersScanned += 1;
    for (const wallet of user.wallets ?? []) {
      if (wallet.address_type !== 'cardano_base') continue;
      if (options.chainId !== null && wallet.chain_id !== options.chainId) continue;

      counts.walletsScanned += 1;
      const verdict = await backfillWallet(user, wallet, writer, findings, seenCredentials);
      if (verdict === 'inserted') counts.accountsCreated += 1;
      else if (verdict === 'already_present') counts.accountsAlreadyPresent += 1;
      else counts.walletsSkipped += 1;
    }
    // Advanced only once the user is fully processed, so resuming from it never skips a wallet.
    lastProcessedId = user._id.toHexString();
  }

  await cursor.close();

  return {
    name: MIGRATION_NAME,
    dryRun: writer.dryRun,
    effects: writer.effects,
    findings,
    counts,
    lastProcessedId,
    ok: findings.length === 0
  };
}

const migration: Migration = { name: MIGRATION_NAME, run };

export default migration;

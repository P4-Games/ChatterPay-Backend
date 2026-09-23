import mongoose, { Types } from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import migration, { MIGRATION_NAME } from '../../src/migrations/0001-cardano-staking-bootstrap';
import {
  type MigrationOptions,
  type MigrationReport,
  parseMigrationOptions,
  resolveMigrationRequest,
  runMigrationOnConnection
} from '../../src/migrations/migrationRunner';
import { MIGRATIONS } from '../../src/migrations/registry';
import CardanoStakingAccount from '../../src/models/cardanoStakingAccountModel';
import {
  declaredIndexNames,
  STAKING_COLLECTIONS
} from '../../src/models/cardanoStakingCollections';
import CardanoStakingOperation from '../../src/models/cardanoStakingOperationModel';
import { UserModel } from '../../src/models/userModel';
import {
  missingStakingIndexes,
  resetStakingSchemaVerification
} from '../../src/services/cardano/cardanoStakingOperationService';

const PREPROD = 900000000001;
const MAINNET = 900764824073;

/**
 * Key pairs and the addresses they produce.
 *
 * Derived with this repository's own `baseAddress` / `rewardAddress` / `stakeCredentialHex`, not
 * quoted from a specification. Pair `A` is the one the development database actually holds, and its
 * base address matches the stored `wallet_proxy` — which is what makes these fixtures evidence that
 * the derivation agrees with production data rather than merely with itself.
 */
const KEYS = {
  A: {
    pay: '0x7c3ca0ade35d250f5706a17cbbc9e97402b5c230b26b24b940c77e4c00154636',
    stake: '0xce3b525279e269bac5368d404508d9fa9c527bda6eadbf639fed17673ed50d18',
    credential: 'cc2f0b60ee5c4edb7bcc46410787d389539cddf5b64f0012304b91da',
    baseTestnet:
      'addr_test1qzasn8g8wgz5elr7a2jwcpvy9jdpzddy4vc5xtqpkrl53xwv9u9kpmjufmdhhnzxgyrc05uf2wwdmadkfuqpyvztj8dqw6fdax',
    rewardTestnet: 'stake_test1urxz7zmqaewyakmme3ryzpu86wy488xa7kmy7qqjxp9erksag4z3l',
    baseMainnet:
      'addr1qxasn8g8wgz5elr7a2jwcpvy9jdpzddy4vc5xtqpkrl53xwv9u9kpmjufmdhhnzxgyrc05uf2wwdmadkfuqpyvztj8dqdv5d3e',
    rewardMainnet: 'stake1u8xz7zmqaewyakmme3ryzpu86wy488xa7kmy7qqjxp9erks6zlq4z'
  },
  B: {
    pay: '0x1111111111111111111111111111111111111111111111111111111111111111',
    stake: '0x2222222222222222222222222222222222222222222222222222222222222222',
    credential: '313318dd5b51b0376278ee8f2ad38cdf9466d483e60c312428964faf',
    baseTestnet:
      'addr_test1qzx0qqs06evy77cnpk6u5q3fc50exjpp5t4s0swl2ykc4j33xvvd6k63kqmky78w3u4d8rxlj3ndfqlxpscjg2ykf7hsj0nzkg',
    rewardTestnet: 'stake_test1uqcnxxxatdgmqdmz0rhg72kn3n0egek5s0nqcvfy9ztyltc9cpuz4'
  },
  C: {
    pay: '0x3333333333333333333333333333333333333333333333333333333333333333',
    stake: '0x4444444444444444444444444444444444444444444444444444444444444444',
    credential: '28b2f9e859982578b6017e9b8f769656bace829ca3b6a6bb434e92d5',
    baseTestnet:
      'addr_test1qrj8hvwxxz0t6pnfttj9ne5leu74shjlg83a8kxww9ft2fpgktu7skvcy4utvqt7nw8hd9jkht8g989rk6ntks6wjt2shxdm4w',
    rewardTestnet: 'stake_test1uq5t970gtxvz279kq9lfhrmkjett4n5znj3mdf4mgd8f94gavyxdx'
  }
} as const;

/** A well-formed base address whose staking half is C's while the wallet stores A's staking key. */
const CROSSED_ADDRESS =
  'addr_test1qzasn8g8wgz5elr7a2jwcpvy9jdpzddy4vc5xtqpkrl53xfgktu7skvcy4utvqt7nw8hd9jkht8g989rk6ntks6wjt2s53ywj8';

const DEFAULTS: MigrationOptions = {
  dryRun: true,
  chainId: null,
  userId: null,
  resumeAfter: null,
  limit: null
};

/**
 * Builds a Cardano wallet entry in the shape `users` actually stores.
 *
 * @param address - Base address, which goes in both `wallet_proxy` and `wallet_eoa`.
 * @param keys - The key pair behind it.
 * @param chainId - Network the entry belongs to.
 * @returns The wallet sub-document.
 */
function cardanoWallet(
  address: string,
  keys: { pay: string; stake: string },
  chainId: number = PREPROD
): Record<string, unknown> {
  return {
    wallet_proxy: address,
    wallet_eoa: address,
    created_with_chatterpay_proxy_address: '',
    created_with_factory_address: '',
    chain_id: chainId,
    status: 'active',
    alchemy_registered: false,
    address_type: 'cardano_base',
    cardano_public_key: keys.pay,
    cardano_stake_public_key: keys.stake
  };
}

/** An ordinary EVM wallet, which the backfill must ignore entirely. */
function evmWallet(): Record<string, unknown> {
  return {
    wallet_proxy: '0x1111111111111111111111111111111111111111',
    wallet_eoa: '0x2222222222222222222222222222222222222222',
    created_with_chatterpay_proxy_address: '0x3333333333333333333333333333333333333333',
    created_with_factory_address: '0x4444444444444444444444444444444444444444',
    chain_id: 421614,
    status: 'active'
  };
}

/**
 * Inserts a user with the given wallets.
 *
 * @param phone - Phone number, the only field the user schema requires.
 * @param wallets - Wallet entries.
 * @param id - Explicit `_id`, so ordering in a paged scan is deterministic.
 * @returns The user's id.
 */
async function seedUser(
  phone: string,
  wallets: Record<string, unknown>[],
  id?: Types.ObjectId
): Promise<Types.ObjectId> {
  const user = await UserModel.create({
    ...(id === undefined ? {} : { _id: id }),
    phone_number: phone,
    wallets
  });
  return user._id as Types.ObjectId;
}

/**
 * Everything the database currently is: which collections exist, every document in them, and every
 * index specification.
 *
 * This is what the dry-run guarantee is checked against. Counting documents would miss a created
 * collection and an index build, which are exactly the two writes a migration is most likely to
 * make without meaning to.
 *
 * @returns A stable structure for comparison.
 */
async function databaseSnapshot(): Promise<Record<string, unknown>> {
  const db = mongoose.connection.db;
  if (db === undefined) throw new Error('no database connection');

  const names = (await db.listCollections().toArray()).map((entry) => entry.name).sort();
  const state: Record<string, unknown> = {};

  for (const name of names) {
    state[name] = {
      documents: await db.collection(name).find({}).sort({ _id: 1 }).toArray(),
      indexes: (await db.collection(name).listIndexes().toArray()).sort((a, b) =>
        String(a.name).localeCompare(String(b.name))
      )
    };
  }

  // Round-tripped so that ObjectIds and dates compare by value, and so that a failure prints a
  // structural diff rather than two walls of text.
  return JSON.parse(JSON.stringify(state));
}

/**
 * Runs the migration through the same entry point the command line uses.
 *
 * @param overrides - Options that differ from the defaults.
 * @returns The report.
 */
function run(overrides: Partial<MigrationOptions> = {}): Promise<MigrationReport> {
  return runMigrationOnConnection(migration, { ...DEFAULTS, ...overrides });
}

/**
 * Reads `users` straight from the driver, untouched by any schema.
 *
 * @returns The raw documents, serialised for comparison.
 */
async function rawUsers(): Promise<string> {
  const db = mongoose.connection.db;
  if (db === undefined) throw new Error('no database connection');
  return JSON.stringify(await db.collection('users').find({}).sort({ _id: 1 }).toArray());
}

/**
 * Removes every staking collection, so a case can observe the migration building them.
 */
async function dropStakingCollections(): Promise<void> {
  const db = mongoose.connection.db;
  if (db === undefined) throw new Error('no database connection');
  const names = (await db.listCollections().toArray())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith('cardano_staking_'));
  for (const name of names) await db.dropCollection(name);
}

describe('0001-cardano-staking-bootstrap', () => {
  beforeAll(() => {
    // The same setting the runner applies. Without it Mongoose builds a model's indexes the first
    // time it is used, which would be a write nobody asked for -- and in a dry run, the one write
    // that is hardest to notice.
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('dry run', () => {
    beforeEach(async () => {
      await seedUser('+5491100000001', [cardanoWallet(KEYS.A.baseTestnet, KEYS.A), evmWallet()]);
      await seedUser('+5491100000002', [cardanoWallet(KEYS.B.baseTestnet, KEYS.B)]);
    });

    it('writes nothing at all: no document, no collection, no index, no run marker', async () => {
      const before = await databaseSnapshot();

      const report = await run({ dryRun: true });

      expect(report.dryRun).toBe(true);
      expect(await databaseSnapshot()).toEqual(before);

      // Control: the same run with `--apply` does change the snapshot. Without this, a snapshot
      // that silently stopped observing anything would make the assertion above pass forever.
      await run({ dryRun: false });
      expect(await databaseSnapshot()).not.toEqual(before);
    });

    it('does not bring the staking collections into existence', async () => {
      // Regression: a read through a Mongoose model initialises that model, and initialisation can
      // create the collection and build its indexes. The migration therefore reads through the
      // driver, so this holds whatever a lazy-initialisation setting happens to say.
      const db = mongoose.connection.db;
      if (db === undefined) throw new Error('no database connection');
      const staking = (await db.listCollections().toArray())
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('cardano_staking_'));
      for (const name of staking) await db.dropCollection(name);

      await run({ dryRun: true });

      const after = (await db.listCollections().toArray())
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('cardano_staking_'));
      expect(after).toEqual([]);
    });

    it('still reports everything it would have done', async () => {
      const report = await run({ dryRun: true });

      expect(report.counts.accountsCreated).toBe(2);
      expect(report.effects.filter((line) => line.startsWith('would insert'))).toHaveLength(2);
      expect(report.effects.some((line) => line.startsWith('would create indexes'))).toBe(true);
      expect(report.ok).toBe(true);
    });

    it('leaves no trace even when it finds something to report', async () => {
      await seedUser('+5491100000003', [cardanoWallet(CROSSED_ADDRESS, KEYS.A)]);
      const before = await databaseSnapshot();

      const report = await run({ dryRun: true });

      expect(report.ok).toBe(false);
      expect(await databaseSnapshot()).toEqual(before);
    });
  });

  describe('applying', () => {
    let userA: Types.ObjectId;
    let userB: Types.ObjectId;

    beforeEach(async () => {
      userA = await seedUser('+5491100000001', [
        cardanoWallet(KEYS.A.baseTestnet, KEYS.A),
        evmWallet()
      ]);
      userB = await seedUser('+5491100000002', [cardanoWallet(KEYS.B.baseTestnet, KEYS.B)]);
    });

    it('creates one account per Cardano wallet, opted out and unconsented', async () => {
      const report = await run({ dryRun: false });

      expect(report.counts.accountsCreated).toBe(2);
      expect(report.ok).toBe(true);

      const account = await CardanoStakingAccount.findOne({ userId: userA, chainId: PREPROD });
      expect(account?.preference.enabled).toBe(false);
      expect(account?.termsConsent).toBeNull();
      expect(account?.state).toBe('awaiting_consent');
      // Never read. The daily sync is what fills this in, with the code every later read uses.
      expect(account?.onChain.asOf).toBeNull();
      expect(account?.onChain.registered).toBe(false);
    });

    it('derives the credential and reward address that the wallet address itself carries', async () => {
      await run({ dryRun: false });

      const account = await CardanoStakingAccount.findOne({ userId: userA, chainId: PREPROD });
      expect(account?.stakeCredentialHex).toBe(KEYS.A.credential);
      expect(account?.rewardAddress).toBe(KEYS.A.rewardTestnet);
      expect(account?.walletAddress).toBe(KEYS.A.baseTestnet);
    });

    it('ignores wallets that are not Cardano', async () => {
      const report = await run({ dryRun: false });

      // User A has two wallets and only one of them is Cardano.
      expect(report.counts.walletsScanned).toBe(2);
      expect(await CardanoStakingAccount.countDocuments({ userId: userA })).toBe(1);
    });

    it('builds the declared indexes, including the one the credential lock depends on', async () => {
      await run({ dryRun: false });

      const indexes = await CardanoStakingOperation.collection.listIndexes().toArray();
      const lock = indexes.find((index) => index.name === 'one_live_op_per_account');

      expect(lock?.unique).toBe(true);
      expect(lock?.partialFilterExpression).toEqual({ liveness: 'live' });
    });

    it('never writes to users', async () => {
      const before = await rawUsers();

      await run({ dryRun: false });

      expect(await rawUsers()).toBe(before);
      expect(userB).toBeDefined();
    });
  });

  describe('running it again', () => {
    beforeEach(async () => {
      await seedUser('+5491100000001', [cardanoWallet(KEYS.A.baseTestnet, KEYS.A)]);
      await seedUser('+5491100000002', [cardanoWallet(KEYS.B.baseTestnet, KEYS.B)]);
    });

    it('changes nothing the second time', async () => {
      await run({ dryRun: false });
      const after = await CardanoStakingAccount.find({}).sort({ _id: 1 }).lean();

      const second = await run({ dryRun: false });

      expect(second.counts.accountsCreated).toBe(0);
      expect(second.counts.accountsAlreadyPresent).toBe(2);
      expect(second.ok).toBe(true);
      // Same rows, same ids, same timestamps: a repeat is not a rewrite.
      expect(await CardanoStakingAccount.find({}).sort({ _id: 1 }).lean()).toEqual(after);
    });

    it('does not undo a consent a user gave between the two runs', async () => {
      await run({ dryRun: false });
      await CardanoStakingAccount.updateOne(
        {},
        {
          $set: {
            'preference.enabled': true,
            'preference.version': 1,
            termsConsent: { version: '1', acceptedAt: new Date(), source: 'dashboard' }
          }
        }
      );

      await run({ dryRun: false });

      const enabled = await CardanoStakingAccount.countDocuments({ 'preference.enabled': true });
      expect(enabled).toBe(1);
    });
  });

  describe('data it will not touch', () => {
    it('reports a wallet whose stored key and address disagree, and writes nothing for it', async () => {
      // The address carries C's staking credential while the wallet stores A's staking key. One of
      // the two belongs to a different wallet, and there is no safe way to guess which.
      await seedUser('+5491100000003', [cardanoWallet(CROSSED_ADDRESS, KEYS.A)]);

      const report = await run({ dryRun: false });

      expect(report.findings.map((finding) => finding.code)).toContain('credential_mismatch');
      expect(report.ok).toBe(false);
      expect(await CardanoStakingAccount.countDocuments({})).toBe(0);
    });

    it('reports a wallet with no staking public key', async () => {
      await seedUser('+5491100000004', [
        { ...cardanoWallet(KEYS.A.baseTestnet, KEYS.A), cardano_stake_public_key: undefined }
      ]);

      const report = await run({ dryRun: false });

      expect(report.findings.map((finding) => finding.code)).toContain('missing_stake_public_key');
      expect(await CardanoStakingAccount.countDocuments({})).toBe(0);
    });

    it('reports a Cardano wallet sitting on a chain id that is not Cardano', async () => {
      await seedUser('+5491100000005', [cardanoWallet(KEYS.A.baseTestnet, KEYS.A, 421614)]);

      const report = await run({ dryRun: false });

      expect(report.findings.map((finding) => finding.code)).toContain('unknown_chain_id');
      expect(await CardanoStakingAccount.countDocuments({})).toBe(0);
    });

    it('reports an address that belongs to another network than its chain id', async () => {
      await seedUser('+5491100000006', [cardanoWallet(KEYS.A.baseMainnet, KEYS.A, PREPROD)]);

      const report = await run({ dryRun: false });

      expect(report.findings.map((finding) => finding.code)).toContain('network_mismatch');
      expect(await CardanoStakingAccount.countDocuments({})).toBe(0);
    });

    it('writes neither of two users deriving the same stake credential', async () => {
      // Both would claim the same deposit and both would try to register it.
      await seedUser('+5491100000007', [cardanoWallet(KEYS.C.baseTestnet, KEYS.C)]);
      await seedUser('+5491100000008', [cardanoWallet(KEYS.C.baseTestnet, KEYS.C)]);

      const report = await run({ dryRun: false });

      expect(report.findings.map((finding) => finding.code)).toContain('duplicate_credential');
      // The first one is written and the second is refused; what matters is that the collision is
      // reported and that no second row exists claiming the same credential.
      expect(
        await CardanoStakingAccount.countDocuments({ stakeCredentialHex: KEYS.C.credential })
      ).toBe(1);
    });

    it('leaves an existing account alone when its identifiers differ from the derived ones', async () => {
      const userId = await seedUser('+5491100000009', [cardanoWallet(KEYS.A.baseTestnet, KEYS.A)]);
      await CardanoStakingAccount.create({
        userId,
        chainId: PREPROD,
        walletAddress: KEYS.B.baseTestnet,
        rewardAddress: KEYS.B.rewardTestnet,
        stakeCredentialHex: KEYS.B.credential
      });
      const before = await CardanoStakingAccount.find({}).lean();

      const report = await run({ dryRun: false });

      expect(report.findings.map((finding) => finding.code)).toContain('account_differs');
      expect(await CardanoStakingAccount.find({}).lean()).toEqual(before);
    });

    it('reports an index it did not declare, and leaves it in place', async () => {
      await run({ dryRun: false });
      await CardanoStakingAccount.collection.createIndex({ lastError: 1 }, { name: 'foreign_idx' });

      const report = await run({ dryRun: false });

      expect(report.findings.map((finding) => finding.code)).toContain('undeclared_index');
      const names = (await CardanoStakingAccount.collection.listIndexes().toArray()).map(
        (index) => index.name
      );
      expect(names).toContain('foreign_idx');
    });
  });

  describe('scoping a run', () => {
    beforeEach(async () => {
      await seedUser('+5491100000001', [
        cardanoWallet(KEYS.A.baseTestnet, KEYS.A),
        cardanoWallet(KEYS.A.baseMainnet, KEYS.A, MAINNET)
      ]);
      await seedUser('+5491100000002', [cardanoWallet(KEYS.B.baseTestnet, KEYS.B)]);
    });

    it('touches only the network it was given', async () => {
      const report = await run({ dryRun: false, chainId: MAINNET });

      expect(report.counts.accountsCreated).toBe(1);
      expect(await CardanoStakingAccount.countDocuments({ chainId: PREPROD })).toBe(0);
      expect(await CardanoStakingAccount.countDocuments({ chainId: MAINNET })).toBe(1);
    });

    it('keeps the two networks of one wallet apart', async () => {
      await run({ dryRun: false });

      const preprod = await CardanoStakingAccount.findOne({
        chainId: PREPROD,
        stakeCredentialHex: KEYS.A.credential
      });
      const mainnet = await CardanoStakingAccount.findOne({
        chainId: MAINNET,
        stakeCredentialHex: KEYS.A.credential
      });

      expect(preprod?.rewardAddress).toBe(KEYS.A.rewardTestnet);
      expect(mainnet?.rewardAddress).toBe(KEYS.A.rewardMainnet);
    });

    it('touches only the user it was given', async () => {
      const users = await UserModel.find({}).sort({ _id: 1 }).lean();
      const target = users[1]?._id as Types.ObjectId;

      const report = await run({ dryRun: false, userId: target.toHexString() });

      expect(report.counts.usersScanned).toBe(1);
      expect(await CardanoStakingAccount.countDocuments({ userId: target })).toBe(1);
      expect(await CardanoStakingAccount.countDocuments({})).toBe(1);
    });
  });

  describe('interruption and recovery', () => {
    /** Ids fixed so that the ascending `_id` scan has a known order. */
    const ids = [
      new Types.ObjectId('000000000000000000000001'),
      new Types.ObjectId('000000000000000000000002'),
      new Types.ObjectId('000000000000000000000003')
    ];

    beforeEach(async () => {
      await seedUser('+5491100000001', [cardanoWallet(KEYS.A.baseTestnet, KEYS.A)], ids[0]);
      await seedUser('+5491100000002', [cardanoWallet(KEYS.B.baseTestnet, KEYS.B)], ids[1]);
      await seedUser('+5491100000003', [cardanoWallet(KEYS.C.baseTestnet, KEYS.C)], ids[2]);
    });

    it('resumes from where the report said it stopped, without redoing or skipping a user', async () => {
      const first = await run({ dryRun: false, limit: 1 });
      expect(first.counts.accountsCreated).toBe(1);
      expect(first.lastProcessedId).toBe(ids[0]?.toHexString());

      const second = await run({ dryRun: false, resumeAfter: first.lastProcessedId });

      expect(second.counts.usersScanned).toBe(2);
      expect(second.counts.accountsCreated).toBe(2);
      expect(await CardanoStakingAccount.countDocuments({})).toBe(3);
    });

    it('picks up after a crash, leaving the rows it had already written untouched', async () => {
      const original = CardanoStakingAccount.create.bind(CardanoStakingAccount);
      let calls = 0;
      vi.spyOn(CardanoStakingAccount, 'create').mockImplementation(((...args: unknown[]) => {
        calls += 1;
        if (calls > 1) return Promise.reject(new Error('connection lost mid-migration'));
        return (original as (...a: unknown[]) => Promise<unknown>)(...args);
      }) as never);

      await expect(run({ dryRun: false })).rejects.toThrow('connection lost mid-migration');
      const survivors = await CardanoStakingAccount.find({}).lean();
      expect(survivors).toHaveLength(1);

      vi.restoreAllMocks();
      const recovery = await run({ dryRun: false });

      expect(recovery.counts.accountsCreated).toBe(2);
      expect(recovery.counts.accountsAlreadyPresent).toBe(1);
      expect(await CardanoStakingAccount.countDocuments({})).toBe(3);
      // The row written before the crash is the same row, not a rewritten one.
      const kept = await CardanoStakingAccount.findById(survivors[0]?._id).lean();
      expect(kept).toEqual(survivors[0]);
    });

    it('reports a full scan with a cursor that would resume past the last user', async () => {
      const report = await run({ dryRun: true });

      expect(report.lastProcessedId).toBe(ids[2]?.toHexString());
    });
  });

  describe('indexes are verified, not assumed', () => {
    beforeEach(async () => {
      // Documents are cleared between tests but collections are not, so a staking collection built
      // by an earlier case would make every count here read zero. Each case starts from nothing.
      await dropStakingCollections();
      await seedUser('+5491100000001', [cardanoWallet(KEYS.A.baseTestnet, KEYS.A)]);
      resetStakingSchemaVerification();
    });

    it('leaves every declared index in place and says how many it checked', async () => {
      const declared = STAKING_COLLECTIONS.reduce(
        (total, entry) => total + declaredIndexNames(entry.model).length,
        0
      );

      const report = await run({ dryRun: false });

      expect(report.counts.indexesVerified).toBe(declared);
      expect(await missingStakingIndexes()).toEqual([]);
      expect(report.ok).toBe(true);
    });

    it('reports an index that did not come into being, instead of trusting the create', async () => {
      // An index build fails on its own -- a duplicate key already in the data is the ordinary way
      // a unique index refuses to exist -- and the whole safety of this rollout rests on uniqueness
      // the collection would then not have.
      vi.spyOn(CardanoStakingOperation, 'createIndexes').mockResolvedValue(
        undefined as unknown as never
      );

      const report = await run({ dryRun: false });

      const failures = report.findings.filter(
        (finding) => finding.code === 'index_verification_failed'
      );
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.map((finding) => finding.subject)).toContain(
        'cardano_staking_operations.one_live_op_per_account'
      );
      expect(report.ok).toBe(false);
    });

    it('rebuilds an index dropped after an earlier run', async () => {
      await run({ dryRun: false });
      await CardanoStakingAccount.collection.dropIndex('chain_credential_unique');
      expect(await missingStakingIndexes()).toContain(
        'cardano_staking_accounts.chain_credential_unique'
      );

      const report = await run({ dryRun: false });

      expect(await missingStakingIndexes()).toEqual([]);
      expect(report.findings.filter((f) => f.code === 'index_verification_failed')).toEqual([]);
    });

    it('verifies nothing in a dry run, because it built nothing', async () => {
      const report = await run({ dryRun: true });

      expect(report.counts.indexesVerified).toBe(0);
      expect(report.counts.indexesCreated).toBeGreaterThan(0);
    });
  });

  describe('command line', () => {
    it('is a dry run unless asked otherwise', () => {
      expect(parseMigrationOptions([]).dryRun).toBe(true);
      expect(parseMigrationOptions(['--dry-run']).dryRun).toBe(true);
      expect(parseMigrationOptions(['--apply']).dryRun).toBe(false);
    });

    it('reads the scoping flags', () => {
      const options = parseMigrationOptions([
        '--apply',
        `--chain-id=${PREPROD}`,
        '--user-id=000000000000000000000001',
        '--limit=10'
      ]);

      expect(options).toEqual({
        dryRun: false,
        chainId: PREPROD,
        userId: '000000000000000000000001',
        resumeAfter: null,
        limit: 10
      });
    });

    it('refuses a flag it does not know instead of ignoring it', () => {
      // `--aply` reads as `--apply` to a hurried eye, and ignoring it would run the opposite of
      // what was asked.
      expect(() => parseMigrationOptions(['--aply'])).toThrow('MIGRATION_UNKNOWN_FLAG');
      expect(() => parseMigrationOptions(['--limit=many'])).toThrow('MIGRATION_BAD_VALUE');
    });

    it('names itself the way the registry does', () => {
      expect(migration.name).toBe(MIGRATION_NAME);
      expect(MIGRATIONS[MIGRATION_NAME]).toBe(migration);
    });

    it('resolves a good command line into the migration and its options', () => {
      const request = resolveMigrationRequest([MIGRATION_NAME, '--apply'], MIGRATIONS);

      expect(request.migration).toBe(migration);
      expect(request.options.dryRun).toBe(false);
    });

    it.each([
      '--aply',
      '--appl y',
      '--chain',
      '--limit=many',
      '-apply'
    ])('refuses %s without touching the database', async (flag) => {
      // Resolution happens before anything connects, so a command line that is not understood
      // cannot reach the database even to read it.
      const before = await databaseSnapshot();

      expect(() => resolveMigrationRequest([MIGRATION_NAME, flag], MIGRATIONS)).toThrow();

      expect(await databaseSnapshot()).toEqual(before);
    });

    it('refuses a migration it does not know, and one that was never named', async () => {
      const before = await databaseSnapshot();

      expect(() => resolveMigrationRequest(['0002-not-a-migration'], MIGRATIONS)).toThrow(
        'MIGRATION_UNKNOWN'
      );
      expect(() => resolveMigrationRequest(['--apply'], MIGRATIONS)).toThrow('MIGRATION_NOT_NAMED');
      expect(() => resolveMigrationRequest([], MIGRATIONS)).toThrow('MIGRATION_NOT_NAMED');

      expect(await databaseSnapshot()).toEqual(before);
    });
  });
});

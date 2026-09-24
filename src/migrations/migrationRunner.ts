/**
 * The shared shape of a migration and the harness that runs one.
 *
 * There was no migration mechanism in this repository before this file. What is here is the minimum
 * that the Cardano staking rollout needs, and the conventions it fixes are in `README.md` next to
 * it. Three of them are load-bearing:
 *
 * - **A migration never runs at boot.** It is its own process, started by hand. A schema change that
 *   rides along with a container start happens once per instance, at the worst possible moment, and
 *   with no way to inspect it first.
 * - **`--dry-run` writes nothing at all.** Not documents, not collections, not indexes, not a record
 *   that it ran. That is why {@link MigrationWriter} exists: in a dry run the migration is handed a
 *   writer that records intentions and performs none of them, so "wrote nothing" is a property of
 *   the object it was given rather than a promise about its branches.
 * - **A migration reports rather than repairs.** Data it did not expect is described in
 *   {@link MigrationReport.findings} and left exactly as it was found. Overwriting something
 *   unexpected is how a migration turns a detectable inconsistency into a silent one.
 */

import mongoose, { type Model } from 'mongoose';
import { MONGO_URI, NODE_ENV } from '../config/constants';
import { connectToDatabase } from '../config/database';

/** How a migration was asked to run. */
export interface MigrationOptions {
  /** Report what would happen and touch nothing. */
  dryRun: boolean;
  /** Restrict the run to one network. Absent means every configured network. */
  chainId: number | null;
  /** Restrict the run to one user, for re-checking a single case. */
  userId: string | null;
  /** Resume a scan past this `_id`. See {@link MigrationReport.lastProcessedId}. */
  resumeAfter: string | null;
  /** Stop after this many subjects. Absent means all of them. */
  limit: number | null;
  /**
   * The database the caller says they mean.
   *
   * Required by {@link runMigration} for a write, and compared with the database the connection
   * string actually resolves to. See {@link requireConfirmedTarget}.
   */
  confirmDatabase: string | null;
}

/** Something the migration found and deliberately did not touch. */
export interface MigrationFinding {
  /** Stable machine-readable reason, so a report can be diffed between runs. */
  code: string;
  /** What the finding is about: a user id, a wallet address, an index name. */
  subject: string;
  detail: string;
}

export interface MigrationReport {
  name: string;
  dryRun: boolean;
  /** What a dry run would do, or what a real run did. One line per effect. */
  effects: string[];
  findings: MigrationFinding[];
  /** Counters the migration keeps, printed as-is. */
  counts: Record<string, number>;
  /**
   * Highest `_id` the scan reached.
   *
   * This is what makes a long run resumable without writing a checkpoint anywhere: an interrupted
   * run is continued with `--resume-after <id>`. Keeping the cursor out of the database is also
   * what lets a dry run stay free of any trace at all.
   */
  lastProcessedId: string | null;
  /** False when there are findings, so a caller can key off the exit code alone. */
  ok: boolean;
}

/**
 * Where a migration's writes go.
 *
 * The real implementation performs them; the dry-run one records the same sentences and performs
 * nothing. A migration holds no other route to the database for writing.
 */
export interface MigrationWriter {
  readonly dryRun: boolean;
  /** Effects performed, or that would have been performed. */
  readonly effects: string[];
  /**
   * Creates the indexes a model declares.
   *
   * Only ever creates. Indexes present on the collection that the schema does not declare are
   * reported by the migration and left in place: dropping an index a migration does not recognise
   * is how a query that nothing in this repository issues loses its support in production.
   *
   * @param model - Model whose declared indexes to build.
   * @param description - Line for the report.
   */
  createIndexes(model: Model<never>, description: string): Promise<void>;
  /**
   * Inserts one document.
   *
   * @param model - Model to insert into.
   * @param doc - Document to insert.
   * @param description - Line for the report.
   * @returns `'inserted'`, or `'duplicate'` when a unique index already held an equivalent row —
   *   which is the normal outcome of a second run and of two instances racing.
   */
  insert<T>(
    model: Model<T>,
    doc: Record<string, unknown>,
    description: string
  ): Promise<'inserted' | 'duplicate'>;
}

/** Mongo's duplicate-key error code. */
const DUPLICATE_KEY = 11000;

/** A writer that records what it was asked to do and does none of it. */
class DryRunWriter implements MigrationWriter {
  readonly dryRun = true;

  readonly effects: string[] = [];

  /**
   * Records an index build.
   *
   * @param _model - Ignored: a dry run does not reach the collection.
   * @param description - Line for the report.
   */
  async createIndexes(_model: Model<never>, description: string): Promise<void> {
    this.effects.push(`would create indexes: ${description}`);
  }

  /**
   * Records an insert.
   *
   * @param _model - Ignored.
   * @param _doc - Ignored.
   * @param description - Line for the report.
   * @returns Always `'inserted'`: nothing exists to collide with in a run that writes nothing.
   */
  async insert<T>(
    _model: Model<T>,
    _doc: Record<string, unknown>,
    description: string
  ): Promise<'inserted' | 'duplicate'> {
    this.effects.push(`would insert: ${description}`);
    return 'inserted';
  }
}

/** A writer that performs what it is asked. */
class LiveWriter implements MigrationWriter {
  readonly dryRun = false;

  readonly effects: string[] = [];

  /**
   * Builds the model's declared indexes.
   *
   * @param model - Model whose declared indexes to build.
   * @param description - Line for the report.
   */
  async createIndexes(model: Model<never>, description: string): Promise<void> {
    await model.createIndexes();
    this.effects.push(`created indexes: ${description}`);
  }

  /**
   * Inserts one document, treating a duplicate key as the expected result of a repeat.
   *
   * @param model - Model to insert into.
   * @param doc - Document to insert.
   * @param description - Line for the report.
   * @returns Whether the row was created by this call.
   */
  async insert<T>(
    model: Model<T>,
    doc: Record<string, unknown>,
    description: string
  ): Promise<'inserted' | 'duplicate'> {
    try {
      await model.create(doc);
      this.effects.push(`inserted: ${description}`);
      return 'inserted';
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY) {
        this.effects.push(`already present: ${description}`);
        return 'duplicate';
      }
      throw error;
    }
  }
}

/**
 * Builds the writer a run should use.
 *
 * @param dryRun - Whether the run may touch the database.
 * @returns The writer to hand the migration.
 */
export function createMigrationWriter(dryRun: boolean): MigrationWriter {
  return dryRun ? new DryRunWriter() : new LiveWriter();
}

export interface Migration {
  /** Ordered, unique, and never reused: `NNNN-kebab-case`. */
  name: string;
  /**
   * Performs the migration.
   *
   * @param options - How the run was invoked.
   * @param writer - The only route to writing. A dry run gets one that performs nothing.
   * @returns What happened, or would have.
   */
  run(options: MigrationOptions, writer: MigrationWriter): Promise<MigrationReport>;
}

/**
 * Reads command-line arguments into options.
 *
 * `--dry-run` defaults to **on**. A migration that needs no flag to start writing is one flag away
 * from being run by accident against the wrong database; making the safe mode the default inverts
 * that, and `--apply` is the deliberate act.
 *
 * @param argv - Arguments, without the interpreter and script path.
 * @returns The options, with every unrecognised flag refused rather than ignored.
 * @throws Error when a flag is unknown or a numeric value is not a number.
 */
export function parseMigrationOptions(argv: readonly string[]): MigrationOptions {
  const options: MigrationOptions = {
    dryRun: true,
    chainId: null,
    userId: null,
    resumeAfter: null,
    limit: null,
    confirmDatabase: null
  };

  const number = (flag: string, raw: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`MIGRATION_BAD_VALUE: ${flag}=${raw}`);
    }
    return value;
  };

  for (const arg of argv) {
    const [flag, ...rest] = arg.split('=');
    const raw = rest.join('=');

    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--apply') options.dryRun = false;
    else if (flag === '--chain-id') options.chainId = number(flag, raw);
    else if (flag === '--user-id') options.userId = raw;
    else if (flag === '--resume-after') options.resumeAfter = raw;
    else if (flag === '--limit') options.limit = number(flag, raw);
    else if (flag === '--confirm-database') options.confirmDatabase = raw;
    // Silently ignoring a misspelled flag would run a different migration than the one asked for,
    // and `--aply` reads as `--apply` to a hurried eye.
    else throw new Error(`MIGRATION_UNKNOWN_FLAG: ${arg}`);
  }

  return options;
}

/** A resolved command line: which migration, and how to run it. */
export interface MigrationRequest {
  migration: Migration;
  options: MigrationOptions;
}

/**
 * Turns a command line into a migration and its options.
 *
 * Pure, and deliberately separate from running one. Everything that can be rejected about an
 * invocation -- an unknown migration, a misspelled flag, a non-numeric limit -- is rejected here,
 * before anything opens a connection. A command line that does not resolve therefore cannot reach
 * the database at all, which is a stronger statement than "the flag is validated".
 *
 * @param argv - Arguments, without the interpreter and script path.
 * @param registry - The migrations this repository knows how to run.
 * @returns The migration and the options it was asked for.
 * @throws Error `MIGRATION_NOT_NAMED`, `MIGRATION_UNKNOWN`, or whatever
 *   {@link parseMigrationOptions} refuses.
 */
export function resolveMigrationRequest(
  argv: readonly string[],
  registry: Readonly<Record<string, Migration>>
): MigrationRequest {
  const [name, ...flags] = argv;

  if (name === undefined || name.startsWith('--')) throw new Error('MIGRATION_NOT_NAMED');

  const migration = registry[name];
  if (migration === undefined) throw new Error(`MIGRATION_UNKNOWN: ${name}`);

  return { migration, options: parseMigrationOptions(flags) };
}

/**
 * Renders a report for a terminal.
 *
 * @param report - The report to render.
 * @returns The lines to print.
 */
export function formatMigrationReport(report: MigrationReport): string {
  const lines = [
    `migration: ${report.name}`,
    // The target is printed first and always. A report that does not say which database it
    // is about is a report that reads as a success wherever it landed.
    `environment: ${NODE_ENV || '(unset)'}`,
    `host:      ${databaseHost(MONGO_URI ?? '')}`,
    `database:  ${databaseName(MONGO_URI ?? '')}`,
    `mode:      ${report.dryRun ? 'DRY RUN (nothing written)' : 'APPLY'}`,
    ''
  ];

  for (const [key, value] of Object.entries(report.counts)) lines.push(`  ${key}: ${value}`);
  lines.push('');

  for (const effect of report.effects) lines.push(`  - ${effect}`);

  if (report.findings.length > 0) {
    lines.push('', `findings (${report.findings.length}) — nothing was changed for any of these:`);
    for (const finding of report.findings) {
      lines.push(`  ! ${finding.code}  ${finding.subject}  ${finding.detail}`);
    }
  }

  if (report.lastProcessedId !== null) {
    lines.push('', `resume with: --resume-after=${report.lastProcessedId}`);
  }

  lines.push('', report.ok ? 'result: ok' : 'result: finished with findings');
  return lines.join('\n');
}

/**
 * Connects, runs one migration, and disconnects.
 *
 * `autoIndex` and `autoCreate` are turned off for the process before anything connects. Mongoose
 * builds a model's indexes on first use by default, which in a dry run would be a write — and one
 * nothing in the migration asked for.
 *
 * @param migration - The migration to run.
 * @param options - How to run it.
 * @returns The report, so a caller can decide the exit code.
 */
export async function runMigration(
  migration: Migration,
  options: MigrationOptions
): Promise<MigrationReport> {
  requireExplicitDatabase();
  if (!options.dryRun) requireConfirmedTarget(options.confirmDatabase);
  await connectToDatabase();
  try {
    return await runMigrationOnConnection(migration, options);
  } finally {
    await mongoose.disconnect();
  }
}

/**
 * Refuses to run unless the database was named explicitly.
 *
 * The application falls back to a default connection string when `MONGO_URI` is absent, which is
 * reasonable for a server: it comes up against a local database and somebody notices. It is not
 * reasonable here. A migration inherits that fallback and writes to a *different database from the
 * one it was meant for*, and every safeguard this module has is aimed at the wrong target: the dry
 * run reports what would happen there, the apply happens there, and the report reads as a success.
 *
 * This is not hypothetical. It happened: a run intended for `chatterpay-dev` created eight
 * collections in `chatterpay`, and nothing in the output said so, because nothing in the output
 * said which database was being talked to at all.
 *
 * So the fallback is refused rather than accepted, and {@link databaseName} puts the target in the
 * report where it cannot be missed.
 *
 * @throws Error `MIGRATION_NO_DATABASE_CONFIGURED` when nothing names a database.
 */
function requireExplicitDatabase(): void {
  if (!MONGO_URI || MONGO_URI.trim() === '') {
    throw new Error(
      'MIGRATION_NO_DATABASE_CONFIGURED: MONGO_URI is not set. A migration will not fall back to a default database — name the one you mean.'
    );
  }
}

/**
 * The database a connection string names, for the report.
 *
 * @param uri - The connection string.
 * @returns The database name, or a marker when the string does not carry one. A connection string
 *   with no database is another way to end up somewhere unintended, so it is shown rather than
 *   resolved.
 */
export function databaseName(uri: string): string {
  try {
    const path = new URL(uri.replace(/^mongodb\+srv:/, 'mongodb:')).pathname.replace(/^\//, '');
    return path === '' ? '(none in URI — server default)' : decodeURIComponent(path);
  } catch {
    return '(unreadable URI)';
  }
}

/**
 * The server a connection string points at, with its credentials removed.
 *
 * Host and database are two separate ways to end up somewhere unintended, and a report that names
 * only the database reads identically whether it is talking to a container on this laptop or to a
 * managed cluster. Both are printed, so the line that says what happened also says where.
 *
 * The username and password are stripped rather than masked. This string is printed to a terminal,
 * pasted into tickets and scrolled past in CI logs, and a migration report is not a place any part
 * of a credential belongs — not even the username, which names the account that holds the rights.
 *
 * @param uri - The connection string.
 * @returns `host:port`, or a marker when the string cannot be read.
 */
export function databaseHost(uri: string): string {
  try {
    const parsed = new URL(uri.replace(/^mongodb\+srv:/, 'mongodb:'));
    return parsed.host === '' ? '(none in URI)' : parsed.host;
  } catch {
    return '(unreadable URI)';
  }
}

/**
 * Refuses to write until the caller has named the database they mean.
 *
 * `requireExplicitDatabase` catches the absent setting. This catches the one that is present and
 * wrong — a shell with the previous environment still loaded, a `.env` that resolves differently
 * than the operator expects, a copied command line from another deployment. In all of those the
 * connection string is set, the run succeeds, and the only thing that was ever wrong was an
 * assumption nobody was asked to state.
 *
 * So a write states it. `--confirm-database` is compared against what the connection string
 * actually resolves to, and a mismatch stops the run before it connects. Reading is untouched: a
 * dry run writes nothing, and making it ceremonial would only discourage the inspection that is
 * supposed to happen first.
 *
 * @param confirmed - What the caller said the target is.
 * @throws Error `MIGRATION_TARGET_UNCONFIRMED` when nothing was named, and
 *   `MIGRATION_TARGET_MISMATCH` when what was named is not where the run would land.
 */
function requireConfirmedTarget(confirmed: string | null): void {
  const actual = databaseName(MONGO_URI ?? '');

  if (confirmed === null || confirmed.trim() === '') {
    throw new Error(
      `MIGRATION_TARGET_UNCONFIRMED: this would write to "${actual}" on ${databaseHost(MONGO_URI ?? '')}. ` +
        `Re-run with --confirm-database=${actual} if that is the database you mean.`
    );
  }

  if (confirmed.trim() !== actual) {
    throw new Error(
      `MIGRATION_TARGET_MISMATCH: --confirm-database=${confirmed.trim()} but the connection string resolves to "${actual}". Nothing was written.`
    );
  }
}

/**
 * Runs one migration on a connection someone else opened and closes.
 *
 * Split out so that the guarantees a run makes -- chief among them that a dry run writes nothing --
 * are exercised by the same function the command line uses, rather than by a copy of it that the
 * tests keep in step by hand.
 *
 * @param migration - The migration to run.
 * @param options - How to run it.
 * @returns The report.
 */
export async function runMigrationOnConnection(
  migration: Migration,
  options: MigrationOptions
): Promise<MigrationReport> {
  // Set on the connection as well as globally. Mongoose initialises a model lazily, on its first
  // operation, and that initialisation reads the *connection's* configuration -- which was fixed
  // when the connection opened, so the global setting alone can arrive too late. A migration that
  // merely reads would then create the collection it was reading.
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  mongoose.connection.config.autoIndex = false;
  mongoose.connection.config.autoCreate = false;

  const writer = createMigrationWriter(options.dryRun);
  return migration.run(options, writer);
}

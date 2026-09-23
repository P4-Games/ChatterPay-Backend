/**
 * Entry point for running a migration by hand.
 *
 * Nothing imports this from the application. It is started on its own, against a database whose
 * backup has already been taken and restored once somewhere else — see `README.md` next to this
 * file for the procedure and for what a rollback of a migration is allowed to touch.
 *
 *     bun run src/migrations/cli.ts 0001-cardano-staking-bootstrap
 *     bun run src/migrations/cli.ts 0001-cardano-staking-bootstrap --apply
 *
 * Without `--apply` it is a dry run and writes nothing at all.
 */

import migration0001, { MIGRATION_NAME as NAME_0001 } from './0001-cardano-staking-bootstrap';
import {
  formatMigrationReport,
  type Migration,
  parseMigrationOptions,
  runMigration
} from './migrationRunner';

/** Every migration this repository knows how to run, by name. */
export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  [NAME_0001]: migration0001
};

/**
 * Parses the command line, runs the named migration and prints its report.
 *
 * @returns The process exit code: non-zero when the migration reported findings, so that a run
 *   whose report nobody reads still fails the step that started it.
 */
async function main(): Promise<number> {
  const [name, ...flags] = process.argv.slice(2);

  if (name === undefined || name.startsWith('--')) {
    console.error(`usage: bun run src/migrations/cli.ts <migration> [--apply] [--chain-id=<id>]`);
    console.error(`migrations: ${Object.keys(MIGRATIONS).join(', ')}`);
    return 2;
  }

  const migration = MIGRATIONS[name];
  if (migration === undefined) {
    console.error(`unknown migration: ${name}`);
    console.error(`migrations: ${Object.keys(MIGRATIONS).join(', ')}`);
    return 2;
  }

  const options = parseMigrationOptions(flags);
  const report = await runMigration(migration, options);
  console.log(formatMigrationReport(report));
  return report.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error(error);
    process.exit(2);
  });

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

import {
  formatMigrationReport,
  type MigrationRequest,
  resolveMigrationRequest,
  runMigration
} from './migrationRunner';
import { MIGRATIONS } from './registry';

/**
 * Parses the command line, runs the named migration and prints its report.
 *
 * @returns The process exit code: non-zero when the migration reported findings, so that a run
 *   whose report nobody reads still fails the step that started it.
 */
async function main(): Promise<number> {
  // Resolution first, and nothing else until it succeeds. `--aply` is a typo for `--apply`, and a
  // command line that is not understood must not reach the database even to read it.
  let request: MigrationRequest;
  try {
    request = resolveMigrationRequest(process.argv.slice(2), MIGRATIONS);
  } catch (error) {
    console.error((error as Error).message);
    console.error(`usage: bun run src/migrations/cli.ts <migration> [--apply] [--chain-id=<id>]`);
    console.error(`migrations: ${Object.keys(MIGRATIONS).join(', ')}`);
    return 2;
  }

  const report = await runMigration(request.migration, request.options);
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

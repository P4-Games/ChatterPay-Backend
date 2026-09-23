/**
 * Every migration this repository knows how to run, by name.
 *
 * Separate from `cli.ts` because that module runs a migration as a side effect of being imported:
 * anything that only needs to know *which* migrations exist — a test, a future admin endpoint —
 * would otherwise start one by asking.
 */

import migration0001, { MIGRATION_NAME as NAME_0001 } from './0001-cardano-staking-bootstrap';
import type { Migration } from './migrationRunner';

export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  [NAME_0001]: migration0001
};

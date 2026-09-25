import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The environment variables staking no longer reads.
 *
 * Each of these became a field of `blockchains.staking`. A consumer left behind would not
 * fail to compile — it would read an empty string and quietly apply a default, which is exactly the
 * second source of truth this change removed. So the check is on the source text.
 */
const RETIRED = [
  'CARDANO_STAKING_ENABLED',
  'CARDANO_STAKING_MIN_ENROLMENT_ADA',
  'CARDANO_STAKING_DEFAULT_POOL_ID',
  'CARDANO_STAKING_TERMS_VERSION',
  'CARDANO_STAKING_CONSENT_REQUIRED',
  'CARDANO_STAKING_FEE_DAILY_CAP_ADA',
  'CARDANO_STAKING_DREP_OWN_ENABLED',
  'CARDANO_STAKING_ENROLMENT_ALLOWLIST',
  'CARDANO_STAKING_MAX_SPONSORED_REGISTRATIONS',
  'CARDANO_STAKING_SPONSOR_WINDOW_DAYS',
  'CARDANO_STAKING_SYNC_BATCH_LIMIT',
  'CARDANO_STAKING_SYNC_EXECUTE',
  // Not a setting that moved: a switch that turned the BFF assertion off. Every deployment has the
  // secret provisioned, so the only thing it could still do was weaken the check that proves a
  // mutation came from a route that authenticated somebody.
  'CARDANO_STAKING_ASSERTION_REQUIRED'
] as const;

/**
 * What stays in the environment, and why it cannot move.
 *
 * Secrets. A credential in `blockchains` is readable by anything with read access to the database
 * and travels in every dump of it; these verify callers, so they live where secrets live.
 */
const KEPT = ['CARDANO_STAKING_SYNC_SECRET', 'CARDANO_STAKING_FRONTEND_BFF_SECRET'] as const;

/**
 * Every TypeScript file under a directory.
 *
 * @param directory - Where to start.
 * @returns The absolute paths.
 */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const SOURCES = sourceFiles(join(process.cwd(), 'src')).map((path) => ({
  path,
  text: readFileSync(path, 'utf8')
}));

describe('the retired staking environment variables', () => {
  it.each(RETIRED)('%s is read nowhere in src', (name) => {
    const users = SOURCES.filter((file) => file.text.includes(name)).map((file) => file.path);

    expect(users).toEqual([]);
  });

  it.each(KEPT)('%s is still available, because it is a secret', (name) => {
    const constants = SOURCES.find((file) => file.path.endsWith(join('config', 'constants.ts')));

    expect(constants?.text).toContain(name);
  });
});

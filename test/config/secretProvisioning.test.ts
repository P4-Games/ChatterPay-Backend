import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Where the staking credentials are allowed to exist.
 *
 * `CARDANO_STAKING_SYNC_SECRET` is the whole authorisation in front of an endpoint that starts
 * transactions, and `CARDANO_STAKING_BFF_SECRET` signs the assertion that says which session a
 * mutation came from. Both are set on the Cloud Run service, from Secret Manager, and reach the
 * process at run time only.
 *
 * This is asserted here rather than left to a comment because it is a property that breaks silently
 * and usefully. Adding a variable to the Dockerfile is the ordinary way to make a new setting reach
 * the container, it works, and nothing about the result looks wrong — except that the value is now
 * baked into a layer in the registry, where it outlives every rotation and is readable by anybody
 * who can pull the image. The same applies to Cloud Build: routing a credential through it puts the
 * value in the `.env` that `CreateEnv` writes and in the build's own logs and caches.
 *
 * Neither is needed while the application is built. A credential only the running service reads
 * should exist only where the service runs.
 *
 * Mentions inside comments are fine and expected: the files explain why the variables are missing,
 * and that explanation is what keeps somebody from helpfully adding them back.
 */

/** The credentials that must never travel through a build. */
const RUNTIME_ONLY = ['CARDANO_STAKING_SYNC_SECRET', 'CARDANO_STAKING_BFF_SECRET'];

/** The staking settings that are configuration rather than credentials, and do travel normally. */
const BUILD_TIME_SETTINGS = [
  'CARDANO_STAKING_ENABLED',
  'CARDANO_STAKING_MIN_ENROLMENT_ADA',
  'CARDANO_STAKING_DEFAULT_POOL_ID',
  'CARDANO_STAKING_TERMS_VERSION',
  'CARDANO_STAKING_FEE_DAILY_CAP_ADA',
  'CARDANO_STAKING_DREP_OWN_ENABLED',
  'CARDANO_STAKING_ENROLMENT_ALLOWLIST',
  'CARDANO_STAKING_SYNC_BATCH_LIMIT',
  'CARDANO_STAKING_SYNC_EXECUTE',
  'CARDANO_STAKING_ASSERTION_REQUIRED'
];

/**
 * Reads a file from the repository root.
 *
 * @param name - Path relative to the root.
 * @returns Its contents.
 */
function repoFile(name: string): string {
  return readFileSync(join(__dirname, '..', '..', name), 'utf8');
}

/**
 * The lines of a file that are not comments.
 *
 * @param text - The file.
 * @param commentPrefix - What starts a comment in this file.
 * @returns The lines that carry instructions rather than prose.
 */
function instructionLines(text: string, commentPrefix: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trim().startsWith(commentPrefix));
}

describe('the staking credentials reach the process at run time only', () => {
  it.each(RUNTIME_ONLY)('%s is not an ARG or ENV in the Dockerfile', (name) => {
    const lines = instructionLines(repoFile('Dockerfile'), '#');

    expect(lines.filter((line) => line.includes(name))).toEqual([]);
  });

  it.each(RUNTIME_ONLY)('%s does not travel through Cloud Build', (name) => {
    // Covers all four ways it could: the two `secretEnv` lists, `availableSecrets`, the substitution
    // block and the bash guard that assembles build arguments.
    const lines = instructionLines(repoFile('cloudbuild.yaml'), '#');

    expect(lines.filter((line) => line.includes(name))).toEqual([]);
  });

  it.each(RUNTIME_ONLY)('%s is not passed as a build argument locally either', (name) => {
    const lines = instructionLines(repoFile('scripts/docker-build.sh'), '#');

    expect(lines.filter((line) => line.includes(name))).toEqual([]);
  });

  it.each(RUNTIME_ONLY)('%s is still documented in example_env', (name) => {
    // Absent from the build is not the same as undocumented. Somebody configuring a deployment has
    // to be told the variable exists, and what happens when it does not.
    expect(repoFile('example_env')).toContain(name);
  });
});

describe('the staking settings that are configuration', () => {
  it.each(BUILD_TIME_SETTINGS)('%s is declared in the Dockerfile', (name) => {
    // The other half of the rule. These are not credentials, they belong in the image like every
    // other setting, and a missing one is a deployment that silently runs on a default.
    const text = repoFile('Dockerfile');

    expect(text).toContain(`ARG ${name}\n`);
    expect(text).toContain(`ENV ${name} $${name}\n`);
  });

  it.each(BUILD_TIME_SETTINGS)('%s is passed by Cloud Build', (name) => {
    expect(repoFile('cloudbuild.yaml')).toContain(`- ${name}=\${_${name}}`);
  });

  it.each(BUILD_TIME_SETTINGS)('%s has a default so an unaware trigger still builds', (name) => {
    // Cloud Build fails on a substitution the trigger does not define, so a variable added here
    // without a default would break every deployment until somebody edited the trigger.
    expect(repoFile('cloudbuild.yaml')).toMatch(new RegExp(`^\\s+_${name}:`, 'm'));
  });

  it.each(BUILD_TIME_SETTINGS)('%s is passed by the local build script', (name) => {
    expect(repoFile('scripts/docker-build.sh')).toContain(`--build-arg ${name}=`);
  });

  it.each(BUILD_TIME_SETTINGS)('%s is documented in example_env', (name) => {
    expect(repoFile('example_env')).toContain(name);
  });
});

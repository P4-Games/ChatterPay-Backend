import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Provisioning rules for the two staking credentials, asserted rather than left to review.
 *
 * Both are provisioned on the Cloud Run service. The build declares their names and must not
 * pass their values, which depends on one entry in a list inside a bash line — something an edit
 * drops without any symptom.
 */

/** The credentials whose values must never be passed into the image. */
const RUNTIME_ONLY = ['CARDANO_STAKING_SYNC_SECRET', 'CARDANO_STAKING_FRONTEND_BFF_SECRET'];

/**
 * Settings that used to travel through the build and no longer exist.
 *
 * Every one of them became a field of the network's own `blockchains` document. They are listed
 * here so that adding one back — to the Dockerfile, to Cloud Build, or to the local build script —
 * fails instead of quietly reintroducing a second source of truth that the code no longer reads.
 */
const RETIRED_SETTINGS = [
  'CARDANO_NETWORK',
  'CARDANO_CHAIN_ID',
  'CARDANO_PROVIDER_URL',
  'CARDANO_TTL_SLOTS',
  'CARDANO_DEPOSIT_CONFIRMATIONS',
  'CARDANO_EXPLORER_URL',
  'CARDANO_STAKING_ENABLED',
  'CARDANO_STAKING_MIN_ENROLMENT_ADA',
  'CARDANO_STAKING_DEFAULT_POOL_ID',
  'CARDANO_STAKING_TERMS_VERSION',
  'CARDANO_STAKING_CONSENT_REQUIRED',
  'CARDANO_STAKING_FEE_DAILY_CAP_ADA',
  'CARDANO_STAKING_DREP_OWN_ENABLED',
  'CARDANO_STAKING_ENROLMENT_ALLOWLIST',
  'CARDANO_STAKING_SYNC_BATCH_LIMIT',
  'CARDANO_STAKING_SYNC_EXECUTE',
  'CARDANO_STAKING_ASSERTION_REQUIRED',
  'CARDANO_STAKING_MAX_SPONSORED_REGISTRATIONS',
  'CARDANO_STAKING_SPONSOR_WINDOW_DAYS'
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

/**
 * The names the Build step refuses to turn into a `--build-arg`.
 *
 * Read out of the bash line itself rather than restated here, so the assertion fails when the list
 * changes and not when somebody reformats around it.
 *
 * @returns The excluded names.
 */
function buildArgExclusions(): string[] {
  const line = instructionLines(repoFile('cloudbuild.yaml'), '#').find((candidate) =>
    candidate.includes("secrets='")
  );
  if (line === undefined) throw new Error('the Build step no longer declares a skip list');
  return (/secrets='([^']*)'/.exec(line)?.[1] ?? '').trim().split(/\s+/);
}

describe('the staking credentials never reach a layer of the image', () => {
  it.each(RUNTIME_ONLY)('%s is excluded from the build arguments', (name) => {
    // The assertion the rest of this file depends on.
    expect(buildArgExclusions()).toContain(name);
  });

  it.each(
    RUNTIME_ONLY
  )('%s is declared in the Dockerfile, which is why the above matters', (name) => {
    // A premise, not a requirement: if this stops holding, the exclusion above protects nothing
    // and this file has to be revisited rather than silently kept.
    const lines = instructionLines(repoFile('Dockerfile'), '#');

    expect(lines.filter((line) => line.startsWith(`ARG ${name}`))).toHaveLength(1);
  });

  it.each(RUNTIME_ONLY)('%s is not passed as a build argument locally either', (name) => {
    // The local script spells its `--build-arg` list out and has no exclusion to fall back on.
    const lines = instructionLines(repoFile('scripts/docker-build.sh'), '#');

    expect(lines.filter((line) => line.includes(name))).toEqual([]);
  });

  it.each(RUNTIME_ONLY)('%s is still documented in example_env', (name) => {
    // Absent from the build arguments is not the same as undocumented. Somebody configuring a
    // deployment has to be told the variable exists, and what happens when it does not.
    expect(repoFile('example_env')).toContain(name);
  });

  it('keeps excluding the credentials that were already excluded', () => {
    // The list is shared with the rest of the project. A change for these two must not drop one of
    // the others on the way through.
    expect(buildArgExclusions()).toEqual(
      expect.arrayContaining([
        'SEED_INTERNAL_SALT_EVM',
        'SEED_INTERNAL_SALT_CAR',
        'SIGNING_KEY',
        'SECURITY_PIN_HMAC_KEY',
        'CARDANO_PROVIDER_API_KEY'
      ])
    );
  });
});

describe('what the staking screen is told about the configuration', () => {
  /** The module that builds the payload the dashboard reads. */
  const view = repoFile('src/services/cardano/cardanoStakingUserService.ts');

  it.each(RUNTIME_ONLY)('does not carry %s', (name) => {
    // The payload crosses to a browser. A credential named in the module that builds it is one
    // rename away from being sent, and the two here are the ones that would matter.
    expect(view.includes(name)).toBe(false);
  });

  it('carries whether the terms have to be accepted', () => {
    // The screen has two flows and no way to choose between them without this. Reading it from a
    // setting the browser cannot see is why it is answered rather than inferred.
    expect(view).toContain('consentRequired: config.consentRequired');
  });

  it('carries the balance automatic enrolment requires', () => {
    // Shown to a user who has not reached it. A copy of the figure on the other side would be a
    // second source of truth for a number that decides whether somebody is enrolled.
    expect(view).toContain('minimumEnrolmentLovelace: String(config.minimumEnrolmentLovelace)');
  });

  it('reads both from the resolved configuration rather than from the environment', () => {
    // `process.env` in this module would bypass the parsing and the defaults that the configuration
    // applies, and would make the payload depend on a variable nobody validated.
    expect(view).not.toContain('process.env');
  });
});

describe('the retired Cardano settings', () => {
  it.each(RETIRED_SETTINGS)('%s is gone from the Dockerfile', (name) => {
    const lines = instructionLines(repoFile('Dockerfile'), '#');

    expect(lines.filter((line) => line.includes(name))).toEqual([]);
  });

  it.each(RETIRED_SETTINGS)('%s is gone from Cloud Build', (name) => {
    const lines = instructionLines(repoFile('cloudbuild.yaml'), '#');

    expect(lines.filter((line) => line.includes(name))).toEqual([]);
  });

  it.each(RETIRED_SETTINGS)('%s is gone from the local build script', (name) => {
    const lines = instructionLines(repoFile('scripts/docker-build.sh'), '#');

    expect(lines.filter((line) => line.includes(name))).toEqual([]);
  });

  it.each(RETIRED_SETTINGS)('%s is gone from example_env', (name) => {
    const lines = instructionLines(repoFile('example_env'), '#');

    expect(lines.filter((line) => line.includes(name))).toEqual([]);
  });
});

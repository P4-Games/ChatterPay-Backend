import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * That the two derivation references reach the running process.
 *
 * They are settings rather than credentials — bech32 addresses — and they have to be in the image,
 * because the startup check reads them before the port opens. A reference that does not arrive
 * reads as one that was never recorded, and the deploy succeeds either way, so the plumbing is
 * asserted here instead of being left to whoever adds the next setting.
 */

/** The addresses this deployment is verified against. */
const REFERENCES = ['CARDANO_DERIVATION_CHECK', 'CARDANO_SPONSOR_DERIVATION_CHECK'];

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
 * @returns The lines that carry instructions rather than prose.
 */
function instructionLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
}

describe('the derivation references reach the container', () => {
  it.each(REFERENCES)('%s is declared and set in the Dockerfile', (name) => {
    const lines = instructionLines(repoFile('Dockerfile'));

    expect(lines.filter((line) => line === `ARG ${name}`)).toHaveLength(1);
    expect(lines.filter((line) => line === `ENV ${name} $${name}`)).toHaveLength(1);
  });

  it.each(REFERENCES)('%s is written into the .env Cloud Build assembles from', (name) => {
    // The `Build` step reads every `ARG` out of the Dockerfile and takes its value from that file,
    // so a name declared there and missing here becomes an empty build argument.
    const lines = instructionLines(repoFile('cloudbuild.yaml'));

    expect(lines.filter((line) => line.includes(`- ${name}=`))).toHaveLength(1);
  });

  it.each(REFERENCES)('%s is passed by the local build too', (name) => {
    const lines = instructionLines(repoFile('scripts/docker-build.sh'));

    expect(lines.filter((line) => line.includes(`--build-arg ${name}=`))).toHaveLength(1);
  });

  it.each(REFERENCES)('%s is documented in example_env', (name) => {
    expect(
      instructionLines(repoFile('example_env')).some((line) => line.startsWith(`${name}=`))
    ).toBe(true);
  });

  it.each(REFERENCES)('%s is not treated as a credential and withheld from the build', (name) => {
    // Adding either name to this list would leave the check with nothing to compare against.
    const line = instructionLines(repoFile('cloudbuild.yaml')).find((candidate) =>
      candidate.includes("secrets='")
    );
    if (line === undefined) throw new Error('the Build step no longer declares a skip list');

    expect((/secrets='([^']*)'/.exec(line)?.[1] ?? '').split(/\s+/)).not.toContain(name);
  });

  it('gives the sponsor substitution a default, so a trigger that lacks it still builds', () => {
    // Cloud Build matches substitutions strictly, so a `${_X}` no trigger defines fails the build.
    const lines = instructionLines(repoFile('cloudbuild.yaml'));

    expect(
      lines.filter((line) => /^\s+_CARDANO_SPONSOR_DERIVATION_CHECK:\s*''$/.test(line))
    ).toHaveLength(1);
  });
});

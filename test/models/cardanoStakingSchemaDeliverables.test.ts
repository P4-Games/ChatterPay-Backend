/**
 * The database deliverables, checked against the models they describe.
 *
 * MongoDB here is administered by hand, so what an administrator applies is a set of files outside
 * this repository rather than anything this code runs. That arrangement has one failure mode: the
 * files and the models drift, and nobody finds out until a collection is created without the
 * uniqueness the economic paths assume, or until a network is configured with a field the code does
 * not read. These tests are what makes the drift loud.
 *
 * The deliverables are three kinds of thing, and each is checked for what it is:
 *
 * - `indices.txt` names the indexes to create. Compared against `schema.indexes()`.
 * - `colecciones.txt` names which collections are new and which change.
 * - the `blockchains.*.json` files are documents an administrator pastes. They are validated
 *   against the model itself, because a staking setting that the schema does not declare is a
 *   setting nothing will ever read.
 *
 * Nothing here writes to any database.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import Blockchain from '../../src/models/blockchainModel';
import { STAKING_COLLECTIONS } from '../../src/models/cardanoStakingCollections';

/**
 * Where the deliverables live: a sibling of this repository, inside the roadmap folder.
 *
 * Resolved from this file rather than from the working directory, so the suite finds it the same
 * way however vitest was started.
 */
const BDD_DIR = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../_TODO/_0_roadmap_tareas/1-doing/b2c_cardano_stacking/bdd'
);

/** The database deliverables for the ChatterPay database. */
const CHATTERPAY_DIR = join(BDD_DIR, 'chatterpay');

/** The read the chat function calls, as the route declares it. */
const STAKING_SUMMARY_PATH = '/cardano/staking/summary';

/**
 * Collections staking uses and does not introduce.
 *
 * `cardano_utxo_claims` has carried transfers all along. Its index is checked by the runtime guard
 * because a staking operation's inputs depend on it, but an administrator applying this rollout has
 * nothing to create for it, so the deliverables do not list it.
 */
const PRE_EXISTING = new Set(['cardano_utxo_claims']);

/** Preprod, the network the dev document configures. */
const PREPROD_CHAIN_ID = 900000000001;

/**
 * Reads one deliverable.
 *
 * @param path - Path relative to the deliverables folder.
 * @returns The file's text.
 */
function read(path: string): string {
  return readFileSync(join(BDD_DIR, path), 'utf8');
}

/**
 * Reads one JSON deliverable.
 *
 * @param path - Path relative to the deliverables folder.
 * @returns The parsed document.
 */
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(read(path)) as Record<string, unknown>;
}

/**
 * The indexes `indices.txt` documents, as `name -> fields`.
 *
 * The file is a plain list an administrator reads, so the parsing is deliberately forgiving about
 * spacing and strict about nothing else: a line is an index when it is indented and carries at
 * least a name and a key specification.
 *
 * @returns The documented indexes.
 */
function documentedIndexes(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of readFileSync(join(CHATTERPAY_DIR, 'indices.txt'), 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('  ') || line.trim() === '') continue;
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 2 || !columns[1]?.includes(':')) continue;
    entries.set(columns[0] as string, (columns[1] as string).replace(/\s+/g, ' ').trim());
  }
  return entries;
}

/**
 * The indexes a model declares, as `name -> fields`, in the same notation the file uses.
 *
 * @returns The declared indexes of every staking collection.
 */
function declaredIndexes(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const { model, collection } of STAKING_COLLECTIONS) {
    if (PRE_EXISTING.has(collection)) continue;
    for (const [spec, options] of model.schema.indexes()) {
      const name = (options as { name?: string })?.name;
      if (name === undefined) continue;
      entries.set(
        name,
        Object.entries(spec)
          .map(([field, direction]) => `${field}:${String(direction)}`)
          .join(', ')
      );
    }
  }
  return entries;
}

describe('cardano staking database deliverables', () => {
  it('has a deliverables folder, because it is part of this change', () => {
    expect(
      existsSync(CHATTERPAY_DIR),
      `the deliverables were expected at ${CHATTERPAY_DIR}; the manual database update cannot be applied without them`
    ).toBe(true);
  });

  describe('the documented indexes', () => {
    it('name every index the models declare, with the same keys', () => {
      const documented = documentedIndexes();

      for (const [name, fields] of declaredIndexes()) {
        expect(documented.get(name), `${name}: keys documented in indices.txt`).toBe(fields);
      }
    });

    it('document nothing a query does not need', () => {
      // An index nobody queries through costs a write on every insert and is one more thing to
      // create by hand. The list is allowed to name what the models declare, plus the `blockchains`
      // lookup the settings are read through, and nothing else.
      const declared = declaredIndexes();
      const extra = [...documentedIndexes().keys()].filter(
        (name) => !declared.has(name) && name !== 'chainId_1'
      );

      expect(extra).toEqual([]);
    });
  });

  describe('the documented collections', () => {
    it('name every collection the rollout introduces', () => {
      const text = readFileSync(join(CHATTERPAY_DIR, 'colecciones.txt'), 'utf8');

      for (const { collection } of STAKING_COLLECTIONS) {
        if (PRE_EXISTING.has(collection)) continue;
        expect(text, `${collection} in colecciones.txt`).toContain(collection);
      }
    });

    it('say where the staking settings live', () => {
      // The one collection this change modifies rather than creates. An administrator who applies
      // the new collections and not this document gets a deployment where staking is off and the
      // reason is a field nobody set.
      const text = readFileSync(join(CHATTERPAY_DIR, 'colecciones.txt'), 'utf8');

      expect(text).toContain('blockchains');
      expect(text).toContain('blockchains.json');
    });
  });

  describe('the network document', () => {
    it('names the network it belongs to, and retires the wrapper', () => {
      const update = readJson('chatterpay/blockchains.json') as {
        filter: { chainId: unknown };
        update: { $set: Record<string, unknown>; $unset: Record<string, unknown> };
      };

      expect(update.filter.chainId).toEqual({ $numberLong: String(PREPROD_CHAIN_ID) });
      expect(Object.keys(update.update.$set)).toContain('staking');
      // The four connection fields moved to the top level in the same update, so a document is
      // never left carrying both shapes.
      expect(update.update.$unset).toEqual({ cardano: '' });
      expect(Object.keys(update.update.$set)).toEqual(
        expect.arrayContaining(['network', 'providerUrl', 'ttlSlots', 'depositConfirmations'])
      );
    });

    it('declares exactly the staking fields the model reads', () => {
      // A field here that the schema does not declare is a setting an administrator would set and
      // nothing would ever read; one the schema declares and this omits is a setting that silently
      // takes its default on a network somebody configured by hand.
      const update = readJson('chatterpay/blockchains.json') as {
        update: { $set: { staking: Record<string, unknown> } };
      };
      const stakingPaths = Object.keys(
        (Blockchain.schema.path('staking') as unknown as { schema: { paths: object } }).schema
          .paths as Record<string, unknown>
      );

      expect(Object.keys(update.update.$set.staking).sort()).toEqual([...stakingPaths].sort());
    });

    it('is a document the model accepts', () => {
      const update = readJson('chatterpay/blockchains.json') as {
        update: { $set: Record<string, unknown> };
      };

      const candidate = new Blockchain({
        name: 'Cardano Preprod',
        family: 'cardano',
        chainId: PREPROD_CHAIN_ID,
        explorer: 'https://preprod.cardanoscan.io/transaction/',
        environment: 'TEST',
        limits: { transfer: { L1: { D: 50 }, L2: { D: 1000 } } },
        ...update.update.$set
      });

      expect(candidate.validateSync()?.errors ?? {}).toEqual({});
    });

    it('keeps staking automatic, with the opt-out above everything', () => {
      // The product decision: an enabled network enrols the wallets that qualify. A consent gate is
      // something an operator turns on deliberately, and the opt-out is honoured either way.
      const update = readJson('chatterpay/blockchains.json') as {
        update: { $set: { staking: { consentRequired: boolean; enrolmentAllowlist: string[] } } };
      };

      expect(update.update.$set.staking.consentRequired).toBe(false);
      expect(update.update.$set.staking.enrolmentAllowlist).toEqual([]);
    });
  });

  describe('the one document that is inserted rather than applied', () => {
    it('is the document itself, ready to paste', () => {
      // Compass inserts what it is given. A file wrapping the document in a description of it would
      // create a row shaped like the description.
      const document = readJson('bot/chat_functions.consultar_staking_cardano.json');

      expect(document.name).toBeDefined();
      expect(document.api_config).toBeDefined();
      expect(document.collection).toBeUndefined();
      expect(document.document).toBeUndefined();
    });

    it('calls the endpoint this backend actually serves', () => {
      // The drift this catches is the expensive one: a chat function pointing at a path that was
      // renamed answers 404 to every user, and nothing in this repository would otherwise notice.
      const document = readJson('bot/chat_functions.consultar_staking_cardano.json') as {
        api_config: { url: string; method: string };
      };

      expect(document.api_config.url.endsWith(STAKING_SUMMARY_PATH)).toBe(true);
      expect(document.api_config.method).toBe('GET');
    });

    it('lets the runtime supply the user, rather than accepting one', () => {
      // `channel_user_id` identifies whose position is being read. A model that could pass it as an
      // ordinary argument could be talked into reading somebody else's.
      const document = readJson('bot/chat_functions.consultar_staking_cardano.json') as {
        api_config: {
          parameters: Record<string, unknown>;
          user_parameters?: Record<string, unknown>;
        };
      };

      expect(document.api_config.parameters.channel_user_id).toBeUndefined();
      expect(document.api_config.user_parameters?.channel_user_id).toBeDefined();
    });

    it('carries no credential of its own', () => {
      // The token is resolved from the bot's environment at call time. A literal here would be a
      // credential living in a file in a roadmap folder.
      const raw = read('bot/chat_functions.consultar_staking_cardano.json');

      expect(raw).toContain('{{env:');
      expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/);
    });
  });
});

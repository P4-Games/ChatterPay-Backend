/**
 * The declarative database deliverables, checked against the models they describe.
 *
 * MongoDB here is administered by hand, so what an administrator applies is a set of JSON files
 * outside this repository rather than anything this code runs. That arrangement has one failure
 * mode: the files and the models drift, and nobody finds out until a collection is created without
 * the uniqueness the economic paths assume. These tests are what makes the drift loud — they read
 * the deliverables and compare them against `schema.indexes()` and the schema paths themselves,
 * which are the only source of truth either side is allowed to have.
 *
 * Nothing here writes to any database an administrator would recognise. The index and guard cases
 * run against the suite's own in-memory server, and the auto-creation case runs against a database
 * name that exists nowhere else.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import mongoose, { type Model, type Schema } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';

import CardanoStakingAccount from '../../src/models/cardanoStakingAccountModel';
import { STAKING_COLLECTIONS } from '../../src/models/cardanoStakingCollections';
import CardanoStakingFeeBudget from '../../src/models/cardanoStakingFeeBudgetModel';
import CardanoStakingOperation from '../../src/models/cardanoStakingOperationModel';
import {
  checkStakingOperationReadiness,
  missingStakingIndexes,
  resetStakingSchemaVerification
} from '../../src/services/cardano/cardanoStakingOperationService';

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

/** Mongoose's own name for a type, and the BSON type the deliverables are expected to name. */
const BSON_TYPE: Readonly<Record<string, string>> = {
  ObjectId: 'objectId',
  String: 'string',
  Number: 'number',
  Boolean: 'bool',
  Date: 'date',
  Buffer: 'binData',
  Decimal128: 'decimal',
  Map: 'object',
  Embedded: 'object',
  Array: 'array',
  Mixed: 'object'
};

interface JsonSchemaNode {
  bsonType?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  additionalProperties?: JsonSchemaNode;
  enum?: unknown[];
}

interface IndexEntry {
  name: string;
  keys: Record<string, unknown>;
  options: Record<string, unknown>;
}

/**
 * What these tests read out of a Mongoose schema.
 *
 * Structural rather than `Schema`, because the collection list holds models typed `Model<never>` so
 * that it can hold models of nine different shapes, and `never` does not flow back into the generic
 * schema type. Nothing here is written through, so reading is all the type has to allow.
 */
interface SchemaPathLike {
  instance?: string;
  isRequired?: boolean;
  schema?: SchemaLike;
  caster?: { schema?: SchemaLike };
  options?: { enum?: unknown[]; of?: { schema?: SchemaLike } };
  $__schemaType?: { schema?: SchemaLike };
}

interface SchemaLike {
  paths: Record<string, SchemaPathLike>;
  options: { autoCreate?: boolean; autoIndex?: boolean };
}

function schemaOf(model: Model<never>): SchemaLike {
  return model.schema as unknown as SchemaLike;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(BDD_DIR, file), 'utf8')) as Record<string, unknown>;
}

/** The paths a schema declares, without the version key and without Mongoose's own bookkeeping. */
function declaredPaths(schema: SchemaLike): string[] {
  return Object.keys(schema.paths).filter((path) => path !== '__v' && !path.includes('.'));
}

/** Whether the deliverable names a type, allowing for the `["<type>", "null"]` spelling. */
function namesType(node: JsonSchemaNode | undefined, expected: string): boolean {
  const declared = node?.bsonType;
  if (Array.isArray(declared)) return declared.includes(expected);
  return declared === expected;
}

/**
 * Compares one level of a documented `$jsonSchema` against the schema it claims to describe, then
 * descends into sub-documents, arrays of sub-documents and maps.
 *
 * @param node - The documented node.
 * @param schema - The Mongoose schema it should describe.
 * @param where - Human-readable location, used in failure messages.
 */
function expectNodeMatchesSchema(node: JsonSchemaNode, schema: SchemaLike, where: string): void {
  const paths = declaredPaths(schema);
  const documented = Object.keys(node.properties ?? {});

  expect(documented.sort(), `${where}: documented fields`).toEqual([...paths].sort());

  const required = paths.filter((path) => schema.paths[path]?.isRequired === true);
  expect([...(node.required ?? [])].sort(), `${where}: required fields`).toEqual(
    [...required].sort()
  );

  for (const path of paths) {
    const type = schema.paths[path] ?? {};
    const child = node.properties?.[path];
    const expected = BSON_TYPE[type.instance ?? 'Mixed'] ?? 'object';
    expect(
      namesType(child, expected),
      `${where}.${path}: bsonType ${String(child?.bsonType)}`
    ).toBe(true);

    const declaredEnum = type.options?.enum;
    if (Array.isArray(declaredEnum)) {
      const values = (child?.enum ?? []).filter((value) => value !== null);
      expect(values, `${where}.${path}: enum`).toEqual(declaredEnum);
    }

    if (type.instance === 'Array') {
      const sub = type.schema ?? type.caster?.schema;
      if (sub !== undefined) expectNodeMatchesSchema(child?.items ?? {}, sub, `${where}.${path}[]`);
    } else if (type.instance === 'Map') {
      const sub = type.$__schemaType?.schema ?? type.options?.of?.schema;
      if (sub !== undefined) {
        expectNodeMatchesSchema(child?.additionalProperties ?? {}, sub, `${where}.${path}.$*`);
      }
    } else if (type.schema !== undefined) {
      expectNodeMatchesSchema(child ?? {}, type.schema, `${where}.${path}`);
    }
  }
}

/**
 * The indexes a model declares, in the shape the deliverables use.
 *
 * `background` is dropped: Mongoose injects it into every declared index, MongoDB has ignored it
 * since 4.2, and it is not a property of the index that ends up on the collection.
 *
 * @param model - Model to read.
 * @returns The declared indexes, sorted by name.
 */
function declaredIndexes(model: Model<never>): IndexEntry[] {
  return model.schema
    .indexes()
    .map(([keys, raw]) => {
      const options: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw ?? {})) {
        if (key === 'background' || key === 'name') continue;
        options[key] = value;
      }
      return { name: String((raw as { name?: string })?.name), keys, options };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

describe('cardano staking database deliverables', () => {
  it('has a deliverables folder, because it is part of this change', () => {
    expect(
      existsSync(BDD_DIR),
      `the JSON deliverables were expected at ${BDD_DIR}; they are part of this change and the manual database update cannot be applied without them`
    ).toBe(true);
  });

  describe('the files themselves', () => {
    it('are all valid JSON', () => {
      const files = readdirSync(BDD_DIR).filter((file) => file.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        expect(() => readJson(file), `${file} is not valid JSON`).not.toThrow();
      }
    });

    it('covers every staking collection, and the readme that says how to apply them', () => {
      const files = new Set(readdirSync(BDD_DIR));

      for (const { collection } of STAKING_COLLECTIONS) {
        expect(files.has(`${collection}.schema.json`), `${collection}.schema.json`).toBe(true);
        expect(files.has(`${collection}.indexes.json`), `${collection}.indexes.json`).toBe(true);
      }

      expect(files.has('README.md')).toBe(true);
    });
  });

  describe('the documented schemas', () => {
    for (const { model, collection } of STAKING_COLLECTIONS) {
      it(`matches the model behind ${collection}`, () => {
        const file = readJson(`${collection}.schema.json`);
        expect(file.collection).toBe(collection);

        const options = file.collectionOptions as Record<string, unknown>;
        const schema = schemaOf(model);
        expect(options.autoCreate).toBe(schema.options.autoCreate === true);
        expect(options.autoIndex).toBe(schema.options.autoIndex === true);

        const validator = (file.validator as { $jsonSchema: JsonSchemaNode }).$jsonSchema;
        expectNodeMatchesSchema(validator, schema, collection);
      });
    }
  });

  describe('the documented indexes', () => {
    for (const { model, collection } of STAKING_COLLECTIONS) {
      it(`matches what ${collection} declares, options included`, () => {
        const file = readJson(`${collection}.indexes.json`);
        const documented = (file.indexes as IndexEntry[])
          .map((entry) => ({ name: entry.name, keys: entry.keys, options: entry.options }))
          .sort((left, right) => left.name.localeCompare(right.name));

        expect(documented).toEqual(declaredIndexes(model));
      });
    }

    it('spells out the constraints the economic paths rest on', () => {
      // These three are not performance indexes. Read them back by name rather than trusting the
      // wholesale comparison above, because a deliverable that lost the unique flag or the partial
      // filter would still be a well-formed file.
      const operations = readJson('cardano_staking_operations.indexes.json')
        .indexes as IndexEntry[];
      const live = operations.find((entry) => entry.name === 'one_live_op_per_account');
      expect(live?.options).toEqual({
        unique: true,
        partialFilterExpression: { liveness: 'live' }
      });

      const accounts = readJson('cardano_staking_accounts.indexes.json').indexes as IndexEntry[];
      const credential = accounts.find((entry) => entry.name === 'chain_credential_unique');
      expect(credential?.options).toEqual({ unique: true });

      const claims = readJson('cardano_utxo_claims.indexes.json').indexes as IndexEntry[];
      expect(claims.find((entry) => entry.name === 'expiresAt_1')?.options).toEqual({
        expireAfterSeconds: 0
      });
    });
  });

  describe('the example documents', () => {
    const ejson = mongoose.mongo.BSON.EJSON;

    it('describes an account a human can create, and one that enables nothing', () => {
      const raw = ejson.deserialize(readJson('cardano_staking_accounts.example.json'));
      const account = new CardanoStakingAccount(raw as Record<string, unknown>);

      expect(account.validateSync()).toBeUndefined();
      // A prepared row is inert: no consent, nothing read from the chain, preference off. The guard
      // refuses every economic operation on it until the sync has actually read the credential.
      expect(account.termsConsent).toBeNull();
      expect(account.preference.enabled).toBe(false);
      expect(account.onChain.asOf).toBeNull();
      expect(account.state).toBe('awaiting_consent');
    });

    it('describes a budget window whose id is the lock', () => {
      const raw = ejson.deserialize(readJson('cardano_staking_fee_budget.example.json')) as {
        _id: string;
        chainId: number;
        window: string;
        capLovelace: string;
      };
      const budget = new CardanoStakingFeeBudget(raw);

      expect(budget.validateSync()).toBeUndefined();
      expect(raw._id).toBe(`${raw.chainId}:${raw.window}`);
      // Lovelace is a decimal string wherever a quantity could outgrow an exact JavaScript integer.
      expect(typeof raw.capLovelace).toBe('string');
    });
  });
});

describe('the guard the deliverables exist for', () => {
  beforeAll(async () => {
    for (const { model } of STAKING_COLLECTIONS) await model.createIndexes();
    resetStakingSchemaVerification();
  });

  /** An account the guard would otherwise let through: read on chain, consent on record. */
  const readyAccount = () =>
    new CardanoStakingAccount({
      userId: new mongoose.Types.ObjectId(),
      chainId: 900000000001,
      walletAddress: 'addr_test1qzdeliverable',
      rewardAddress: 'stake_test1uqdeliverable',
      stakeCredentialHex: '313318dd5b51b0376278ee8f2ad38cdf9466d483e60c312428964faf',
      termsConsent: { version: 'v1', acceptedAt: new Date(), source: 'test' },
      onChain: { asOf: new Date() }
    });

  it('permits an operation only once every declared index is really there', async () => {
    expect(await missingStakingIndexes()).toEqual([]);
    expect((await checkStakingOperationReadiness(readyAccount(), 'register_and_delegate')).ok).toBe(
      true
    );
  });

  it('fails closed when a documented index is missing from the database', async () => {
    await CardanoStakingOperation.collection.dropIndex('one_live_op_per_account');
    resetStakingSchemaVerification();

    const readiness = await checkStakingOperationReadiness(readyAccount(), 'register_and_delegate');

    expect(readiness.ok).toBe(false);
    if (readiness.ok) return;
    expect(readiness.refusal).toBe('indexes_missing');
    expect(readiness.detail).toContain('one_live_op_per_account');

    await CardanoStakingOperation.createIndexes();
    resetStakingSchemaVerification();
  });
});

describe('the backend brings no collection into existence on its own', () => {
  it('declares every staking model as neither self-creating nor self-indexing', () => {
    for (const { model, collection } of STAKING_COLLECTIONS) {
      const { options } = schemaOf(model);
      expect(options.autoCreate, `${collection}: autoCreate`).toBe(false);
      expect(options.autoIndex, `${collection}: autoIndex`).toBe(false);
    }
  });

  it('creates nothing when the models are used against an untouched database', async () => {
    // A database name nothing else in this suite knows, so what it holds afterwards is entirely the
    // doing of the reads below. Compiling a model and reading through it is what the backend does on
    // the way up, and it is the moment Mongoose would otherwise create the collection and start
    // building indexes in the background.
    const probe = mongoose.connection.useDb('cardano_staking_autocreate_probe', {
      useCache: false
    });

    for (const { model, collection } of STAKING_COLLECTIONS) {
      const probed = probe.model(collection, model.schema as unknown as Schema, collection);
      await probed.findOne().lean();
    }

    const { db } = probe;
    expect(db).toBeDefined();
    const created = db === undefined ? [] : await db.listCollections().toArray();

    expect(created.map((entry) => entry.name)).toEqual([]);
  });
});

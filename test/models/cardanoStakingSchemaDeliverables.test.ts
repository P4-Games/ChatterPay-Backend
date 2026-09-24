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

import { type Model } from 'mongoose';
import { describe, expect, it } from 'vitest';

import CardanoStakingAccount from '../../src/models/cardanoStakingAccountModel';
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

/** The read the chat function calls, as the route declares it. */
const STAKING_SUMMARY_PATH = '/cardano/staking/summary';

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

/**
 * The `$jsonSchema` a deliverable carries.
 *
 * The file is the validator and nothing else, because that is what Compass's validation tab takes.
 *
 * @param collection - The collection whose schema to read.
 * @returns The validator.
 */
function readValidator(collection: string): JsonSchemaNode {
  const file = JSON.parse(
    readFileSync(join(BDD_DIR, `${collection}.schema.json`), 'utf8')
  ) as Record<string, unknown>;
  return file.$jsonSchema as JsonSchemaNode;
}

/**
 * The indexes a deliverable declares, in the shape these tests compare.
 *
 * The file itself is the array `createIndexes` takes — `{ key, name, ...options }` per entry — so
 * that it can be pasted into a shell without being unwrapped first. Split back into keys and
 * options here, because that is how Mongoose reports what the model declares.
 *
 * @param collection - The collection whose indexes to read.
 * @returns The declared indexes, sorted by name.
 */
function readIndexes(collection: string): IndexEntry[] {
  const file = JSON.parse(
    readFileSync(join(BDD_DIR, `${collection}.indexes.json`), 'utf8')
  ) as Array<Record<string, unknown>>;

  return file
    .map(({ key, name, ...options }) => ({
      name: name as string,
      keys: key as Record<string, unknown>,
      options
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
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
  // The version key is filtered on both sides. Mongoose writes it on every document, so a validator
  // has to accept it, but it is bookkeeping rather than a field of the model and whether a
  // deliverable spells it out says nothing about drift.
  const documented = Object.keys(node.properties ?? {}).filter((field) => field !== '__v');

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

    it('covers every staking collection', () => {
      const files = new Set(readdirSync(BDD_DIR));

      for (const { collection } of STAKING_COLLECTIONS) {
        expect(files.has(`${collection}.schema.json`), `${collection}.schema.json`).toBe(true);
        expect(files.has(`${collection}.indexes.json`), `${collection}.indexes.json`).toBe(true);
      }
    });

    it('holds nothing that is not applied to a database', () => {
      // These files are pasted into Compass one at a time. Anything else in the folder — a readme,
      // a sample row — is something somebody has to know to skip, and a sample row in particular is
      // something somebody can paste into a live collection by mistake.
      const strays = readdirSync(BDD_DIR).filter((file) => !file.endsWith('.json'));

      expect(strays).toEqual([]);
    });

    it('carries each schema as the validator itself, with nothing wrapped around it', () => {
      // Compass takes the validator, not a document describing one. A file with a `collection` or
      // `description` key at the top would have to be unwrapped by hand first, which is exactly the
      // step somebody skips.
      for (const { collection } of STAKING_COLLECTIONS) {
        const file = readJson(`${collection}.schema.json`);

        expect(Object.keys(file), collection).toEqual(['$jsonSchema']);
      }
    });

    it('carries each index file as the array createIndexes takes', () => {
      for (const { collection } of STAKING_COLLECTIONS) {
        const raw = JSON.parse(
          readFileSync(join(BDD_DIR, `${collection}.indexes.json`), 'utf8')
        ) as unknown;

        expect(Array.isArray(raw), collection).toBe(true);
        for (const entry of raw as Array<Record<string, unknown>>) {
          expect(entry.key, collection).toBeDefined();
          expect(typeof entry.name, collection).toBe('string');
        }
      }
    });
  });

  describe('the documented schemas', () => {
    for (const { model, collection } of STAKING_COLLECTIONS) {
      it(`matches the model behind ${collection}`, () => {
        expectNodeMatchesSchema(readValidator(collection), schemaOf(model), collection);
      });
    }
  });

  describe('the documented indexes', () => {
    for (const { model, collection } of STAKING_COLLECTIONS) {
      it(`matches what ${collection} declares, options included`, () => {
        expect(readIndexes(collection)).toEqual(declaredIndexes(model));
      });
    }

    it('spells out the constraints the economic paths rest on', () => {
      // These three are not performance indexes. Read them back by name rather than trusting the
      // wholesale comparison above, because a deliverable that lost the unique flag or the partial
      // filter would still be a well-formed file.
      const operations = readIndexes('cardano_staking_operations');
      const live = operations.find((entry) => entry.name === 'one_live_op_per_account');
      expect(live?.options).toEqual({
        unique: true,
        partialFilterExpression: { liveness: 'live' }
      });

      const accounts = readIndexes('cardano_staking_accounts');
      const credential = accounts.find((entry) => entry.name === 'chain_credential_unique');
      expect(credential?.options).toEqual({ unique: true });

      const claims = readIndexes('cardano_utxo_claims');
      expect(claims.find((entry) => entry.name === 'expiresAt_1')?.options).toEqual({
        expireAfterSeconds: 0
      });
    });

    it('documents the opt-out exactly as the model declares it', () => {
      // Read back by name rather than trusting the wholesale comparison, for the same reason as the
      // indexes above: this one carries a security property. An opt-out is what stops the sweep
      // re-enrolling somebody who left, and a deliverable that dropped the field, made it optional
      // or lost a reason from the enum would still be a well-formed file — applied to a fresh
      // database it would produce a collection whose validator rejects the very write that records
      // the decision, and the first person to leave would be re-enrolled the next morning.
      const optOut = readValidator('cardano_staking_accounts').properties?.optOut;

      // Nullable: absent is the ordinary state, and a row written before the field existed reads as
      // null rather than as a refusal.
      expect(optOut?.bsonType).toEqual(['object', 'null']);
      expect(optOut?.required).toEqual(['at', 'preferenceVersion', 'reason', 'source']);
      expect(optOut?.properties?.reason?.enum).toEqual(
        (
          CardanoStakingAccount.schema.path('optOut') as unknown as {
            schema: { path(name: string): { options: { enum: string[] } } };
          }
        ).schema.path('reason').options.enum
      );
    });

    it('describes consent as something only a person can give', () => {
      // The two fields a prepared row must not carry. `termsConsent` nullable and `preference` with
      // its own version are what let the code tell "nobody ever switched this on" from "somebody
      // switched it off", which is the distinction the opt-out rests on.
      const properties = readValidator('cardano_staking_accounts').properties;

      expect(properties?.termsConsent?.bsonType).toEqual(['object', 'null']);
      expect(properties?.termsConsent?.required).toEqual(['acceptedAt', 'source', 'version']);
      // A string: the terms version is a label, and bumping it asks everybody again.
      expect(properties?.termsConsent?.properties?.version?.bsonType).toBe('string');
      // A number: the preference version is a counter the opt-out records, so a later opt-in is
      // distinguishable from the switch that was on before somebody left.
      expect(properties?.preference?.properties?.version?.bsonType).toBe('number');
    });
  });

  describe('the one document that is inserted rather than applied', () => {
    it('is the document itself, ready to paste', () => {
      // Compass inserts what it is given. A file wrapping the document in a description of it would
      // create a row shaped like the description.
      const document = readJson('chat_functions.consultar_staking.json');

      expect(document.name).toBeDefined();
      expect(document.api_config).toBeDefined();
      expect(document.collection).toBeUndefined();
      expect(document.document).toBeUndefined();
    });

    it('calls the endpoint this backend actually serves', () => {
      // The drift this catches is the expensive one: a chat function pointing at a path that was
      // renamed answers 404 to every user, and nothing in this repository would otherwise notice.
      const document = readJson('chat_functions.consultar_staking.json') as {
        api_config: { url: string; method: string };
      };

      expect(document.api_config.url.endsWith(STAKING_SUMMARY_PATH)).toBe(true);
      expect(document.api_config.method).toBe('GET');
    });

    it('lets the runtime supply the user, rather than accepting one', () => {
      // `channel_user_id` identifies whose position is being read. A model that could pass it as an
      // ordinary argument could be talked into reading somebody else's.
      const document = readJson('chat_functions.consultar_staking.json') as {
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
      const raw = readFileSync(join(BDD_DIR, 'chat_functions.consultar_staking.json'), 'utf8');

      expect(raw).toContain('{{env:');
      expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/);
    });
  });
});

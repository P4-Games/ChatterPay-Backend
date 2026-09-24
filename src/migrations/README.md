# Migrations

This repository had no migration mechanism before this directory. What is here is the minimum the
Cardano staking rollout needed, written so that the next migration has something to copy rather than
a decision to re-make.

## Running one

```
bun run migrate 0001-cardano-staking-bootstrap
bun run migrate 0001-cardano-staking-bootstrap --apply --confirm-database=chatterpay-dev
```

The first form is a dry run. **It is the default**: a migration that needs no flag to start writing
is one flag away from being run against the wrong database by accident, so the safe mode is what you
get for free and `--apply` is the deliberate act.

Flags:

| Flag | Meaning |
|---|---|
| `--apply` | Actually write. Without it nothing is written at all. Requires `--confirm-database`. |
| `--confirm-database=<name>` | The database you mean. Compared with what the connection string resolves to; a mismatch stops the run before it connects. |
| `--chain-id=<id>` | Restrict the run to one network. |
| `--user-id=<oid>` | Restrict the run to one user, for re-checking a single case. |
| `--resume-after=<oid>` | Continue a scan past this `_id`. |
| `--limit=<n>` | Stop after this many subjects. |

An unrecognised flag is refused rather than ignored: `--aply` reads as `--apply` to a hurried eye.

Every report opens with the environment, the host and the database it is about:

```
migration: 0001-cardano-staking-bootstrap
environment: development
host:      localhost:27017
database:  chatterpay-dev
mode:      APPLY
```

The host carries no username and no password. They are stripped, not masked: a report gets pasted
into tickets and scrolled past in CI logs, and neither half of a credential belongs there.

## Naming the target is not optional

Two separate refusals stand between a command line and a write.

`MONGO_URI` must be set. The application falls back to a default connection string when it is
absent, which is fine for a server — it comes up against a local database and somebody notices —
and is not fine here, because a migration inherits that fallback silently and every safeguard then
aims at the wrong target.

`--apply` must name the database. `--confirm-database=<name>` is compared with what the connection
string actually resolves to, and a mismatch stops the run before it connects. A dry run needs
neither ceremony: it writes nothing, and making inspection tedious only discourages the step that is
supposed to come first.

### Why both exist

A run meant for `chatterpay-dev` created the eight staking collections in `chatterpay` instead.

`cli.ts` did not load `dotenv`. Nothing in the process had `MONGO_URI`, so the default connection
string applied, and the run landed in a populated local database that was not its target. It
reported success — twenty-two indexes created and verified — because everything it said was true of
wherever it had landed, and nothing in the output named that anywhere.

The dry run did not catch it either. It pointed at the same wrong database and reported the same
plan against it.

Recovery: all eight collections held zero documents, `usersScanned` was `0`, and no pre-existing
collection had been read or modified. Each was verified empty and dropped, which returned the
database to the thirty-six collections it held before.

Three changes came out of it, and each closes a different part of the path. `cli.ts` loads `dotenv`
as its first import, so a hand-started run has the environment a server would have. `runMigration`
refuses an absent `MONGO_URI` rather than inheriting the fallback. And the report names the
environment, host and database first, so a run that lands somewhere unintended says so in the line
above the one that says it worked.

The exit code is `0` only when the run finished with no findings. `1` means it completed and found
data it deliberately did not touch; `2` means it could not run at all.

## What `--dry-run` guarantees

Nothing is written. Not documents, not collections, not indexes, and no record that the migration
ran.

This is a property of the code's shape, not a promise about its branches. A migration never touches
the database to write; it is handed a `MigrationWriter`, and in a dry run that writer records the
sentences it was asked to perform and performs none of them. The runner also turns `autoIndex` and
`autoCreate` off for the process, because Mongoose otherwise builds a model's indexes the first time
it is used — a write, and one the migration never asked for.

The test suite asserts this end to end: it snapshots every collection, document and index
specification before a dry run and compares the snapshot afterwards.

## The staking schemas do not create themselves

Every `cardano_staking_*` schema is declared with `autoCreate: false` and `autoIndex: false`.

Mongoose otherwise creates a model's collection and builds its indexes in the background the moment
the model is **compiled**, which is at import time — so merely importing a model, in any process,
brings its collection into existence. That made a dry run leave exactly the trace it promises not to,
and it left the order in which collections appeared depending on which container started first.

The consequence to know about: this migration is now the only thing that builds these indexes. If a
deployment ever writes to one of these collections without having run it, Mongo will create the
collection implicitly and it will have **no unique indexes** — and the uniqueness of a stake
credential is what stops two accounts claiming one deposit. Run the migration before enabling
anything; every staking flag ships off by default so that the order is enforced by configuration as
well as by procedure.

## Conventions

- **A file per migration**, named `NNNN-kebab-case.ts`, default-exporting a `Migration`. The number
  is never reused. Register it in `cli.ts`.
- **Never at application boot.** A schema change that rides along with a container start happens
  once per instance, at the worst possible moment, and with no chance to inspect it first.
- **Idempotent.** Running it twice changes nothing the second time. Uniqueness comes from indexes,
  and a duplicate key on insert is the expected outcome of a repeat, not an error.
- **Resumable without a checkpoint.** Scans page by ascending `_id` and the report ends with the
  last one reached; an interrupted run continues with `--resume-after`. Keeping the cursor out of
  the database is also what lets a dry run leave no trace.
- **Report, never repair.** Data a migration did not expect goes into `findings` and is left exactly
  as found. Overwriting something unexpected turns a detectable inconsistency into a silent one.
- **Create indexes, never drop them.** An index on the collection that the schema does not declare
  is named in the findings and left in place. Dropping one a migration does not recognise removes
  the support of a query nobody in that run knows about.

## Backup and rollback

Take a backup and restore it somewhere else before applying anything. A backup nobody has restored
is a belief, not a backup.

A rollback reverts **schema**, never economic state. `cardano_staking_deposit_events` and
`cardano_staking_operations` record money that exists on chain whether or not any feature flag is
on, and no migration may delete them.

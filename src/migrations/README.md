# Migrations

This repository had no migration mechanism before this directory. What is here is the minimum the
Cardano staking rollout needed, written so that the next migration has something to copy rather than
a decision to re-make.

## Running one

```
bun run migrate 0001-cardano-staking-bootstrap
bun run migrate 0001-cardano-staking-bootstrap --apply
```

The first form is a dry run. **It is the default**: a migration that needs no flag to start writing
is one flag away from being run against the wrong database by accident, so the safe mode is what you
get for free and `--apply` is the deliberate act.

Flags:

| Flag | Meaning |
|---|---|
| `--apply` | Actually write. Without it nothing is written at all. |
| `--chain-id=<id>` | Restrict the run to one network. |
| `--user-id=<oid>` | Restrict the run to one user, for re-checking a single case. |
| `--resume-after=<oid>` | Continue a scan past this `_id`. |
| `--limit=<n>` | Stop after this many subjects. |

An unrecognised flag is refused rather than ignored: `--aply` reads as `--apply` to a hurried eye.

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

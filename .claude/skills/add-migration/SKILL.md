---
name: add-migration
description: Add or change a database migration in packages/db — Drizzle schema edit, drizzle-kit generate versus hand-written SQL for TimescaleDB hypertables/policies/triggers, migration numbering and journal, the MIGRATION_FILE_COUNT test bump, explicit FK naming for PostgreSQL's 63-byte identifier limit, and ADR-0020 user-reference forms. Use when asked to add a table, column, index, constraint, hypertable, or any schema change, or when a migration fails to apply.
---

Migrations are **reviewed artifacts**. ADR-0006 (Drizzle + first-class SQL) and ADR-0018
(explicit, advisory-locked migration) govern this; schema rules are in
`apps/docs/src/content/docs/development/implementation-contract.md` (Database and schema).

Never use `drizzle-kit push` or any auto-sync. Never edit a migration that has been applied
anywhere — add a new one.

## Layout

```
packages/db/src/schema/*.ts        Drizzle schema (the model)
packages/db/drizzle.config.ts      EXPLICIT schema file list — new files must be added here
packages/db/migrations/NNNN_name.sql
packages/db/migrations/meta/_journal.json + NNNN_snapshot.json   generated; commit them
packages/db/test/migrate.test.ts   MIGRATION_FILE_COUNT
```

Numbering is `drizzle-kit`'s zero-padded sequence continuing the journal
(`0006_expenses_and_counterparties.sql` → next is `0007_…`). Never renumber or reuse a tag.

## The workflow

1. **Edit the schema** under `packages/db/src/schema/`. New file → add its path to the
   `schema` array in `packages/db/drizzle.config.ts`. That list is explicit on purpose:
   `src/schema/observations.ts` is deliberately excluded because
   `marketplace_item_observations` is created by hand-written SQL as a Timescale hypertable and
   exists in Drizzle only for typing.
2. **Generate**: `bun --cwd packages/db generate`.
3. **Hand-review the emitted SQL line by line** before committing. Confirm the DDL says what
   the design says; confirm nothing was silently weakened (`UNIQUE … NULLS NOT DISTINCT`,
   `num_nonnulls` checks, partial/expression unique indexes, `DESC` index ordering all survive
   generation today — verify, do not assume). Open the SQL header of
   `packages/db/migrations/0006_expenses_and_counterparties.sql` for the house comment style:
   what the migration ships, what it deliberately does **not** create, and why.
4. **Hand-write SQL** when drizzle-kit cannot express it — Timescale hypertables, columnstore
   settings and policies, triggers, functions, backfills. Reference:
   `packages/db/migrations/0001_observations_hypertable.sql`:

   ```sql
   CREATE TABLE "marketplace_item_observations" ( … ) WITH (
     tsdb.hypertable, tsdb.partition_column = 'observed_at',
     tsdb.chunk_interval = '7 days', tsdb.columnstore = false,
     tsdb.create_default_indexes = false
   );--> statement-breakpoint
   ```

   Statements are separated by `--> statement-breakpoint`. Verify current Timescale syntax
   against upstream docs at implementation time and record the version you verified against in
   the file header — the removed Hypercore TAM APIs are deliberately not used.
5. **Bump the count**: `MIGRATION_FILE_COUNT` in `packages/db/test/migrate.test.ts` must equal
   the number of files in `packages/db/migrations/`. The suite asserts pending count, applied
   count, and the split across two runs; forgetting this is the standard failure.
6. **Apply explicitly**: `bun run migrate` (or `docker compose run --rm migrate`).
   **Startup never migrates** (ADR-0018) — the app calls `checkMigrationState` and fails
   readiness with a diagnostic when the database is behind, recovering without restart once the
   migration lands. `runMigrations` holds the session advisory lock `MIGRATION_LOCK_KEY`
   (`5498710724765894983`) — that constant is part of the operational contract; never change it.
7. **Test** against a scratch database: `bun --cwd packages/db test`, plus the suites of every
   package whose tables you touched.

## Traps

**63-byte identifiers.** PostgreSQL silently truncates constraint and index names. Drizzle's
derived names for long table/column combinations run 64–72 bytes. Name such foreign keys and
indexes **explicitly** in the schema and say why in a comment — the precedents are
`packages/db/src/schema/counterparties.ts`, `inventory.ts`, and `commerce.ts`. Where a design
adds several long references, assert the limit in a test.

**User references (ADR-0020).** `created_by_user_id` / `updated_by_user_id` / `actor_user_id`
take one of exactly two intentional forms:

1. nullable FK to the Better Auth user with `ON DELETE SET NULL` — the default for provenance;
2. an intentional **non-FK** historical identifier where the original id is itself the fact (immutable audit payloads).

`ON DELETE CASCADE` from auth tables into domain/audit/business tables is prohibited. Deleting
a user removes authentication identity, not evidence that the user acted. Auth tables
themselves are regenerated, not hand-edited: `bun --cwd packages/db generate:auth`, then diff
and produce a normal migration.

**Schema rules.** Money is `numeric` (no JS `number` arithmetic on persisted amounts). Domain
states are `text` + TS unions with `CHECK`s where useful — no PostgreSQL enums. TimescaleDB is
enabled from the first migration. Retry identity: unique constraints that let an at-least-once
handler re-insert the same batch conflict instead of duplicating (a hypertable unique index
must include the partition column).

**Scope.** Create only the foundation tables the current slice needs. Do not eagerly build the
future commerce/accounting/project schema because a design document describes it, and do not
create `accounting_books` or a one-book-per-entity relationship — books belong to the later
Accounting phase (ADR-0017).

## Done when

- [ ] Schema file registered in `drizzle.config.ts`; SQL + `meta/` snapshots committed together.
- [ ] Emitted SQL hand-reviewed; header explains what ships and what deliberately does not.
- [ ] `MIGRATION_FILE_COUNT` bumped; `bun --cwd packages/db test` green.
- [ ] Long FK/index names given explicitly; user references use a documented ADR-0020 form.
- [ ] Applied via `bun run migrate` against a scratch DB, not by starting the app.

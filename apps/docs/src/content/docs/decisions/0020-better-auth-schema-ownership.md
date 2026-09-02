---
title: "ADR-0020: Better Auth Schema Ownership and User References"
---

**Status:** Accepted for foundation implementation.

## Context

ADR-0006 makes reviewed, version-controlled Drizzle migrations the schema artifact. ADR-0007 and the foundational data model describe Better Auth-owned authentication tables that Loxep must not duplicate. Left unresolved were: who physically generates and owns the auth tables' DDL, whether Loxep tables may declare foreign keys to the Better Auth user ID, and what happens to historical records when an auth user is deleted. Foundation tables carry many user-reference columns (`created_by_user_id`, `updated_by_user_id`, `actor_user_id`) currently sketched as bare `text`.

## Decision

### Better Auth owns the model; Loxep owns the artifact

Better Auth's CLI generates the authentication schema as Drizzle schema source, which is **checked into the repository** and flows through the same Drizzle Kit generate/review/apply workflow as every other table. Better Auth defines what the auth model must contain; Loxep owns the checked-in schema files and the reviewed migration history that creates them.

Regeneration after a Better Auth upgrade is an explicit, reviewed event: regenerate, diff, produce a normal migration. Auth tables are never mutated by the running application outside Better Auth's own operations, and never edited by hand in ways the generator would not reproduce.

The exact current Better Auth CLI commands and plugin table requirements (OIDC, magic link, admin/roles) are verified against upstream documentation at implementation time, per the dependency policy.

### Loxep columns on auth tables are declared, never hand-added

When Loxep needs a column that Better Auth does not define — a profile field, a preference — it is declared through Better Auth's own extension mechanism (`user.additionalFields` and the equivalent per-model options) in the shared options builder, then emitted by re-running the generator. It is never appended to the generated schema file by hand.

This keeps "Better Auth defines what the auth model must contain" true even for Loxep's own additions: a regeneration reproduces the column instead of deleting it, and the runtime instance validates and serializes the field because it is part of the model rather than a column the application happens to write behind Better Auth's back. Correspondingly, the application does not `UPDATE` auth tables directly; self-service and administrative profile writes go through Better Auth's endpoints.

Field-level validation for such columns lives at the application's validation boundary (Zod in the web layer), not in `@loxep/db`, which carries no validation dependency.

### User references never cascade-delete history

Historical domain, audit, and business data must never disappear because an auth user is removed. User-reference columns follow one of two intentional forms:

1. **Nullable FK with `ON DELETE SET NULL`** — the default for provenance columns (`created_by_user_id`, `updated_by_user_id`, `actor_user_id`) where referential integrity is useful while the user exists and anonymized provenance is acceptable afterward.
2. **Intentional non-FK historical identity reference** — where the original identifier itself is the historical fact and must survive user deletion verbatim (for example inside immutable audit payloads).

Which form each column uses is chosen deliberately in the schema; `ON DELETE CASCADE` from auth tables into domain, audit, or business tables is prohibited. Deleting a user removes authentication identity, not evidence that the user acted.

## Consequences

- One migration pipeline: a fresh database is built entirely by `loxep migrate` (ADR-0018) with no separate auth-CLI apply step at deploy time.
- Auth schema changes are visible in review like any other schema change, and drift between Better Auth's expectations and the database is caught at regeneration time.
- Audit and business history are durable across user lifecycle events; user deletion degrades provenance to NULL (or retains a historical identifier) rather than destroying records.
- The foundation schema draft's bare-`text` user columns are refined: each becomes a nullable `SET NULL` FK or a documented intentional non-FK reference.
- Loxep's own auth-table columns survive regeneration, because the generator is the thing that writes them.

## Implementation notes

`packages/db/src/auth.ts` holds the shared options builder (`buildAuthPluginConfig`) that both the CLI generation instance and `@loxep/auth`'s runtime `createAuth()` spread, so the plugin set and the additional fields cannot drift from the generated schema. `userAdditionalFields` in that file is the declared list of Loxep columns on the `user` model; today it is `displayName` (migration `0008_user_display_name`), the short self-chosen label alongside Better Auth's own `name` and `image`.

Regeneration is `bun --cwd packages/db generate:auth`, followed by `bun --cwd packages/db generate` for the migration and the usual line-by-line review. The script uses Better Auth 1.7's official `auth` package/executable (`auth generate`), not the obsolete `@better-auth/cli` package. Generated output is only the starting point: upgrades of populated installations still require an explicit append-only data transition, as migration `0033_better_auth_account_issuer` demonstrates for the 1.7 account-identity change.

That 1.6 → 1.7 transition is not rolling-compatible. Before the cutover, the operator must verify a restorable backup and register the new `<LOXEP_PUBLIC_ORIGIN>/api/auth/callback/oidc` redirect. Every process using the 1.6 auth schema must be stopped before migration `0033` runs; the migration is then applied once, and every web/worker process is started from the same 1.7 image. OIDC and magic-link sign-in are verified before the legacy callback is removed. Mixed 1.6/1.7 operation is unsupported because 1.7 reads and writes the required `account.issuer` identity component that `0033` backfills.

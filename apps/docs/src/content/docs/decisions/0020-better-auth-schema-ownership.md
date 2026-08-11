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

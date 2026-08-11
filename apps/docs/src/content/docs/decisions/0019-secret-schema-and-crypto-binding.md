---
title: "ADR-0019: Secret Schema, Versioning, and Cryptographic Binding"
---

**Status:** Accepted for foundation implementation. Refines ADR-0016.

## Context

ADR-0016 decided application-layer AES-256-GCM encryption with an external versioned root key, but three details remained unspecified and would have been resolved ad hoc during implementation:

1. Earlier drafts stored versioned ciphertext rows keyed by `unique(secret_key, version)` with no active-version pointer, making "the current secret" implicitly `max(version)` and leaving rotation-in-progress and rollback ambiguous. Consumers such as `storage_backends.secret_id` also referenced one particular ciphertext row rather than a stable logical secret.
2. Nothing bound ciphertext to its context, so ciphertext copied between records would decrypt silently.
3. The external root keyring had no defined representation, despite being a mandatory bootstrap input and a backup/restore dependency.

Structured multi-part credentials (an S3 access key + secret key) also had no stated shape; a single-FK consumer model implied two unrelated secret rows or an undocumented convention.

## Decision

### Logical secrets with explicit versions

Split secret storage into a stable logical identity and immutable ciphertext versions:

```text
application_secrets
├── id                    uuid primary key
├── secret_key            text not null unique
├── purpose               text not null
├── current_version       integer not null
├── created_by_user_id    text null
├── created_at            timestamptz not null
└── updated_at            timestamptz not null

application_secret_versions
├── secret_id             uuid not null references application_secrets(id)
├── version               integer not null
├── key_version           integer not null
├── nonce                 bytea not null
├── auth_tag              bytea not null
├── ciphertext            bytea not null
├── created_at            timestamptz not null
└── primary key(secret_id, version)
```

Consumers reference the **logical** secret (`storage_backends.secret_id → application_secrets.id`, likewise `notification_endpoints.secret_id`) and never a version row. `current_version` is the explicit active pointer; rotation writes a new version row and then moves the pointer, so rotation-in-progress and rollback are ordinary states rather than implicit `max(version)` guesses. Version rows are immutable once written.

### Connection credentials use the same pattern

Because credential history/rotation semantics matter to a connection's lifecycle, `connection_credentials` becomes the logical record and gains a versions table:

```text
connection_credentials
├── id                    uuid primary key
├── connection_id         uuid not null references connections(id)
├── credential_type       text not null
├── current_version       integer not null
├── created_at            timestamptz not null
├── updated_at            timestamptz not null
└── unique(connection_id, credential_type)

connection_credential_versions
├── credential_id         uuid not null references connection_credentials(id)
├── version               integer not null
├── key_version           integer not null
├── nonce                 bytea not null
├── auth_tag              bytea not null
├── ciphertext            bytea not null
├── expires_at            timestamptz null
├── refresh_after         timestamptz null
├── created_at            timestamptz not null
└── primary key(credential_id, version)
```

Expiry/refresh metadata sits on the version because it describes one issued token, not the logical credential slot.

### Typed encrypted credential bundles

The plaintext payload of a secret/credential is a **typed structure validated per type before encryption**, not always a bare string. An S3 credential is one atomic bundle containing the access key ID and secret access key; an OAuth credential may bundle access/refresh tokens issued together. This keeps multi-part secrets consistent under rotation and lets consumers hold a single logical reference.

### AAD binds ciphertext to its context

Every encryption operation supplies AES-256-GCM additional authenticated data derived from stable context values — record class, logical ID, version, and key version, conceptually:

```text
loxep:application_secret:<secret_id>:<version>:<key_version>
loxep:connection_credential:<credential_id>:<version>:<key_version>
```

Moving or swapping ciphertext between rows therefore fails authentication instead of silently decrypting. The exact serialization is fixed at implementation time and treated as part of the persistence format (changing it requires re-encryption).

### Defined external keyring representation

The root keyring is a small defined document, delivered preferably as a mounted file/Docker secret:

```text
active key version
key version 1 → 256-bit key
key version 2 → 256-bit key
...
```

Initial concrete form: JSON with an `active_version` and a map of version → base64-encoded 256-bit key. Rules:

- new encryptions use the active version;
- superseded key versions remain present until no ciphertext references them (verified, then removed deliberately);
- re-encryption to a newer key version is a controlled durable job, per ADR-0016;
- the keyring never lives in PostgreSQL, and backup documentation must state that a database restore without the keyring cannot recover encrypted secrets.

## Consequences

- "Current secret" is explicit state, not a query convention; rotation and rollback are auditable pointer moves.
- Consumers hold stable references that survive rotation without row churn or FK rewrites.
- Ciphertext is useless outside its originating record/version/key context.
- Multi-part credentials rotate atomically and validate before encryption.
- The keyring has a documented operational contract for delivery, rotation, and backup.
- The foundation schema draft and configuration documentation are updated to this model; the earlier single-table `application_secrets` sketch is superseded.

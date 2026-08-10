---
title: "ADR-0016: Runtime Configuration and Secret Storage"
---

**Status:** Accepted

## Context

Loxep is self-hosted and will accumulate many provider and operational settings: marketplace credentials, notification endpoints, storage settings, companion-service tokens, polling defaults, and future shipping/payment/bank integrations.

Putting these values into environment variables by default would make ordinary administration a Compose-edit/restart workflow, complicate multi-connection support, and make shared web/worker configuration harder to manage.

Some values nevertheless must exist before Loxep can read PostgreSQL-backed settings or before the first administrator can authenticate. Encryption also requires a root secret that cannot usefully protect ciphertext if it is stored beside that ciphertext in the same database.

## Decision

Use a two-layer configuration model.

### Bootstrap/deployment configuration

Environment variables, mounted secret files, or equivalent deployment configuration are limited to values that must exist before database-backed administration is available, including:

- database connectivity;
- runtime/process topology such as `LOXEP_MODE`;
- canonical application origin and other authentication bootstrap facts;
- Better Auth application/session secret;
- Loxep root encryption key/keyring;
- at least one initial OIDC and/or SMTP magic-link login path;
- first-admin bootstrap/recovery information;
- genuine deployment topology such as local filesystem mount roots.

### Database-backed runtime configuration

Normal application/provider settings are managed through authenticated Loxep UI/API flows and stored in PostgreSQL.

Secret runtime values are encrypted in the application layer with the accepted AES-256-GCM/key-versioning design. External connections continue to use connection-specific encrypted credential storage. Shared application/infrastructure secrets may use an equivalent application-secret record when they do not belong to a provider connection.

Examples that should normally be in-app rather than Compose variables include eBay/Woo/Medusa credentials, ntfy configuration, S3 credentials, polling defaults, synchronization options, and future provider/service tokens.

## Consequences

- Adding or rotating normal integrations does not require editing Compose.
- Web and worker runtimes share one current configuration through PostgreSQL.
- The root encryption key/keyring and auth/bootstrap secrets remain external deployment responsibilities.
- Settings changes can be audited and validated through application workflows.
- Plaintext secrets are never returned through general APIs or written into logs, audit snapshots, source events, or job payloads.
- Backup/restore documentation must include the external encryption key/keyring requirement.
- Phase 0 needs database-backed application settings/secret semantics in addition to connection credentials.
- At least one explicit first-admin and shell-level recovery path must exist; there is no default password or unauthenticated web configuration backdoor.

See [Configuration & Secrets](../architecture/configuration-and-secrets/) for the operational policy and examples.

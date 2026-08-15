---
title: Configuration & Secrets
---

Loxep should keep **as much day-to-day configuration as practical inside the application and PostgreSQL**. Environment variables and mounted secrets are reserved for bootstrap/runtime facts that must exist before Loxep can load database-backed settings or before any administrator can authenticate.

This distinction is important for a self-hosted application: adding an eBay account, changing an ntfy endpoint, rotating an S3 credential, or adjusting a monitor should not normally require editing Compose and restarting the stack.

## Configuration layers

Loxep has three different configuration classes.

### 1. Deployment/bootstrap configuration

This is the small set of values supplied by Compose, environment variables, or mounted secret files because the application cannot safely obtain them from its own database.

Typical examples:

- PostgreSQL connection information;
- `LOXEP_MODE=all|web|worker`;
- listen/bind/port and deployment-level process settings where needed;
- canonical/public application origin required for authentication callbacks;
- Better Auth application/session secret;
- the root/keyring used to encrypt database-stored secrets;
- at least one authentication path that works **before the first admin can sign in**;
- initial administrator bootstrap/recovery information;
- filesystem mount/root information for the `local` storage driver when that path is a deployment topology concern.

Bootstrap secret inputs should support mounted-file/Docker-secret style delivery where practical. Secret values must never be committed to repository configuration.

#### Bootstrap environment reference

The canonical bootstrap variables, validated by `@loxep/config` (`loadBootstrapConfig`):

```text
LOXEP_MODE                       optional (default: all) — all | web | worker
LOXEP_DATABASE_URL[_FILE]        required in every mode — postgres:// / postgresql:// URL
LOXEP_PUBLIC_ORIGIN              required in web/all — canonical http(s) origin
LOXEP_PORT                       optional (default: 3020)
LOXEP_AUTH_SECRET[_FILE]         required in web/all — Better Auth secret, min 32 chars
LOXEP_KEYRING[_FILE]             required in every mode — ADR-0019 keyring JSON document
LOXEP_OIDC_ISSUER                OIDC group — issuer URL
LOXEP_OIDC_CLIENT_ID             OIDC group
LOXEP_OIDC_CLIENT_SECRET[_FILE]  OIDC group
LOXEP_OIDC_EMAIL_CLAIM            optional (default: email) — id_token claim carrying the user's email
LOXEP_SMTP_URL[_FILE]            SMTP group — smtp:// or smtps:// URL
LOXEP_SMTP_FROM                  SMTP group — sender email address
LOXEP_BOOTSTRAP_ADMIN_EMAIL      optional — first-admin bootstrap identity
LOXEP_MEDIA_ROOT                 optional (default: ./data/media) — local storage root
LOXEP_LOG_LEVEL                  optional (default: info) — fatal|error|warn|info|debug|trace
```

Conventions enforced by the loader:

- any variable marked `[_FILE]` may instead be supplied as `<VAR>_FILE` pointing at a mounted secret file (trailing newline trimmed); setting both the variable and its `_FILE` variant is an error;
- the OIDC and SMTP groups are each all-or-none;
- when the mode serves web (`web`/`all`), at least one complete login group (OIDC and/or SMTP) must be configured;
- validation failures are reported as one aggregate error naming every offending variable, never echoing secret values.

### 2. Application/runtime settings

Settings that can be loaded after the database is available should generally be stored in PostgreSQL and managed through Loxep's UI/API.

Examples:

- notification preferences and ntfy configuration;
- storage backend selection and non-secret S3 configuration;
- polling defaults and monitor behavior;
- feature/runtime preferences that are not needed to boot the process;
- user dashboard/view preferences;
- integration behavior and provider-specific non-secret options;
- reporting/application defaults;
- connection display names, scopes, selected accounts/storefronts, and synchronization preferences.

A setting that affects a worker must not automatically become an environment variable. Web and worker processes share PostgreSQL and can therefore share database-backed configuration.

### 3. Runtime secrets and provider credentials

Secrets that are created or rotated during normal operation should be stored encrypted in PostgreSQL using Loxep's credential/secret service.

Examples:

- eBay API credentials, refresh/access tokens, and account credentials;
- WooCommerce/Medusa/API credentials;
- ntfy tokens where authentication is used;
- S3 access keys when S3 is configured in-app;
- shipping/payment/tax provider credentials;
- companion-service API tokens;
- future bank/provider tokens.

These values are encrypted at the application boundary using the accepted AES-256-GCM/key-versioning design with ADR-0019's context-binding AAD. The external root encryption keyring — a defined document carrying the active key version plus versioned 256-bit keys, delivered preferably as a mounted file/Docker secret — remains bootstrap configuration; storing keys beside ciphertext in the same database would defeat the boundary.

## Authentication bootstrap exception

Authentication is the main reason some integration-like configuration must remain available outside the logged-in application.

Loxep initially supports OIDC and magic-link login with password login disabled. A brand-new installation therefore needs enough configuration to authenticate the first administrator.

Initial direction:

- OIDC issuer/client configuration and its client secret may be supplied through bootstrap config; and/or
- SMTP configuration required to deliver magic links may be supplied through bootstrap config;
- at least one viable login method must be configured for a usable installation;
- an explicit bootstrap-admin mechanism grants the first deployment administrator;
- once normal administration is available, most other integrations are configured in-app.

Do not build a web-accessible unauthenticated "configure my auth secrets" screen merely to avoid bootstrap configuration.

A future implementation may allow additional OIDC/email providers to be administered from inside Loxep if Better Auth supports the required dynamic configuration safely, but an external recovery/bootstrap path should remain available so a broken database setting cannot permanently lock out the deployment owner.

## First administrator and recovery

Phase 0 must implement a concrete bootstrap/recovery path rather than leaving this to manual database editing.

Recommended behavior:

1. Deployment config identifies an allowed bootstrap administrator email/address or equivalent trusted identity.
2. The first successful authenticated login matching that bootstrap identity receives the Better Auth deployment-level `admin` role.
3. Loxep records that initial-admin bootstrap has completed and does not continuously re-grant admin solely because an environment variable remains present.
4. Shell-level recovery tooling may explicitly promote/recover an administrator for a deployment owner with server access.
5. There is no permanent hidden web backdoor or default password.

Implemented behavior (`@loxep/auth`): a Better Auth `session.create` after-hook compares the signed-in user's email case-insensitively against `LOXEP_BOOTSTRAP_ADMIN_EMAIL`; on first match it grants `admin` and records `application_settings` key `auth.first_admin_bootstrap` (`{completedAt, userId, email}`) in one transaction. The recorded completion is authoritative — later sign-ins never re-grant, even after a deliberate demotion. Shell recovery: `loxep admin promote --email=<email>` sets an existing user's role to `admin` directly in the database (worker-level configuration only; refuses unknown emails), and `loxep admin list` prints each user's id/email/role.

Right after that first administrator exists, `/dashboard/overview` shows a dismissible onboarding card offering to open OIDC auto-provisioning (below) — the discoverability vehicle for what would otherwise be a policy an operator has to already know exists. It only appears when OIDC is bootstrap-configured, provisioning for `oidc` is still closed, and the admin has not already dismissed it; dismissal is permanent and stored as the `auth.onboarding_oidc_prompt_dismissed` setting.

### OIDC email claim override

`LOXEP_OIDC_EMAIL_CLAIM` (optional, default `email`, loxep-yk8) names the id_token claim `@loxep/auth`'s OIDC `mapProfileToUser` hook reads as the account's email address, for an issuer that puts it somewhere other than OIDC's standard `email` claim (an operator-chosen claim such as `acme_email`). It is a bootstrap fact — fixed for the process, like the rest of the OIDC group — because it decides which identity a brand-new account is created with, before any database-backed policy can run. When the configured claim is absent from the profile, Loxep does not invent a value: `mapProfileToUser` returns no `email` field, and Better Auth's own standard-claim fallback and `email_is_missing` redirect take over, so the failure stays legible instead of silently creating an account with the wrong (or no) address. This override changes **which claim carries the email address only** — it has nothing to do with, and does not change, the claim-to-`admin`-role mapping below.

## Account provisioning policy

The first-admin mechanism decides *who gets `admin`*. It says nothing about *who gets an account*, and until [ADR-0024](../../decisions/0024-account-provisioning-policy/) nothing did: any address that could receive a magic link and any identity the OIDC issuer would authenticate became a `member` on first sign-in.

Provisioning policy is **runtime policy, not a bootstrap fact**, so it follows this document's own decision rule and lives in PostgreSQL as the registered setting `auth.provisioning` — not in an environment variable. That choice is forced as well as preferred: Better Auth's native `disableSignUp` options (on the magic-link plugin and on each generic-OAuth provider) are plain booleans fixed when the auth instance is constructed, so wiring them to a database value would make changing the policy a restart.

```text
auth.provisioning
├── newUsers.magicLink      'open' | 'closed'
├── newUsers.oidc           'open' | 'closed'
├── magicLinkEmailDomains   string[]   (empty = no restriction)
└── oidcAdminClaim          { claim, adminValues, applyOn }
```

The load-bearing properties:

- **It governs account creation only.** An existing user always keeps their sign-in path, whatever the policy says and whatever their email domain is. Nothing in this feature can lock an administrator out; the domain allowlist in particular is a provisioning control, never a send filter.
- **Provisioning is force-open while the installation has no `admin` user at all**, so a new deployment can always acquire its first administrator. Every path that produces one — the bootstrap email, `loxep admin promote`, or the claim mapping — closes that window behind itself. The condition is deliberately "an admin exists" rather than the `auth.first_admin_bootstrap` marker, which an installation that never sets `LOXEP_BOOTSTRAP_ADMIN_EMAIL` would never write.
- **Enforcement lives in `@loxep/auth`, at two layers.** `sendMagicLink` declines to deliver a link an unknown address could never redeem (the endpoint's response is unchanged either way, so it is not an account-existence oracle), and `databaseHooks.user.create.before` is the authoritative gate that both sign-in methods reach — `/magic-link/verify` and `/oauth2/callback/:providerId` alike. `/admin/create-user` is exempt on purpose: it is the escape hatch.
- **Closed means closed; there is no invite system.** Administrators add people directly from `/settings/users` through Better Auth's admin plugin, which creates a passwordless user row. The person then signs in with whichever method they normally would.
- **An optional OIDC claim maps to `admin`** — read from the persisted `account.idToken`, `admin` only (ADR-0017's two roles), and by default applied once at account creation so manual role edits in Loxep stay permanent. An `every_sign_in` mode makes the IdP authoritative in both directions, guarded so it never demotes the last remaining administrator and never runs in the same session as a first-admin bootstrap grant.

The shipped default is **closed for both methods**, **confirmed by owner ruling 2026-08-15 (`loxep-yk8`)**: it is the safe default for an exposed installation, and remains so even though it is a behavior change for an upgrade in place, where a colleague added next week is declined until an administrator opens the method or creates the account. The discoverability concern behind that trade-off is addressed separately, by the onboarding card described above, rather than by changing the default. See ADR-0024 for the full argument, the rejected alternatives, and the operator-facing walkthrough in [Managing access](../../guides/managing-access/).

## Database-backed settings model

Do not turn one giant untyped JSON document into the configuration system. Settings should have an owning feature/domain and typed validation.

A small shared foundation can provide semantics equivalent to:

```text
application_settings
├── key
├── value jsonb
├── schema_version
├── updated_by_user_id
└── updated_at

application_secrets
├── id
├── secret_key / purpose
├── current_version
├── created_at
└── updated_at

application_secret_versions
├── secret_id
├── version
├── key_version
├── nonce
├── auth_tag
├── ciphertext
└── created_at
```

Secrets separate a stable logical record (what consumers reference) from immutable ciphertext versions, with `current_version` as the explicit active pointer. Plaintext payloads are typed bundles validated per purpose — an S3 credential atomically carries its access key ID and secret access key — and ciphertext is bound to its record/version/key context through AES-256-GCM additional authenticated data. See ADR-0019.

This model is implemented by the `@loxep/domain` service layer: settings are declared through a typed Zod registry that validates writes before persistence and rejects unregistered keys; secret and connection-credential payloads are purpose-typed bundles (`s3_credentials`, `token`, `smtp_password`, `oauth_tokens`, `ebay_keyset`) validated before encryption; every ciphertext carries the ADR-0019 context AAD so records cannot be swapped between rows; reads decrypt the current version only; and all writes append redacted audit events that record metadata and version numbers, never values.

Feature-specific relational configuration remains preferable when it is queried or constrained like normal domain data. For example:

- external account/store settings belong on `connections` and provider-owned related records;
- their secret tokens belong in `connection_credentials`;
- user dashboard layout/preferences can use a dedicated preference model once the shape is known;
- monitor configuration belongs with monitoring targets rather than a global setting key — a monitor's query, filters, cadence, and cost bounds live on `monitor_targets`. The registered settings `monitors.defaults`, `monitors.observation_caps`, and `integration.ebay.rate_budget` are the installation-wide *defaults and safety limits* those per-target values are created from and clamped by, which is application-level configuration rather than a monitor's own state.

`application_settings` is for genuinely application-level configuration, not an excuse to avoid schema design.

## Secret-handling rules

1. Plaintext secrets are available only to the narrow service/adapter code that needs them.
2. General settings/connection APIs never serialize plaintext credentials back to the browser.
3. After a secret is saved, UI should show status/metadata such as configured, expiry, last rotation, or last validation rather than the secret value.
4. Audit events record that a secret/configuration changed but redact the secret itself.
5. Logs, job payloads, source events, error reports, and telemetry must not contain plaintext credentials.
6. Key rotation is versioned: new writes use the active root key version; existing ciphertext can be re-encrypted by a controlled durable job.
7. Backup documentation must state that restoring PostgreSQL without the external encryption key/keyring will not restore access to encrypted secrets.

## Settings changes and runtime behavior

Prefer settings that take effect without a container restart.

A typical write path is:

```text
Admin UI
   |
   v
validated server action/API
   |
   +--> update database setting/secret
   +--> append redacted audit event
   +--> invalidate/reload relevant application cache
   +--> enqueue validation/synchronization job when appropriate
```

A restart requirement is acceptable only when the underlying runtime genuinely needs it, such as changing database connectivity, bind behavior, or another bootstrap concern.

Implemented behavior for registered application settings: `/settings/application` lists every registered setting and, for an `admin`, offers a per-setting edit dialog. Because a setting's Zod schema lives in the server-side registry, the dialog submits the operator's raw JSON and the admin-gated server function is the only validator — `SettingsService.setByKey` refuses any key `defineSetting()` did not register, parses the value through that definition's schema before touching a row, writes the row stamped with the definition's `schema_version` and the acting user, and appends the `settings.create`/`settings.update` audit event with before/after in the same transaction. A schema rejection is reported back onto the dialog's field verbatim, so the operator reads the validation message rather than a generic failure. No restart is needed: the worker's settings reader (`@loxep/app`) memoizes a resolved snapshot for ~15 seconds, so a saved change is picked up within seconds.

## Storage configuration

Storage illustrates the boundary well:

- the local filesystem mount/path is partly a deployment topology concern and can be bootstrap configuration;
- choosing `local` versus `s3` can be application-managed once the database is available;
- S3 endpoint, region/bucket, addressing options, and migration state can live in PostgreSQL;
- S3 access/secret keys are encrypted runtime secrets;
- changing storage backends uses the supported storage-migration workflow instead of hand-editing object references.

Other encrypted runtime secrets follow the same shape. The provider application keyset an installation registers once — for eBay, the developer-portal app ID/cert ID/dev ID plus its RuName and target environment — is a single typed bundle stored under a stable key by convention `integration.<provider>.keyset` (`integration.ebay.keyset`, purpose `ebay_keyset`); per-connection user tokens obtained through that keyset live separately in `connection_credentials`. When no stored secret exists, the eBay keyset resolver falls back to the local development file `~/.config/loxep/ebay-sandbox.env` for sandbox bring-up only — the stored secret always takes precedence once it is set, and the Integrations/Connections UI labels a dev-file keyset distinctly from a stored one so a fresh install with an empty database is never mistaken for a configured one.

RustFS remains only the initial recommended self-hosted S3 companion. Loxep stores generic S3 semantics rather than RustFS-specific configuration throughout the domain model.

## External connections

Provider connections are not environment variables.

Creating an eBay/WooCommerce/Medusa account connection should be an authenticated application workflow:

```text
connection
├── provider / kind
├── external account identity
├── non-secret provider configuration
├── health / sync state
├── optional economic-entity attribution
└── encrypted credential versions
```

Multiple connections for the same provider are normal. Application users, provider accounts, and economic entities remain separate concepts. Per ADR-0017 there is no per-connection user authorization: all installation members have ordinary product access, and `created_by_user_id` is provenance, not ownership.

## Decision rule

When adding a new setting, ask in this order:

1. **Is it required before PostgreSQL can be reached or before an administrator can authenticate?** Use bootstrap environment/mounted-secret configuration.
2. **Is it sensitive but normally created/rotated while Loxep is running?** Store it encrypted in PostgreSQL.
3. **Is it ordinary runtime/domain configuration?** Store it in a typed database-backed model and expose it through authenticated administration.
4. **Is it actually deployment topology rather than product configuration?** Keep it with Compose/runtime configuration.

The default answer for normal provider/business/application settings is **in-app and database-backed**, not "add another environment variable."

---
title: Infrastructure Control Plane Design (Phase 7)
---

This document is the physical schema and reconciler design for [Phase 7 — Infrastructure control plane](../../product/roadmap/#phase-7--infrastructure-control-plane). It stands in the same relationship to Phase 7 that [Commerce Schema Design (Phase 3)](../commerce-schema-design/) stands in to Phase 3: a concrete migration target with table sketches, constraints, and the reasoning behind them, written before any migration exists.

It **extends** the foundation. Where an existing table, convention, or ADR already answers a question, that answer is reused rather than restated differently. Nothing here changes an already-implemented table, and nothing here references a table owned by Phases 3 through 6 — this is the first designed phase with **no coupling to any commercial domain at all**.

**Implementation status — all three milestones are IMPLEMENTED and PROVISIONAL (loxep-lmy.1, loxep-lmy.2, loxep-lmy.3).** What shipped, what diverged, and what the owner still has to decide:

- **Migration `0012_infrastructure_control_plane`** creates seven of the twelve tables — `hosting_targets`, `managed_domains`, `dns_records`, `reconcile_runs`, `reconcile_run_steps`, `dns_drift_findings`, `provider_operations` — this page's [ordering](#ordering) steps 1, 2, 4, 5, 6, 7. No existing table gained a column. Mail (steps 3, 9) and the token pair (step 8) are untouched.
- **`@loxep/integration-cloudflare`** implements zones and DNS records: the five-kind taxonomy duplicated per ADR-0009, a per-connection rate budget, per-response redactors, and `read` / `apply` / `capabilities`. Every endpoint, bound, and vocabulary was verified against developers.cloudflare.com and the official `cloudflare/api-schemas` OpenAPI document on 2026-08-13; seven facts that could not be confirmed are marked UNVERIFIED in the source. Two of this page's assumptions were **falsified** by that check and are corrected below. **Token mint/roll/policy endpoints are NOT implemented here** — milestone 3's `tokens.ts` is built against a structurally re-declared `DnsTokenProviderPort` (`token-port.ts`) with no adapter wired to it yet; see the milestone 3 entry below.
- **`@loxep/infrastructure`** implements the materializer, the pure diff, the reconcile run, drift persistence, the intent services, and the idempotency ledger; its 89 tests pass. **The composition-root wiring now ships too**: `packages/app/src/cloudflare.ts` (a per-connection `cloudflare_credentials`-backed adapter factory, mirroring `woo.ts`) and `packages/app/src/infrastructure-poll-executor.ts` (the `infrastructure_domain_reconcile` route, hard-coded to `mode: 'check'` — the recurring sweep is always drift detection; an `apply` run is an operator action, never something the scheduler decides) are routed in `registry.ts`'s `createRoutedPollExecutor`, the third registrant alongside `woo_orders`/`ebay_orders` and `etsy_listing`/`etsy_shop`.
- **Owner-review gates, resolved PROVISIONAL, each per its own recommendation:** [OQ2](#open-questions) (the CAA setting `infrastructure.caa_policy` ships **with no default issuer list** and the materializer emits no CAA record until an operator marks it reviewed), OQ3 (unexpected records are never auto-deleted — held permanently), OQ4 (a `pending` `provider_operations` row is resolved by **reading the provider back**, never by a blind retry), OQ5 (one target type, `infrastructure_domain_reconcile`, on the shared scheduling model, with `managed_domains.reconcile_target_id` as a real foreign key). OQ7 is implemented per its recommendation too: the natural-key unique covers tombstones and the materializer resurrects. **OQ1 (secret readback) is untouched** — nothing implemented needs it.
- **Documented divergences from this page's sketches**, both surfaced rather than drifted:
  1. **`dns_records.owner` gains a sixth value, `caa`.** This page lists five owners and no `caa`, yet its [materialization rules](#record-materialization) say a CAA set is always emitted. Labelling those records `apex` would be actively wrong — `apex` means "materialized from `apex_target_id`", and a mail-only domain has no apex target while still wanting a CAA policy, so the reconciler would delete a domain's certificate-issuance policy whenever an operator cleared an unrelated field.
  2. **The credential bundle is registered as `cloudflare_credentials`, not `dns_provider_credentials`.** Every sibling in `@loxep/domain`'s registry is provider-named (`woo_credentials`, `medusa_credentials`, `invoiceninja_credentials`, `ebay_keyset`, `etsy_keyset`), and a second DNS provider will not necessarily authenticate with a single bearer token — a role-named bundle would then fork or become a loose union, which is the half-configuration hazard ADR-0019 bundles exist to prevent.
- **Two provider assumptions on this page are now known to be wrong**, and are corrected where they appear: proxied wildcard records are available on **all** Cloudflare plans today (they are no longer plan-gated), and the design's worry about `ttl` is confirmed exactly — `1` means "automatic" and is translated to `NULL` at the adapter boundary in one place.
- Still open, unchanged: [OQ6](#open-questions) (is `provider_operations` promotable to shared foundation), OQ8 (registrar adapters), OQ9 (run-step retention), OQ10 (live plan verification — **no Cloudflare token exists yet**, so every live check in this milestone is owner-gated and its `live-cloudflare.test.ts` skips cleanly).

### Milestone 2: mail hosting (loxep-lmy.2)

- **Migration `0013_infrastructure_mail`** creates this page's remaining mail tables — `mailbox_templates`, `mailbox_template_entries`, `mail_domains`, `mailboxes` — its [ordering](#ordering) steps 3 and 9, and adds the one constraint milestone 1 deferred by name: `managed_domains.mailbox_template_id` gains its foreign key. Eleven of the twelve tables now exist; only the milestone-3 token pair is outstanding. No existing table gained a column.
- **`@loxep/integration-purelymail`** implements domains, ownership codes, mailboxes, and routing rules behind the same five-kind taxonomy, per-connection rate budget, and per-response redactors ADR-0009 requires. Because the API is RPC-shaped — every operation is a `POST` to `/api/v0/<name>` with a JSON body — the adapter is **one generic call function plus one exported map of all nineteen operation names**, so a wrong name is a one-line fix. Every name is transcribed from the provider's OpenAPI document (`news.purelymail.com/api/swagger-spec.js`, `info.version` 0.0.1, retrieved 2026-08-13) and marked UNVERIFIED until exercised against a live account.
- **`@loxep/infrastructure`** gains the mail intent services (`mail.ts`), the structurally re-declared mail provider contract (`mail-port.ts`), and the resumable mail reconciler with the delegation gate (`mail-sync.ts`). **`@loxep/app`** registers three tasks — `ensure-mail-domain`, `poll-mail-ownership`, `sync-mailboxes` — plus a per-connection Purelymail adapter factory mirroring `cloudflare.ts`.
- **The required DNS record set is VERIFIED, and this page was right to refuse to list one.** From `purelymail.com/docs/domainDocs` on 2026-08-13, seven records, every one unproxied, materialized with `owner = 'mail'`:

  ```text
  MX     @                       mailserver.purelymail.com     priority 50
  TXT    @                       v=spf1 include:_spf.purelymail.com ~all
  TXT    @                       <ownership code>              per ACCOUNT
  CNAME  purelymail1._domainkey  key1.dkimroot.purelymail.com
  CNAME  purelymail2._domainkey  key2.dkimroot.purelymail.com
  CNAME  purelymail3._domainkey  key3.dkimroot.purelymail.com
  CNAME  _dmarc                  dmarcroot.purelymail.com
  ```

  Three of those would have been guessed wrong. There are **three** DKIM keys, not one — the provider signs with one of three and rotates them, so publishing a single key produces mail that verifies two thirds of the time. `_dmarc` is a **`CNAME`**, not the `TXT` policy string almost every other provider publishes, so "correcting" it to a `TXT` is the plausible edit that breaks reporting. And the ownership code is per **account**, not per domain: `getOwnershipCode` takes an empty request body, so one published value proves every domain in the account.

  Purelymail's own Cloudflare instructions independently state this page's never-proxy invariant, for each DKIM record and for DMARC: *"click on the cloud on 'Proxy Status' and set it as DNS only (this is very important)"*. The constraint is now enforced in three places — the adapter, the materializer, and the schema `CHECK` — and the provider agrees with all three.
- **HTTP 200 does not imply success here, and that is LIVE-VERIFIED rather than defensive.** Milestone 1 noted that no Cloudflare documentation confirms a 200 can carry `success: false`. Purelymail settles the question: two unauthenticated probes on 2026-08-13 answered **HTTP 200** with `{"type":"error","code":"invalidToken"}`. An adapter branching on `response.ok` would have treated a completely unauthenticated call as a success. The `type` discriminator is **absent from the published OpenAPI document**, which models every 200 as `{result}` and defines an unreferenced `Error` schema — so the document alone would have produced the wrong implementation, and the adapter tolerates both shapes.
- **The delegation gate is implemented and tested as the load-bearing thing this page says it is.** `isDelegationConfirmed` reads evidence (`delegation_verified_at`, or the DNS provider's verbatim `provider_zone_status = 'active'`), never `state`. A gated run makes **zero** provider calls, does not increment `verify_attempts` or `consecutive_errors`, and finishes **`succeeded`** — correctly waiting for a human at a registrar is a success, and recording it as a failure would light up every health indicator in the product for a condition that normally lasts days. A registration the provider then refuses with `invalid_request`/`not_found` is also not an error: it increments the attempt counter, records the message, finishes `partial`, and the next run tries again. Only `auth`/`rate_limited`/`provider_unavailable` fail the run. Collapsing those two classes is what produces a workflow that looks broken for three days and then works.
- **`mailboxes.secret_id` ships write-only, and ADR-0022 turns out not to reach this mint.** The generated password is written to `application_secrets` under this page's own `infrastructure.mailbox.<id>` convention with a new `mailbox_password` bundle purpose. No reveal server function, route, or UI exists, and `MailboxSecretWriter` — the port the reconciler writes through — has **no read member at all**, so revealing one would require visibly widening an interface.

  [ADR-0022](../../decisions/0022-minted-secret-reveal/) (PROVISIONAL) resolved [OQ1](#open-questions) while this milestone was being built: *"reveal-once at mint time; write-only forever after"*, with the plaintext shown to the requesting admin **exactly once, in the response to the creating action**. **That channel is structurally unavailable here, and the gap is worth naming rather than discovering in milestone 3.** Loxep mints a mailbox password inside `infrastructure.sync-mailboxes` — a worker job that runs whenever delegation and ownership verification finally complete, which may be days after the operator declared the mailbox and with nobody waiting on it. There is no requesting admin, no response, and no tab to show a value in. So ADR-0022 clause 1 has nothing to fire into, clause 2 applies from birth, and clause 4's remedy is the only one available: a lost password is a **rotation**, never a recovery.

  The consequence for milestone 3: a UI that wants the one-time reveal must **move the mint into a request-scoped admin action**, not add a read-back to this purpose. Reading a stored value later is exactly what clause 2 forbids, and the two are easy to confuse because they produce the same pixels.
- **No new scheduling target type, per this page's own rule.** Ownership verification appears in the [cadence section](#where-recurring-cadence-lives--and-the-commerce-precedent)'s `bounded poll` row, which that section states is *not* scheduling. It is self-terminating — it ends when the domain verifies, once — so a `monitor_targets` row would leave a permanent cadence per domain watching for an event that already happened. `@loxep/market` is untouched and the third-registrant question OQ5 raises is not made fourth.
- **Documented divergences and additions**, both surfaced rather than drifted:
  1. **The credential bundle is `purelymail_credentials`, not `mail_provider_credentials`**, following milestone 1's precedent and this page's own note that *"milestones 2 and 3 should follow the provider-named form too"*. Purelymail is also the first provider with **no non-secret half at all** — it exposes no account identifier, so `connections.config` carries nothing and `sourceAccountKey` is not unique across two tokens against the same host. Recorded because nothing may treat that key as an identity.
  2. **`mail_domains` and `mailboxes` gain constraints this page's sketches do not list**, all strengthening: `mail_domains` refuses a verification that precedes registration, `mailboxes` carries the same kind/`forward_to` biconditional the sketch gives `mailbox_template_entries`, and `mailboxes`' unique covers tombstones so a re-declared address resurrects — [OQ7](#open-questions)'s resolution applied to the table that shares `dns_records`' shape.
- Owner-gated, unchanged in kind from milestone 1: **no Purelymail API key exists yet**, so every operation name stays UNVERIFIED and `live-purelymail.test.ts` skips cleanly. Unlike Cloudflare there is no read-only credential to ask for — Purelymail has **no token scoping at all**, one account token carries every operation including `deleteDomain` — so the live leg's safety comes from its call list (four reads, no writes) rather than from the credential.
- **The apps/web piece both milestones deferred now ships too.** `/settings/integrations` gained an `Infrastructure` category with a Cloudflare and a Purelymail entry; `/settings/connections` gained their guided "Add account" forms — token-only (both adapters talk to a fixed, provider-owned endpoint, so there is no store-URL-style field), Cloudflare's account id kept optional and non-secret, Purelymail's config staying empty since it has no account identifier at all. Both forms write through `createStoreConnection` (`apps/web/src/server/admin-functions.ts`), the same guided-creation path Woo/Medusa/Invoice Ninja already use, into the `cloudflare_credentials`/`purelymail_credentials` bundles. New guides: [Connecting Cloudflare](../../guides/connecting-cloudflare/) and [Connecting Purelymail](../../guides/connecting-purelymail/), the latter carrying the never-proxy DNS record set from this page's own milestone-2 verification. No `/infrastructure` workspace route exists yet and no per-connection "Validate" action was added — neither exists for any sibling provider's connection today, so there was no established shape to mirror.

### Milestone 3: fleet, token scope, and the `/infrastructure` workspace (loxep-lmy.3)

- **Migration `0016_infrastructure_tokens`** creates the design's last two tables — `dns_provider_tokens` and `dns_provider_token_zones`, this page's [ordering](#ordering) step 8. All twelve tables this page names now exist. No existing table gained a column; `hosting_targets.proxy_connection_id` was already usable as of migration 0012, and nothing here alters it. `dns_provider_tokens` deliberately carries **no `created_by_user_id`** — the inherited-conventions section names only `managed_domains` and `hosting_targets` as needing an ADR-0020 user reference, and this is not one of them; who minted a token is `audit_events`' fact.
- **`@loxep/infrastructure`** gains `tokens.ts` (mint, zone-scope intent, roll, and the idempotent policy sync) and `token-port.ts` (`DnsTokenProviderPort`, `TransactionalDnsTokenSecretWriter`, both structurally re-declared per ADR-0009 #5 — this package takes no dependency on any DNS integration package). Its test suite is now 227 tests (up from 89 at milestone 1), including a dedicated atomicity test that kills a mint mid-transaction and proves no `dns_provider_tokens` row survives without its secret.
- **The HARD CONSTRAINT this milestone exists to prove holds, proven rather than merely stated:** minting and rolling are REQUEST-SCOPED ADMIN SERVER ACTIONS, never worker jobs. `tokens.ts`'s `mint`/`roll` call the provider synchronously and return the plaintext in their own return value; `tasks.ts` lists only `infrastructure.sync-token-policy` (the idempotent, re-runnable half) — there is no `mint-token` or `roll-token` task anywhere in the job graph, and the module doc says so explicitly so a future edit does not "helpfully" enqueue one.
- **The value is captured atomically via a nested savepoint, not a second transaction.** `TransactionalDnsTokenSecretWriter` takes the caller's transaction handle as its first argument; `apps/web/src/server/admin.ts` wires it as `(tx, input) => createSecretsService({ db: tx, keyring }).setSecret(input)`, so `@loxep/domain`'s own internal `db.transaction(...)` becomes a Postgres SAVEPOINT nested inside `tokens.ts`'s outer transaction — the same shape `TransactionalEnqueue` uses for the same reason.
- **Open question 4's token case, implemented exactly as recommended:** a token create is ledgered through `provider_operations`, and a `pending` row is NEVER retried — there is no way to read the provider back for "is this the token my crashed attempt made" without already knowing its id, so an ambiguous mint surfaces as an operator decision (check the provider dashboard; retry under a different name). Rolling is deliberately **not** ledgered the same way: it always targets an existing, uniquely identified token, and repeating it is always a safe, intentional remedy for a lost value — ledgering it would block that remedy on a stale "already succeeded" row.
- **Scope editing and token rolling are kept apart everywhere they appear**, per the design's explicit instruction: `setZones` enqueues a cheap, instant `sync-token-policy`; `roll` is styled destructively in the UI (an `AlertDialog` confirm, `variant='destructive'`) and requires its own action.
- **The fronting-chain guard is exercised, not re-implemented.** `targets.ts`'s one-hop rule shipped in milestone 1; the fleet surfaces read and display it.
- **The `/infrastructure` workspace ships**, following [Frontend Standards](../../development/frontend-standards/) throughout: `overview` (Suspense loader + `useSuspenseQuery` on one combined DTO), `domains` (DataTable list; detail with the DNS drift panel — per-row adopt/dismiss — and the mail panel), `domains/new` (the wizard: writes intent and enqueues, then redirects, never awaiting a provider call), `fleet` (DataTable list; detail with the tokens panel, the mint dialog, and a read-only companion-links panel over `resource_links`/`external_resources`), and `runs` (DataTable list; detail with steps and a retry action). The mint dialog's reveal is a dedicated `RevealOnceDialog` component: a copy button, an explicit "you will not see this value again," and no control anywhere that could be mistaken for a re-fetch.
- **What did NOT ship, and why it is a real gap rather than a silent one:** `@loxep/integration-cloudflare` has no token mint/roll/policy endpoints yet — only zone/record/read, per the milestone-1 note above. `mint`/`roll`/`syncPolicy` are wired in `apps/web/src/server/admin.ts` to a stub `DnsTokenProviderPort` that fails honestly with the `provider_unavailable` taxonomy kind (the same shape a real outage would produce) until that adapter work lands; `setZones`/listing work fully against real data today. Reverse-proxy/tunnel provider integration (`@loxep/integration-pangolin`'s org/site/resource model, the `infrastructure.sync-proxy-resource` task's SERVICE, and `hosting_targets.proxy_connection_id` actually driving anything) is out of this milestone's delivered scope — `sync-proxy-resource`'s task name and payload shape are reserved in `tasks.ts` so that concurrently-scoped work has a fixed contract to land into. `sync-token-policy` is registered in `@loxep/app`'s `registry.ts` (via `infrastructure-token.ts`, whose task wraps only `syncPolicy` — mint/roll stay request-scoped per ADR-0022, structurally never jobs); `sync-proxy-resource` is deliberately **not** registered, so an accidental enqueue fails loudly as an unrecognized task until the Pangolin integration lands the service it belongs to.
- **New `@loxep/domain` bundle purpose**: `dns_edit_token` (`{ token }`), the minted-per-host-token analogue of `mailbox_password`, distinguished from `cloudflare_credentials` (a credential Loxep USES) the same way `mailbox_password` is distinguished from `smtp_password`.

Everything below remains the specification for the parts of this design no milestone has touched, and continues to describe the reasoning behind what shipped. Exact column types, constraints, and provider endpoint behavior must be re-verified against current upstream sources immediately before implementing anything that still reads as a sketch, per the [dependency policy](../../development/dependency-policy/) — milestone 2 did exactly that and found three facts a remembered value would have got wrong. Several [open questions](#open-questions) are marked **OWNER-REVIEW-CRITICAL** because they are unrecoverable once a zone, a token, or a mailbox exists at a live provider.

**Phase 7's migration depends on nothing but the foundation.** It can ship whenever it is wanted, before or after any other phase, and it must never become a prerequisite for one.

## The non-goal this design runs against

This has to come first, because the strongest documented objection to this phase is in Loxep's own documentation.

The [Master Domain Map](../../product/master-domain-map/#what-loxep-is-not) states that Loxep should not become **an infrastructure management platform**. [Principle 18](../principles/#18-integrate-before-rebuilding-mature-specialist-products) says integrate before rebuilding mature specialist products. [Companion Services](../../product/companion-services/#infrastructure-operations) already names container management, terminal access, metrics, uptime, and private networking as *recommended companion tools*, not Loxep features. A design that quietly ignored all three would be exactly the "quietly choose the easiest default and make the documentation false afterward" failure the [Implementation Contract](../../development/implementation-contract/#documentation-discipline) forbids.

The line this design draws is narrow and should be judged on whether it holds:

```text
Loxep OWNS          declared intent for names and DNS, and the reconciliation
                    of that intent against the providers that hold it

Loxep OBSERVES      provider state, the diff against intent, and delegation status

Loxep LINKS         container management, host/container metrics, uptime probing,
                    terminal access — through external_resources / resource_links
                    and the integration-health model, never reimplemented

Loxep NEVER OWNS    configuration management, image builds, deployment pipelines,
                    provisioning of servers, or anything that runs ON a host
```

The argument for owning the first row, and only the first row:

1. **No companion tool owns declared DNS intent on the operator's behalf.** Metrics, uptime, and container tools each have a mature self-hosted answer that Loxep should link to. "What records *should* exist across several zones, and does reality match" has no companion in the recommended stack. The gap is real, not manufactured.
2. **It is the same shape Loxep already implements four times over.** A provider account, an encrypted credential, an adapter that stops provider types at the boundary, a normalized fact, an idempotent worker job, and a diff against observed state — this is the eBay/WooCommerce/Medusa/Invoice Ninja pattern pointed at a different class of provider. It adds no new architectural primitive.
3. **The blast radius is bounded by the schema.** Nothing in this design can restart a container, reboot a host, or run a command. Its entire vocabulary is DNS records, mail registration, and hostname routing.

What would falsify the line: if a milestone proposes SSH, a command runner, container lifecycle, or configuration management, that milestone is out of scope and the non-goal wins. This is worth restating in review rather than assuming.

## Scope

Phase 7 adds the physical tables required to hold desired state for the installation's own operational estate and reconcile it against the providers that actually hold that state:

- `managed_domains` — one domain name Loxep manages, with its provisioning position and its hosting/mail intent;
- `dns_records` — the **desired** DNS state for a domain, with the ownership marker that says who may rewrite each row;
- `dns_drift_findings` — the persisted output of a read-only reconcile: what the provider has that intent does not describe, and vice versa;
- `hosting_targets` — a node, a tunnel-connected host, or a bare server that a name can point at;
- `dns_provider_tokens` and `dns_provider_token_zones` — a credential the control plane *mints for a host*, plus the zone-scope intent that credential should cover;
- `mail_domains` — mail-provider registration and ownership-verification state for a domain;
- `mailbox_templates` and `mailbox_template_entries` — the data-driven standard address set;
- `mailboxes` — the intended mailboxes and aliases for a domain;
- `provider_operations` — the outbound idempotency ledger that stops a crashed worker from creating a second zone;
- `reconcile_runs` and `reconcile_run_steps` — what the reconciler did, step by step, redacted.

Twelve new tables. **No existing table gains a column.** See [Migration plan sketch](#migration-plan-sketch) for the argument.

The domain is **Infrastructure**, newly added to [Domain Boundaries](../domain-boundaries/#infrastructure). It surfaces in the `/infrastructure` workspace reserved by [Workspaces & Navigation](../../product/workspaces/#infrastructure-is-a-future-peer-root-and-it-is-about-the-installation-itself). Workspace UX is not domain ownership; the credentials this domain consumes are administered under `/settings` like every other provider's.

## What Phase 7 does not create

```text
servers, images, containers, deployments                out of scope permanently — see the non-goal above
command execution, SSH, configuration management        out of scope permanently
certificate issuance or private key custody             ACME is the reverse proxy's job; Loxep declares CAA and stops
registrar API adapters                                  deferred; `registrar` is a denormalized text note (see below)
metrics, uptime probes, container health                companion tools; linked, not owned
per-record or per-host ACLs                             still none (ADR-0017); membership stays installation-wide
economic-entity attribution on any table here           deliberately absent (see below)
money, cost, or billing columns                         a hosting bill is an Expense; this domain has no prices
a second scheduler                                      the shared scheduling model is reused (see below)
a second secret store                                   ADR-0019 records are reused (see below)
a general policy or rules engine                        materialization is a pure function with a fixed rule set
```

## Specification-to-house-rule reconciliation

The owner's specification describes the architecture — desired state in PostgreSQL plus a reconciler with diff/apply and drift detection — and states that its concrete types are indicative. Every place its sketch collides with an existing Loxep rule is resolved here, with the resolution and the rule that forced it.

| Specification sketch | House rule | Resolution |
| --- | --- | --- |
| `pgEnum` for control surface, domain state, record owner, secret kind | Contract: *"Application/domain state uses text + TypeScript unions/constants, with DB checks where useful; avoid PostgreSQL enums initially"* | All four become `text` with an application-owned union. `CHECK` on the Loxep-owned closed sets; none on protocol-extensible ones. [Details](#state-values-are-text-with-checks-only-where-the-set-is-genuinely-closed) |
| A new `secrets` table with `ciphertext`/`nonce`/`auth_tag`/`key_version`, keyed from a dedicated environment variable | ADR-0019 already defines logical secrets plus immutable versions with context-binding AAD; ADR-0016 puts the keyring in `LOXEP_KEYRING` | **Table deleted.** Reuse `application_secrets`/`application_secret_versions` and `connection_credentials`/`connection_credential_versions`. [Details](#credentials-secrets-and-the-reveal-problem) |
| A new `secret_access_log` table | Foundation already owns `audit_events` as append-oriented evidence with actor, action, resource, and redaction | **Table deleted.** A reveal writes an `audit_events` row before returning. [Details](#three-ledgers-and-why-none-of-them-is-audit_events-alone) |
| Provider tokens supplied by environment/deployment configuration | Contract: provider connections are created in-app, never Compose environment variables | Each provider account is a `connections` row with an ADR-0019 credential bundle, created through the integrations catalog and `/settings/connections`. [Details](#credentials-secrets-and-the-reveal-problem) |
| `domains.cf_account_id` as a column | Non-secret provider account identity belongs on the connection, exactly like a store URL | Column removed; `managed_domains.dns_connection_id` references the connection, whose `config` carries the account identifier. [Details](#managed_domains) |
| A reconciler enqueuing per-domain sync jobs | ADR-0013 worker topology; contract forbids one permanent cron per monitored item; jobs are at-least-once and handlers must be idempotent | Event-driven reconciles are transactional `addJob` calls with job keys; recurring cadence registers **one target type** against the shared scheduling model. [Details](#the-reconciler-jobs-scheduling-and-idempotency) |
| Provider endpoint shapes, policy payloads, and RPC envelopes inline in the data model | ADR-0009 #5: provider SDK types do not become canonical domain types | All provider shapes live in `packages/integrations/{cloudflare,purelymail,pangolin,...}`; this domain sees Loxep-owned types only. [Details](#provider-adapters) |
| `ttl` defaulting to `1` meaning "automatic" | Same ADR-0009 rule — `1` is one provider's encoding, not a fact about DNS | `ttl_seconds integer null`, where `NULL` means "provider default"; the adapter translates. [Details](#dns_records) |
| Drift detection as `applyDiff: false` with results implied | Cross-domain rule 4: derived state identifies the source facts it came from | Same code path, and findings **persist** in `dns_drift_findings` rather than living in a log line. [Details](#drift-detection) |
| `degraded` as a domain state plus a `last_good_state` shadow column | `connections` already models health orthogonally (`last_error_at`, `last_error_code`); `monitor_targets` adds `consecutive_errors` | `degraded` is **not a state**. Position in the chain and health are separate columns; "degraded" is a derived display. [Details](#provisioning-state-and-why-degraded-is-not-a-state) |
| `runs` / `run_steps` with `request_summary` / `response_summary` jsonb | Raw payloads live only at explicit provenance boundaries and must be redacted | Kept, renamed, and constrained: summaries are **redacted structures produced by a per-adapter redactor**, following the ADR-0021 `redact*` precedent. [Details](#three-ledgers-and-why-none-of-them-is-audit_events-alone) |
| `vps` table with provider/region/IP | Naming; and the concept covers more than a VPS | Renamed `hosting_targets`; the self-reference is generalized to `fronted_by_target_id`. [Details](#hosting_targets) |
| Fleet and domain records as free-standing installation objects | ADR-0017: economic entities are attribution, not containers | Confirmed and made explicit: **no `economic_entity_id` on any table here**. [Details](#economic-entities-none-deliberately) |
| A secrets vault UI with reveal and copy | Configuration & Secrets rule 2: general APIs never serialize plaintext back to the browser | **Unresolved rule conflict.** A minted host token is useless unless a human can read it once. Requires an ADR. [OWNER-REVIEW-CRITICAL](#open-questions) |

Two specification points needed no reconciliation because Loxep already requires them independently: **plaintext must never enter a job payload** (Configuration & Secrets rule 5 — pass the secret's id and resolve inside the task), and **intent change plus job enqueue must commit atomically** (the transactional-enqueue property is why ADR-0003 chose Graphile Worker). Both are restated below because both are easy to violate silently.

## Conventions inherited from the foundation

Nothing below invents a convention. From the [Foundational Data Model](../foundational-data-model/) and the [Implementation Contract](../../development/implementation-contract/):

- UUID primary keys with `defaultRandom()`; provider identifiers are stored separately as text and never become Loxep keys;
- all instants are `timestamptz` with semantic names (`delegation_verified_at`, `last_reconciled_at`, `first_detected_at`);
- state columns are `text` with application-owned TypeScript unions, never PostgreSQL enums;
- `CHECK` constraints only for genuinely closed, Loxep-owned sets, plus cross-column invariants — the precedent is `check((fee_scope = 'line') = (order_line_id is not null))` on `order_fees`;
- user-reference columns follow ADR-0020: nullable FK to the Better Auth user id with `ON DELETE SET NULL`. Only `managed_domains.created_by_user_id` and `hosting_targets.created_by_user_id` need one;
- no credentials, tokens, or secret material appear in any of these tables (ADR-0019). Every credential is a *reference* to a logical secret record;
- raw provider JSON lives only at explicit provenance boundaries and is redacted where it crosses one. None of these tables carries a free-form attribute `jsonb` column;
- **no money columns anywhere.** Infrastructure has no prices. A hosting bill is an `expenses` row in Phase 5, attributed through the allocation model that already exists.

**No table here is a Timescale hypertable.** The precedent is Phase 3's: Timescale is for genuinely temporal observation streams, and a DNS record is a statement of intent, not a sample. Drift findings are *state with a lifecycle*, not a time series — they are superseded, not accumulated.

### State values are text with `CHECK`s only where the set is genuinely closed

The specification sketches four `pgEnum`s. The contract forbids them. The replacement is not uniform, because the four sets are not the same kind of thing:

```text
managed_domains.state       text + union + CHECK    Loxep-owned; written only by the reconciler
dns_records.owner           text + union + CHECK    Loxep-owned; decides what sync may rewrite
hosting_targets.control_surface  text + union + CHECK   Loxep-owned taxonomy
reconcile_runs.status       text + union + CHECK    Loxep-owned closed set
dns_records.type            text + union, NO CHECK  DNS RR types are an IANA registry, not a closed set
mail_domains / mailboxes kind   text + union, NO CHECK  provider-extensible
```

`dns_records.type` is the interesting one. A `CHECK` listing `A | AAAA | CNAME | MX | TXT | SRV | CAA` looks safe and is not: the IANA resource-record registry has dozens of entries, and a materializer that needs `HTTPS` or `TLSA` next year would fail a constraint rather than write a record. This is exactly the reasoning Phase 3 used for provider-extensible order statuses.

`managed_domains.state` gets a `CHECK` for the opposite reason: it is a state machine only the reconciler writes, and a constraint there is protective rather than restrictive. Widening it is a migration, which is appropriate for a change to a state machine.

The specification's `secret_kind` enum disappears entirely: purpose is already a closed, validated vocabulary in `@loxep/domain`'s bundle registry, and adding a purpose there is a typed code change, not DDL.

## The desired-state model

### `managed_domains`

One domain name the installation manages. The name is the natural key and is globally unique in the world, so it is unique here too — the precedent is `catalog_items.unique(sku)` being installation-wide rather than scoped.

```text
managed_domains
id                        uuid primary key
name                      text not null
dns_connection_id         uuid not null references connections(id)
registrar                 text null
state                     text not null
external_zone_id          text null
zone_nameservers          text[] null
provider_zone_status      text null
delegation_verified_at    timestamptz null
apex_target_id            uuid null references hosting_targets(id)
apex_proxied              boolean not null default true
wildcard_proxied          boolean not null default true
mail_enabled              boolean not null default true
mailbox_template_id       uuid null references mailbox_templates(id)
last_reconciled_at        timestamptz null
drift_detected_at         timestamptz null
last_error_at             timestamptz null
last_error_code           text null
consecutive_errors        integer not null default 0
notes                     text null
created_by_user_id        text null references user(id) on delete set null
created_at                timestamptz not null
updated_at                timestamptz not null
unique(name)
unique(dns_connection_id, external_zone_id) where external_zone_id is not null
check(state in ('draft','zone_created','awaiting_delegation','zone_active',
                'records_synced','mail_pending','ready'))
```

Notes:

- **`dns_connection_id` replaces the specification's `cf_account_id`.** The DNS provider account is a connection like every other provider account: it has account identity, health state, credential versions, and "more than one is normal". Its non-secret account identifier lives in `connections.config`, exactly as a WooCommerce store URL does and for the same reason — it must stay readable without a decryption round-trip. This also makes multi-account and multi-provider support fall out for free rather than needing a redesign.
- `not null`, deliberately. A domain Loxep cannot reach is not a domain Loxep manages; there is no useful "unmanaged domain" record in this phase. If a notes-only registry is ever wanted, it is a different table.
- **`apex_target_id` is nullable and that is a first-class shape, not an edge case.** A mail-only domain — no hosting, mail enabled — must be fully supported, because that is the common case for a portfolio of names. `mail_enabled` is therefore never derived from `apex_target_id`; the specification is explicit about this and it is correct.
- `registrar` is a **denormalized text note**, not a foreign key to a registrar record, and there is no registrar adapter in this phase. The precedent is `acquisitions.vendor_name`: a name Loxep records but does not integrate with. Delegation is verified by reading the DNS provider's own zone status, which is authoritative for whether delegation actually took effect — a registrar API would at best tell us what was configured, not what resolvers see. Registrar adapters are a later, per-registrar addition and should be justified by a workflow, not by symmetry.
- `zone_nameservers text[]` is one of the few array columns in the schema. It is justified: the value is an ordered, small, opaque-to-Loxep list displayed verbatim for the operator to paste, never joined or filtered on. A child table would add a join for no query.
- `provider_zone_status` retains the provider's own status string verbatim, the same evidence-preserving role `orders.provider_status_raw` plays. `state` is Loxep's interpretation; this is what the provider actually said.
- **Health is orthogonal to state** — `last_error_at`, `last_error_code`, `consecutive_errors`, `drift_detected_at`. See below.

### `dns_records`

The desired state, and the heart of the design.

```text
dns_records
id                    uuid primary key
domain_id             uuid not null references managed_domains(id) on delete cascade
type                  text not null
name                  text not null
content               text not null
priority              integer null
ttl_seconds           integer null
proxied               boolean not null default false
owner                 text not null
external_record_id    text null
last_synced_at        timestamptz null
desired_deleted_at    timestamptz null
created_at            timestamptz not null
updated_at            timestamptz not null
unique(domain_id, type, name, content)
check(owner in ('apex','wildcard','mail','proxy_resource','manual'))
check(not (owner = 'mail' and proxied))
check(ttl_seconds is null or ttl_seconds between 30 and 604800)
```

- **The unique key is the natural key, not the provider's record id.** `(domain_id, type, name, content)` is what makes sync convergent, and it is recomputable from either side of the diff. Provider record identifiers are captured opportunistically in `external_record_id` to make updates and deletes cheap, but they are never identity — the same reasoning that keeps provider order ids out of Loxep primary keys.

  **Verify at implementation time:** a btree index over `content` inherits PostgreSQL's index-tuple size limit. Realistic DKIM and SPF values sit well inside it, but a long TXT value would fail the *insert*, not the sync. If that limit is reachable for any record class this design materializes, the fallback is a unique expression index over a hash of `content` — the same "drop to SQL rather than weaken the constraint" instruction Phase 3 gives for `NULLS NOT DISTINCT`.
- **`ttl_seconds` is nullable and means seconds.** The specification's `ttl integer default 1` encodes one provider's "automatic" sentinel directly into a Loxep table, which is precisely the leak ADR-0009 #5 exists to prevent. `NULL` means "let the provider choose", and the adapter translates it to whatever that provider's sentinel is. A future provider with a different sentinel needs no migration.
- **`proxied` survives as a Loxep concept, with an adapter capability requirement.** It means "the provider answers for this name and forwards to the origin" rather than returning the origin address. That is a real capability more than one DNS provider offers, so it is not provider-specific in the way the TTL sentinel is. The rule that makes it safe: an adapter must **declare** whether it supports proxying, and one that does not must reject `proxied = true` with an `invalid_request` error rather than silently writing an unproxied record. Silent degradation here means an origin address is published that the operator believes is hidden.
- **`check(not (owner = 'mail' and proxied))` is belt and braces, and both belts are load-bearing.** Proxying a mail provider's key-publication `CNAME` makes the DNS provider answer with its own addresses instead of resolving through to the key. Mail continues to flow; signature alignment quietly fails; the symptom is a deliverability problem discovered weeks later. A bug that presents that way must be impossible to introduce, so the invariant is enforced in the materializer *and* in the schema. This is the one constraint in the design that is worth its cost twice over.
- **`desired_deleted_at` is a soft delete, not a hard one.** Sync must be able to tell "this should be removed from the provider" apart from "this never existed", and the removal is evidence worth keeping. Rows are never hard-deleted in normal operation; the partial unique behavior this implies is discussed in [open questions](#open-questions).
- **`owner` decides what sync may rewrite**, and it is the most consequential column in the table:

```text
apex            materialized from apex_target_id            reconciler owns it
wildcard        materialized from apex_target_id            reconciler owns it
caa             materialized from the CAA issuance policy   reconciler owns it
mail            materialized from the mail provider's set   reconciler owns it
proxy_resource  materialized from reverse-proxy config      reconciler owns it
manual          authored by a human                         reconciler NEVER rewrites or deletes it
```

**`caa` was added at implementation time** (loxep-lmy.1) and is not in this design's original five. The gap it closes: the materialization rules below emit a CAA set unconditionally, and none of the other five owners fits one. Labelling it `apex` would be wrong rather than merely inelegant — `apex` means "materialized from `apex_target_id`", a mail-only domain has no apex target and still wants a CAA policy, and the reconciler would then delete that policy whenever an operator cleared an unrelated field.

  `manual` is the escape hatch that makes the whole model usable. Every operator has one record that no rule will ever generate, and a reconciler that deletes it on the next sweep is a reconciler nobody will run. Whether `manual` records participate in *drift reporting* is a separate question from whether they are ever rewritten — see [Drift detection](#drift-detection).

### `dns_drift_findings`

The persisted output of a read-only reconcile.

```text
dns_drift_findings
id                    uuid primary key
domain_id             uuid not null references managed_domains(id) on delete cascade
dns_record_id         uuid null references dns_records(id) on delete cascade
kind                  text not null
record_type           text not null
record_name           text not null
desired_content       text null
observed_content      text null
desired_proxied       boolean null
observed_proxied      boolean null
external_record_id    text null
first_detected_at     timestamptz not null
last_detected_at      timestamptz not null
resolved_at           timestamptz null
resolution            text null
resolved_by_user_id   text null references user(id) on delete set null
first_seen_run_id     uuid not null references reconcile_runs(id)
last_seen_run_id      uuid not null references reconcile_runs(id)
check(kind in ('missing','modified','unexpected'))
check(resolution is null or resolution in ('applied','adopted','dismissed','disappeared'))
check((resolved_at is null) = (resolution is null))
check((kind = 'unexpected') = (dns_record_id is null))
unique(domain_id, kind, record_type, record_name, coalesce(observed_content,''))
  where resolved_at is null
```

Why a separate table rather than drift columns on `dns_records` — the decisive argument, since columns are otherwise cheaper:

- **`unexpected` drift has no `dns_records` row to hang off.** A record present at the provider that intent never described is the single most important drift class, because it is how a hand-edit in a provider dashboard becomes visible. Columns on `dns_records` structurally cannot represent it.
- `dns_records` stays a **pure statement of intent**. Mixing observed values into it invites a query that reads observation as intent.
- Findings have their own lifecycle — first seen, still seen, resolved, and *how* resolved — which is four columns and a history question that does not belong on the intent row.

The partial unique on unresolved findings is what makes an hourly sweep idempotent: the second detection of the same drift updates `last_detected_at` and `last_seen_run_id` rather than inserting a duplicate. `first_detected_at` therefore answers "how long has this been wrong", which is the question an operator actually asks.

`managed_domains.drift_detected_at` is a denormalized rollup so the domain list can render a badge without a correlated subquery per row. It is derived and may be recomputed; the findings table is authoritative.

### `hosting_targets`

A place a name can point at. The specification calls this `vps`; the concept covers more than a VPS, and one of its values is explicitly "no hosting at all".

```text
hosting_targets
id                     uuid primary key
name                   text not null
control_surface        text not null
provider               text null
region                 text null
address_v4             inet null
address_v6             inet null
fronted_by_target_id   uuid null references hosting_targets(id)
proxy_connection_id    uuid null references connections(id)
external_site_id       text null
notes                  text null
decommissioned_at      timestamptz null
created_by_user_id     text null references user(id) on delete set null
created_at             timestamptz not null
updated_at             timestamptz not null
unique(name)
check(control_surface in ('proxy_node','tunnel_client','direct_reverse_proxy','none'))
check(fronted_by_target_id is null or fronted_by_target_id <> id)
check((control_surface = 'tunnel_client') = (fronted_by_target_id is not null))
check(control_surface = 'none' or address_v4 is not null or address_v6 is not null
      or fronted_by_target_id is not null)
```

- **`fronted_by_target_id` is the column that produces the subtle bug if it is missed.** When a domain targets a tunnel-connected host, the address record must point at **the fronting node's address, not the origin host's** — the origin is reachable only through the tunnel and may have no public address at all. The materializer resolves this hop. Getting it wrong publishes an unreachable address and looks like a DNS propagation problem for as long as it takes someone to check.
- **The fronting relationship is one hop, and PostgreSQL cannot say so declaratively.** `check(fronted_by_target_id <> id)` blocks the trivial self-loop; a longer cycle, and the "a fronting node may not itself be fronted" rule, must be enforced in the domain service, with a test. The alternative — a recursive `CHECK` via a trigger — is more machinery than a two-line service guard for a table with a handful of rows. Say so in the service, because the next reader will assume the constraint covers it.
- **`inet`, not `text`.** PostgreSQL validates it, normalizes it, and refuses the malformed value that would otherwise become a published record. Verify current Drizzle support for `inet` at implementation time and drop to hand-written SQL rather than weakening the column to `text` — the same instruction Phase 3 gives for `NULLS NOT DISTINCT`.
- `control_surface = 'none'` is a real value: a target that exists so a domain can be marked "DNS only, deliberately" rather than looking unconfigured.
- `proxy_connection_id` is nullable and points at the reverse-proxy/tunnel provider's connection when that control surface has an API worth driving. Milestone 3 territory; the column exists in the sketch so milestone 1's migration does not need altering later, and a nullable unused column is cheaper than an `ALTER`.
- `decommissioned_at` rather than deletion, because history is why the column exists at all.

### `dns_provider_tokens` and `dns_provider_token_zones`

This is the table pair most likely to be misread, so the distinction is stated flatly.

```text
                     credentials Loxep USES            credentials Loxep MINTS
                     ---------------------------       ---------------------------
what                 the control plane's own           a narrow token for one host
                       provider account token            to edit its own zones
where                connections +                     application_secrets +
                       connection_credentials            dns_provider_tokens
who reads it         Loxep's adapter                   a process on that host
```

The control plane holds one high-privilege account credential per DNS connection. Per-host tokens are **artifacts it produces**, never credentials it authenticates with.

```text
dns_provider_tokens
id                     uuid primary key
hosting_target_id      uuid not null references hosting_targets(id)
dns_connection_id      uuid not null references connections(id)
external_token_id      text not null
name                   text not null
permission_scope       text not null
secret_id              uuid null references application_secrets(id)
policy_synced_at       timestamptz null
last_rolled_at         timestamptz null
created_at             timestamptz not null
updated_at             timestamptz not null
unique(dns_connection_id, external_token_id)

dns_provider_token_zones
token_id               uuid not null references dns_provider_tokens(id) on delete cascade
domain_id              uuid not null references managed_domains(id) on delete cascade
primary key(token_id, domain_id)
```

Two provider behaviors this design must respect, and both change the UI, not just the code:

1. **The token value is returned exactly once, at creation.** Every subsequent read omits it. The value must be captured into an `application_secrets` version **in the same transaction that records the token row**, or it is unrecoverable and the only remedy is rolling the token. This makes token creation the one place in the design where a failed transaction has a real external cost, which is exactly what `provider_operations` exists to bound.
2. **A policy update replaces the entire policy array.** There is no "add one zone" call. `dns_provider_token_zones` is therefore the *intent*, and the sync task rebuilds the whole policy from it every time — which is the desired-state pattern applied one level down, and is why the table is intent rather than a mirror.

The consequence worth designing around: **changing a token's zone scope does not change its value.** Granting a host access to another domain requires no redeployment and no secret rotation on that host. Rolling the value does. These are wildly different operations with similar-sounding names, and the UI must not present them as neighbours — scope editing is cheap and immediate; rolling is deliberate, destructive-styled, and must show which hosts would need updating.

`permission_scope` is a Loxep-owned label (`dns_edit`, and nothing else initially) rather than a stored array of provider permission-group identifiers. Those identifiers are provider constants that belong in the adapter, not in a domain table — the same reason provider filter grammar never appears in a `monitor_targets` config.

### Mail: `mail_domains`, `mailbox_templates`, `mailbox_template_entries`, `mailboxes`

```text
mail_domains
domain_id                 uuid primary key references managed_domains(id) on delete cascade
mail_connection_id        uuid not null references connections(id)
provider_added_at         timestamptz null
ownership_code            text null
ownership_verified_at     timestamptz null
verify_attempts           integer not null default 0
last_verify_error         text null
last_verify_at            timestamptz null
created_at                timestamptz not null
updated_at                timestamptz not null

mailbox_templates
id                        uuid primary key
name                      text not null
is_default                boolean not null default false
created_at                timestamptz not null
updated_at                timestamptz not null
unique(name)
unique(is_default) where is_default

mailbox_template_entries
id                        uuid primary key
template_id               uuid not null references mailbox_templates(id) on delete cascade
local_part                text not null
kind                      text not null
forward_to                text null
generate_password         boolean not null default true
created_at                timestamptz not null
unique(template_id, local_part)
check(kind in ('mailbox','alias','catchall'))
check((kind in ('alias','catchall')) = (forward_to is not null))

mailboxes
id                        uuid primary key
domain_id                 uuid not null references managed_domains(id) on delete cascade
local_part                text not null
kind                      text not null
forward_to                text null
secret_id                 uuid null references application_secrets(id)
provider_created_at       timestamptz null
desired_deleted_at        timestamptz null
created_at                timestamptz not null
updated_at                timestamptz not null
unique(domain_id, local_part)
check(kind in ('mailbox','alias','catchall'))
```

- **`ownership_code` is not a secret and must not be treated as one.** Its entire purpose is to be published in a public TXT record. Someone will eventually propose encrypting it; the answer is no, and the reason is written here so the argument is not had twice.
- **`mailbox_templates` is what makes "provision the standard addresses" data-driven.** Edit the template once and every future domain picks it up; the alternative is a hardcoded list in the materializer that nobody can change without a deploy. `unique(is_default) where is_default` enforces at most one default declaratively.
- `mailboxes.secret_id` points at a **logical** `application_secrets` record, never a version row — ADR-0019's rule, and the same shape `storage_backends.secret_id` and `notification_endpoints.secret_id` already use. The generated password needs a new bundle purpose; see below.
- The mail provider's required record set is materialized through `dns_records` with `owner = 'mail'`, and every one of those rows is unproxied by constraint.
- **Verify the exact required record set against the mail provider's own current documentation at implementation time.** Do not carry values forward from any draft, including this one — this design deliberately lists none. The set is stable in practice, and it is also the difference between working mail and a failure mode that presents weeks late.

  *Done at implementation time (loxep-lmy.2), and the refusal paid for itself.* The verified seven-record Purelymail set is in this page's [implementation-status header](#milestone-2-mail-hosting-loxep-lmy2), and three of its properties would have been guessed wrong: three DKIM keys rather than one, a DMARC `CNAME` rather than a `TXT` policy, and an ownership code scoped to the **account** rather than the domain. The set itself lives in `packages/integrations/purelymail/src/records.ts`, not in any Loxep table — a second mail provider supplies its own.

**Implemented shape of the verification columns (loxep-lmy.2).** The provider offers no "ownership verified" flag, so the reconciler interprets rather than reads one: `provider_added_at` records that `addDomain` succeeded, and `ownership_verified_at` records that a subsequent read-back listed the domain. `verify_attempts` / `last_verify_error` / `last_verify_at` count only **real attempts** — a run stopped by the delegation gate makes no provider call and therefore increments nothing, which is what keeps the counter meaningful as a signal that something is actually wrong.

### `provider_operations`

The outbound idempotency ledger. Jobs are at-least-once; some provider calls are not.

```text
provider_operations
idempotency_key       text primary key
provider              text not null
operation             text not null
status                text not null
run_id                uuid null references reconcile_runs(id)
response_summary      jsonb null
attempts              integer not null default 1
started_at            timestamptz not null
completed_at          timestamptz null
check(status in ('pending','succeeded','failed'))
```

Any task performing a non-idempotent provider create — a zone, a token, a mailbox, a mail-domain registration — inserts `pending` **before** the call and updates after. On retry, a `succeeded` row short-circuits and a `pending` row is a deliberate decision point rather than a blind retry (see [open questions](#open-questions)). This is what stops a worker crash mid-call from creating two zones or two billable mailboxes.

The key is a deterministic natural string the task can always recompute from its own inputs — the same discipline Phase 3 requires of adapters that must derive a fee's natural key when the provider supplies no id.

`response_summary` is redacted, and for token creation it must **never** contain the returned value. That value goes to `application_secrets` and nowhere else. This is the single highest-risk line in the design: the one provider response that contains a long-lived credential is also the one a debugging instinct most wants to log.

**Ownership note.** Nothing about this table is infrastructure-specific — it would serve any domain that makes non-idempotent outbound calls. It ships Infrastructure-owned and is written with no infrastructure-specific columns, so promoting it to shared foundation later is a documentation change rather than a migration. That is deliberately the same move [Commerce open question 6](../commerce-schema-design/#open-questions) made for scheduling, and it is listed as an [open question](#open-questions) for the same reason.

### `reconcile_runs` and `reconcile_run_steps`

```text
reconcile_runs
id                    uuid primary key
kind                  text not null
subject_type          text not null
subject_id            uuid not null
mode                  text not null
status                text not null
trigger               text not null
actor_user_id         text null references user(id) on delete set null
started_at            timestamptz not null
finished_at           timestamptz null
step_count            integer not null default 0
error_summary         text null
check(mode in ('apply','check'))
check(status in ('running','succeeded','failed','partial'))
check(subject_type in ('domain','hosting_target','token'))
check(trigger in ('intent_change','sweep','manual','poll'))

reconcile_run_steps
id                    bigserial primary key
run_id                uuid not null references reconcile_runs(id) on delete cascade
sequence              integer not null
step                  text not null
status                text not null
provider              text null
request_summary       jsonb null
response_summary      jsonb null
error_code            text null
error_detail          text null
occurred_at           timestamptz not null
unique(run_id, sequence)
```

- **`mode` is the drift/apply switch, stored.** A run either applied changes or only compared. Without the column, a reader cannot tell whether a run that found three differences fixed them. This is the specification's `applyDiff` flag promoted from a parameter to a fact.
- `subject_id` is intentionally **not** a foreign key. A run against a subject that was later deleted is still evidence, and a `CASCADE` here would delete exactly the history somebody is trying to read. This is the same reasoning Phase 5 uses for `journal_entry_source_links`.
- `bigserial` on steps, matching the specification: steps are high-volume, append-only, and never referenced by anything.
- **`request_summary` and `response_summary` are redacted structures produced by a per-adapter redactor**, not raw payloads. The precedent is ADR-0021's `redactWooOrderFact` / `redactEbayOrderFact`: the redactor lives in the adapter, next to the knowledge of which fields are sensitive, and the domain service accepts only redacted input. What must never appear: token values, mailbox passwords, `Authorization` header contents, or a full request URL carrying credentials in a query string. What should appear: the operation, the record identity, and the values that actually differed.

## Record materialization

`materializeDesiredRecords` is a **pure function** from intent to desired records:

```text
(domain, apex target and its fronting chain, mail state, template) -> DesiredRecord[]
```

It touches no network and no database. It is separately and heavily tested, because it is where the subtle bugs live and it is cheap to test exhaustively.

```text
if apex_target_id is set:
    address = resolveHostingAddress(target)     # walks fronted_by_target_id for tunnel clients
    A/AAAA  @  -> address    proxied = domain.apex_proxied
    A/AAAA  *  -> address    proxied = domain.wildcard_proxied
    owner = 'apex' / 'wildcard'

if mail_enabled and mail registration exists:
    emit the mail provider's required record set, ALL with proxied = false, owner = 'mail'
    emit the ownership-proof TXT once the code has been fetched

always:
    emit the CAA record set from the installation's configured issuance policy

manual records:
    passed through untouched; never emitted, never rewritten, never deleted
```

### Constraints the materializer must enforce

- **Mail records are never proxied.** Enforced here and by the `CHECK`. Both.
- **Resolution walks the fronting chain, and a broken chain is an error, not a fallback.** If a tunnel client's fronting node has no address, materialization fails the run with a clear diagnostic. It must not silently emit the origin's address — that publishes the thing the tunnel exists to hide.
- **A resolved address inside Tailscale's private ranges is refused, never published.** (loxep-89h, extending loxep-rf4's Tailscale weave design §3.2 — *"a safety rule, not a taste one."*) `resolveHostingAddress` checks the address it is about to hand back — `current`'s address, the fronting node's for a tunnel client, not necessarily `target`'s — against Tailscale's CGNAT range (`100.64.0.0/10`) and its IPv6 ULA prefix (`fd7a:115c:a1e0::/48`; both verified 2026-08-14 against Tailscale's own docs, `packages/infrastructure/src/tailnet-address.ts`) and throws `MaterializationError` naming the offending target rather than emitting an A/AAAA record nothing on the public internet can reach. If only one address family is in range, the whole resolution refuses — publishing the "good" half while silently dropping the bad one is exactly the kind of quiet degradation this design's other rules already forbid. The fleet detail page (`/infrastructure/fleet/$name`) warns on the same condition using the same predicate, so an operator sees the problem before a sync run ever refuses. The inverse — Loxep writing, suggesting, or pre-filling `address_v4`/`address_v6` from a linked Tailscale device — stays forbidden; the tailnet address's only home is link metadata and the private-network read, never this column.
- **A CAA record set is emitted by default**, which the specification proposes and this design accepts. If the estate issues certificates through ACME, CAA closes a real misissuance path and costs one record. Its exact content is an [open question](#open-questions), because it depends on which issuers the estate actually uses and a wrong CAA record breaks certificate renewal at the worst possible moment.
- **Wildcard proxying and certificate coverage must be verified against the DNS provider's current plan behavior before the toggle ships default-on.** *Verified for Cloudflare on 2026-08-13, and this design's assumption was half wrong:* proxied wildcard records are **no longer plan-gated** — "customers on all plans can create and proxy wildcard DNS records" — so the default-on toggle is safe there. The certificate half stands: Universal SSL covers the apex and **one** label of subdomain on a full setup, so a deeper name is not covered without Total TLS or an advanced certificate. `capabilities()` reports both, and the materializer refuses a proxying intent the provider cannot honor rather than degrading silently.
- **Explicit records win over the wildcard**, which is why a mail provider's `CNAME`s coexist with a wildcard address record without special handling. Worth a test, because it looks like a conflict and is not.

## Provisioning state, and why `degraded` is not a state

The specification's state machine is right, and this design keeps it — with one change.

```text
draft
  |  operator submits the new-domain form
  v
zone_created            zone exists at the provider; nameservers returned
  |  materialize desired records; push what is pushable
  v
awaiting_delegation     UI shows the nameservers to set at the registrar
  |  poll until the provider reports the zone active
  v
zone_active
  |  records sync
  v
records_synced
  |  ownership verification — ONLY once delegation is confirmed
  v
mail_pending
  |  ownership verified; mailboxes created from the template
  v
ready
```

`state` is written **only** by the reconciler. No UI action sets it directly; a UI action changes intent, and the reconciler moves the state. This is the same discipline Phase 3 applies to `orders.entity_attribution_source`.

**The delegation gate is the single most valuable ordering constraint in the design.** Mail ownership verification cannot succeed while the registrar still delegates elsewhere, and every failed attempt may count against a provider's rate limits and its own patience. Do not attempt verification until the DNS provider reports the zone active. That one rule prevents most of the flakiness this workflow would otherwise exhibit.

**What this design removes: `degraded` as a state.** The specification makes it an eighth state and then immediately needs a `last_good_state` column to recover position, which is the tell. Health is orthogonal to position, and the foundation already models it that way — `connections` carries `last_error_at`/`last_error_code`, `monitor_targets` carries `consecutive_errors` and `backoff_until`. So:

```text
state                position in the provisioning chain; only ever advances
drift_detected_at    reality diverged from intent
last_error_at        the last failure
last_error_code      the adapter's error taxonomy kind
consecutive_errors   drives backoff, exactly as monitor_targets does
```

"Degraded" becomes a **derived display predicate** — drifted, or erroring, or stalled past a threshold — computed in the read model. No shadow column, no information lost, no recovery logic. A domain that is `ready` and drifted is exactly as recoverable as it was before the drift appeared, which is the property `last_good_state` was trying to buy.

## The reconciler: jobs, scheduling, and idempotency

Every mutation writes **intent** and enqueues a sync job. Sync reads intent, reads observed provider state, diffs, and applies. That gives idempotent reruns, drift detection through the same code path, resumability across a delegation wait that may take days, and "repoint this name at a different host" as an `UPDATE` plus an enqueue rather than a new workflow.

### Transactional enqueue is the whole reason this works

```text
BEGIN
  UPDATE managed_domains SET apex_target_id = ... WHERE id = ...
  addJob(tx, 'infrastructure.materialize-records', { domainId })
COMMIT
```

Intent change and job enqueue commit **atomically**, because Graphile Worker's queue is a table in the same database. No outbox, and no "the row changed but the job never fired" class of bug.

The way to lose this guarantee silently is to enqueue through a separate pool client rather than the transaction handle. `@loxep/jobs`' `addJob` must be threaded through the same Drizzle transaction, and there should be a test that asserts a rolled-back intent change leaves no job behind — otherwise the property is a comment, not a behavior.

### Job graph

```text
infrastructure.provision-domain     operator submit    key domain:{id}:provision
infrastructure.ensure-zone          provision          key domain:{id}:zone
infrastructure.poll-delegation      after zone_created key domain:{id}:delegation
infrastructure.materialize-records  intent change      key domain:{id}:materialize
infrastructure.sync-records         after materialize  key domain:{id}:records
infrastructure.sync-token-policy    scope change       key token:{id}:policy
infrastructure.ensure-mail-domain   provision, mail on key domain:{id}:mail
infrastructure.poll-mail-ownership  after records_synced, gated on delegation
                                                       key domain:{id}:mailverify
infrastructure.sync-mailboxes       after verified     key domain:{id}:mailboxes
infrastructure.sync-proxy-resource  hosting change     key domain:{id}:proxy
```

Every polling task carries a `job_key` with preserve-run-at semantics, so re-enqueueing a poll neither resets its backoff nor stacks duplicates. `@loxep/jobs` already exposes `jobKeyFor(taskName, stableId)`; these keys should be built through it rather than by hand.

Delegation polling uses a **bounded, self-terminating schedule** — frequent attempts for the first hour, sparse attempts for the following days, then stop and surface "delegation never completed" with a manual retry in the UI. Registrar propagation is genuinely slow and highly variable; tuning this aggressively buys nothing and spends the provider's rate budget. A poll that gives up visibly is better than one that retries forever invisibly.

### Where recurring cadence lives — and the Commerce precedent

[Commerce open question 6](../commerce-schema-design/#open-questions) asked exactly this question and answered it: the scheduling model is **shared foundation infrastructure that any domain may register a target type against**, now documented in [Domain Boundaries](../domain-boundaries/#scheduling-is-shared-foundation-infrastructure), with the rejected alternative being a per-domain scheduling table. Phase 7 should not re-litigate a resolved question, so it follows the precedent — but the cases differ enough that the difference is worth stating rather than assuming.

The work here splits into three kinds, and only one of them is scheduling:

```text
event-driven   intent changed -> reconcile now        transactional addJob + job key
               NOT scheduling; no row, no cadence

bounded poll   delegation, ownership verification     job key + a fixed backoff schedule
               NOT scheduling; self-terminating

recurring      periodic drift sweep per domain        THIS is scheduling
```

**Recommendation: register one target type, `infrastructure_domain_reconcile`, against the shared scheduling model — one `monitor_targets` row per managed domain — and create no infrastructure-owned scheduling table.** It inherits claim semantics, `backoff_until`, `consecutive_errors`, `priority`, and enable/disable for free, and it satisfies the contract's rule against one permanent cron per monitored item by construction.

Three mechanics the implementation must get right, each following an existing rule:

- **The market-activity adaptive policy is opted out** via the existing `config.adaptive.enabled = false` flag. That flag exists precisely for a target whose cadence should not be driven by marketplace events, and this is its first non-market use.
- **Transient state lives under a namespaced config key** — `config.infraSync` — owned by this domain. The scheduler writes only `config.adaptive`; Infrastructure writes only `config.infraSync`; neither reads the other's. This is rule two of the three that keep the shared model from becoming a dumping ground.
- **The subject reference points from Infrastructure to the scheduling row, not the reverse.** `managed_domains.reconcile_target_id uuid null references monitor_targets(id)` gives a real foreign key, where storing `domainId` inside `monitor_targets.config` would give a JSON reference with no integrity. Commerce did not face this because its target's subject — a connection — is already a real column on `monitor_targets`.

  This is the one place Phase 7 would add a column to its own table specifically to reuse a shared one, and it is [an open question](#open-questions) rather than a settled call, because the honest alternative — `next_reconcile_at` and a backoff column on `managed_domains`, swept by a single recurring job — is simpler for a table that will hold tens of rows, not thousands. The precedent points one way and parsimony points the other. It is reversible either way, which is why it is not marked critical.

- **The executor belongs to Infrastructure and is wired in the composition root**, routed by `target_type` in `@loxep/app`, exactly as the commerce order-sync executors are. `@loxep/market` gains a target-type registration and nothing else; `@loxep/infrastructure` takes no dependency on `@loxep/market`.

  Known cost, learned from Commerce: `createMonitorService` validates `target_type` against a closed enum and looks its config schema up in a closed record, so registration is an edit to two lists plus a structural re-declaration of the `infraSync` config shape in `@loxep/market`, guarded by a round-trip test. That duplication is the same one `woo_orders` and `ebay_orders` already carry. **A third registering domain is the trigger for building a runtime registration seam**, which the Commerce design already named as the obvious next iteration — Phase 7 makes it the third, so building the seam first is a defensible choice and should be considered rather than assumed away.

### Idempotency and secrets in job payloads

- **Handlers are idempotent or safe to retry.** Reads before writes, natural-key upserts, and `provider_operations` around every non-idempotent create.
- **No plaintext credential ever enters a job payload.** Graphile Worker payloads sit in a table in cleartext and survive failure. Pass the connection id or the logical secret id; resolve inside the task through the credential service. This is Configuration & Secrets rule 5 and it is the rule this design is most likely to violate by accident, because the reconciler's tasks all *need* a credential and the payload is the convenient place to put it.

## Drift detection

Drift detection is **the same code path with apply disabled** — `mode = 'check'` — which is the property that makes it trustworthy. A separate read-only comparator would drift from the applier, and the first time they disagreed nobody would know which was right.

```text
read intent            dns_records where desired_deleted_at is null
read observed          adapter list, normalized to Loxep record shape
diff on the natural key (type, name, content) and the comparable attributes

kind = 'missing'       intent has it; provider does not
kind = 'modified'      both have (type, name); content or proxied differ
kind = 'unexpected'    provider has it; intent does not describe it

mode = 'apply'         create / update / delete, then record findings as resolved 'applied'
mode = 'check'         record findings only; change nothing at the provider
```

Findings are **upserted against the unresolved partial unique**, so a recurring sweep updates `last_detected_at` rather than accumulating a row per sweep. A finding whose condition no longer holds is resolved with `resolution = 'disappeared'` by the next run that does not observe it — resolution is never a silent delete, because "this drift went away on its own" is itself worth knowing.

### `unexpected` records are never deleted automatically

This is the rule that decides whether the sweep is safe to leave running, and it answers the specification's open item about whether `manual` records participate in drift.

```text
manual records          COMPARED, so a hand-edit is visible
                        never rewritten, never deleted by any mode

unexpected records      REPORTED as a finding
                        never deleted automatically, in any mode
                        resolutions: 'adopted'  -> write it into dns_records as owner='manual'
                                     'dismissed' -> acknowledged, ignored until it changes
                                     manual delete -> an explicit, separate operator action
```

The reasoning: an automatic delete of an unexpected record is an unrecoverable action taken on the basis of Loxep's belief that its intent is complete, and that belief is wrong every time somebody legitimately adds a record in a provider dashboard — which they will. **Adopt** is the escape hatch that makes the model livable: it writes the observed value into desired state as a manual record, and the drift disappears because intent caught up with reality, not because reality was overwritten.

Comparing manual records rather than ignoring them is the right call for the opposite reason: a manual record that somebody changed at the provider is exactly the change an operator wants to see, and ignoring it entirely would make the sweep quietly incomplete. Comparison is free; only rewriting is dangerous.

## Credentials, secrets, and the reveal problem

The specification designs a complete secret store: a `secrets` table with ciphertext, nonce, auth tag, and key version, encrypted with AES-256-GCM at the application layer, keyed from a dedicated environment variable, with the record id as additional authenticated data, versioned from day one, decryption confined to one server-only module, and no plaintext in job payloads.

**Loxep already has every one of those properties**, specified by [ADR-0019](../../decisions/0019-secret-schema-and-crypto-binding/) and implemented in `@loxep/domain`: logical secret records with a `current_version` pointer and immutable version rows, AES-256-GCM with AAD binding ciphertext to its record class, logical id, version, and key version, an external keyring supplied as `LOXEP_KEYRING` and never stored in PostgreSQL, typed bundles validated before encryption, reads that decrypt the current version only, and redacted audit events on every write. The specification and the ADR arrived at the same design independently, which is a good sign for both — and it means **no new secret table is created**.

### Where each credential class lives

```text
DNS provider account token       connections + connection_credentials
mail provider API token          connections + connection_credentials
reverse-proxy / tunnel API key   connections + connection_credentials
registrar API credential         connections + connection_credentials   (later; no adapter yet)

minted per-host DNS token        application_secrets, referenced by dns_provider_tokens.secret_id
generated mailbox password       application_secrets, referenced by mailboxes.secret_id
```

The split follows the criterion the foundation already states: a **connection** exists where account identity and synchronization state matter and where more than one is normal — true of every provider account above. An **application secret** is for encrypted material that is not naturally the credential of one provider connection — true of both minted artifacts, which no Loxep adapter ever authenticates with.

New bundle purposes are needed in `@loxep/domain`'s registry. Following the existing naming, and noting that the base URL or account identifier stays out of the bundle as non-secret connection config for the same reasons `woo_credentials` excludes a store URL:

```text
dns_provider_credentials    { apiToken }             the control plane's own DNS account token
mail_provider_credentials   { apiToken }             the mail provider's API token
proxy_admin_credentials     { apiKey }               the reverse-proxy/tunnel integration key
dns_edit_token              { token }                a MINTED per-host token (application secret)
mailbox_password            { password }             a generated mailbox password (application secret)
```

**Implemented as `cloudflare_credentials`, not `dns_provider_credentials`** (loxep-lmy.1). Every purpose already in the registry is provider-named — `woo_credentials`, `medusa_credentials`, `invoiceninja_credentials`, `ebay_keyset`, `etsy_keyset` — so the role-named sketch above would have been the odd one out rather than "following the existing naming". The substantive reason is that a second DNS provider need not authenticate with a single bearer token, and a shared role-named bundle would then either fork or widen into a loose union, which is exactly the half-configuration hazard ADR-0019 bundles exist to prevent. Milestones 2 and 3 should follow the provider-named form too.

Application-secret key convention, following `integration.<provider>.keyset`:

```text
infrastructure.dns_token.<dns_provider_tokens.id>
infrastructure.mailbox.<mailboxes.id>
```

Each provider gets a catalog entry and a guided form under `/settings/integrations` and `/settings/connections`, with a new `Infrastructure` category. `connections.provider` and `connections.kind` stay system-supplied facts picked from the catalog entry — an operator never types either, and no surface offers a raw JSON config box.

### The reveal problem — an unresolved rule conflict

[Configuration & Secrets](../configuration-and-secrets/#secret-handling-rules) rule 2 is unambiguous: *general settings/connection APIs never serialize plaintext credentials back to the browser*, and rule 3 says a saved secret shows status and metadata, not its value.

The two minted artifact classes break that rule by their nature. A per-host DNS token exists to be pasted into a configuration file on that host. A generated mailbox password exists to be typed into a mail client. Neither is a credential Loxep consumes; each is a credential Loxep produces **for a human to carry elsewhere**. A vault the operator can never read is not a vault, and the practical outcome of holding rule 2 absolutely would be that operators write these values down somewhere Loxep cannot see — which is worse for exactly the reason the rule exists.

This design does not resolve the conflict. It surfaces it, per the contract's instruction to surface conflicts explicitly rather than drift. The [open questions](#open-questions) carry the recommendation, and it needs an ADR — an amendment to the secret-handling rules, not a quiet exception in one feature.

What the design *can* state now, because it holds under any resolution:

- **`lastAccessedAt` is not a new column and `secret_access_log` is not a new table.** Reveal writes an `audit_events` row with `resource_type = 'application_secret'` before returning, and "which credentials has nobody touched in a year" is a query over `audit_events`. The foundation already owns this concern; a parallel access log would be a second audit trail with different redaction rules, which is how audit trails become untrustworthy. If the query becomes expensive at real volumes, denormalizing a `last_revealed_at` column is an additive change later.
- **Reveal, if it ships, is admin-only, per-purpose, and audited before the value is returned** — never after, so a crash between the read and the log cannot lose the record.

## Three ledgers, and why none of them is `audit_events` alone

The specification proposes `runs`/`run_steps`. The foundation already has `audit_events`, `source_events`, and `provider_objects`. Getting the boundaries right matters, because the wrong answer is either a fourth redundant trail or an audit log full of machine chatter.

```text
audit_events        who changed INTENT                 an operator repointed a domain,
                    existing table, no changes         edited a token's scope, revealed a secret

reconcile_runs      what the RECONCILER did about it   the diff computed, the calls made,
   + steps          new tables                         what the provider answered, redacted

provider_operations whether a non-idempotent CREATE    did this exact zone-create already run
                    new table                          
```

They are three genuinely different questions and no two of them collapse:

- **`audit_events` is not a run log.** It is append-oriented evidence of *user and admin configuration changes*, and the foundation states that it is deliberately separate from what a provider told Loxep. An hourly sweep across every domain would flood it with rows no human changed, which would make the trail that matters unreadable. Every operator-initiated intent change here still writes `audit_events`, exactly as `SettingsService.setByKey` and the credential services already do, in the same transaction as the change.
- **`source_events` and `provider_objects` are the *inbound* provenance boundary** — what a provider delivered or what an import observed. A reconcile is an *outbound* mutation with a response. It does not fit that shape, and forcing it there would put outbound request bodies into the same table as ingested payloads with the same retention policy, which ADR-0021 was written to reason about carefully for one object class at a time.
- **`provider_operations` is not a subset of run steps.** A step records what happened during one run; the operation ledger answers "has this ever succeeded" across runs, which is the question a retry asks. Merging them would mean scanning run history to decide whether to make a call.

## Economic entities: none, deliberately

**No table in this design carries an `economic_entity_id`, and none should be added.**

The reasoning follows [ADR-0017](../../decisions/0017-installation-entities-books-and-access/) rather than merely citing it. An economic entity classifies *owned or operated activity* so it can be attributed and reported on. A nameserver delegation is not activity anybody performed on behalf of an operating identity; a host is not owned by an LLC in the sense the entity model means, and the same host routinely carries names serving several identities plus personal projects. Attaching an entity to a host would either be arbitrary or would quietly become the thing ADR-0017 forbids — a container that people start treating as an access or ownership boundary.

The cases that look like counter-examples, and what actually handles them:

```text
"this domain belongs to the LLC"           a note, or a future Catalog/branding concern.
                                           Not an attribution fact, and nothing downstream
                                           reads it.

"allocate the hosting bill across
 entities"                                 Phase 5 expenses + expense_allocations, which
                                           exist precisely for orthogonal cost attribution.
                                           The expense is the fact; the server is not.

"only the LLC's people should see
 these servers"                            per-resource ACLs, which Loxep does not have and
                                           which ADR-0017 defers until a real shared-install
                                           workflow demands them.
```

This is now a rule in [Domain Boundaries](../domain-boundaries/#infrastructure) and cross-domain rule 12, so a future phase cannot add the column without contradicting a documented boundary.

## Provider adapters

One package per provider under `packages/integrations/`, following ADR-0009 and matching the four adapters that already exist:

```text
packages/integrations/cloudflare    @loxep/integration-cloudflare   DNS zones, records, tokens
packages/integrations/purelymail    @loxep/integration-purelymail   mail domains, users, routing
packages/integrations/pangolin      @loxep/integration-pangolin     sites and hostname resources
```

Each carries the same shapes the existing adapters do, **duplicated rather than shared** — integration packages must not depend on each other, and a common base package would make every provider's error surface a shared upgrade hazard:

- the five-kind error taxonomy `auth | rate_limited | not_found | invalid_request | provider_unavailable`, with a sanitized `detail` record that never contains headers, query strings, or credential material;
- a per-connection in-memory token-bucket rate budget with a `rate_limited` refusal past a maximum wait, and a registered `integration.<provider>.rate_budget` application setting so the operator can tune it without a restart;
- Loxep-owned fact types. No provider response type is exported, and `@loxep/infrastructure` re-declares any shape it needs structurally rather than importing it — the discipline `@loxep/commerce` already applies to the eBay fact types;
- a `redact*` helper per response class that carries credential material, injected by the composition root, so `reconcile_run_steps` can never receive an unredacted summary.

Each adapter exposes the same minimal contract, which is what makes the reconciler provider-agnostic:

```text
read(subject)        -> observed state in Loxep types
apply(diff)          -> applied results, or a taxonomy error
capabilities()       -> which optional features this provider supports (proxying, wildcards)
```

`capabilities()` is the addition this design makes to the specification's `ensure`/`read` pair, and it is what lets the UI degrade honestly rather than offering a control that silently does nothing.

Two provider-shape warnings worth carrying into implementation, both of which have burned integrations before:

- **An RPC-style API that wraps every response in a success/error envelope means HTTP 200 does not imply success.** The adapter must branch on the envelope, not the status code. This is among the most common integration bugs with that API shape, and it fails by silently treating errors as successes.
- **Where an API reference is a client-rendered documentation page rather than a fetchable specification**, extract the underlying schema and generate types from it rather than transcribing method names by hand, and structure the adapter as one generic call function plus a single exported map of operation names — so correcting a wrong name is a one-line change rather than a refactor. Treat every operation name and record set as **unverified until checked against the running provider**, and mark it as such in the module documentation, exactly as the Medusa and eBay adapters do.

## The `/infrastructure` workspace

Milestone 3, and specified here only to the depth that constrains the schema. All of it follows [Frontend Standards](../../development/frontend-standards/): TanStack Table via the donor `DataTable` stack, `useAppForm`, semantic tokens.

```text
/infrastructure                 fleet and domain health; what needs attention
/infrastructure/domains         table: name, state, target, mail, drift
/infrastructure/domains/new     the wizard
/infrastructure/domains/$name   detail — delegation, DNS diff, mail, hosting
/infrastructure/fleet           hosting targets
/infrastructure/fleet/$name     detail — domains, token scope, control surface
/infrastructure/runs            reconcile history
/infrastructure/runs/$id        steps, with retry
```

Two behaviors that are design constraints rather than presentation choices:

- **The new-domain form writes intent and enqueues, then redirects.** It does not wait on a provider call. The submit must feel instant and the work must be visible on the next screen — which is only possible because state is durable and the reconciler is asynchronous. A form that awaited provider calls would reintroduce the linear-script failure this whole design exists to avoid.
- **The DNS panel is the desired-versus-observed diff**, rendered from `dns_drift_findings`, with `adopt` per row. That is why findings are a table rather than a log: the UI reads them directly.

Secret values are never rendered by any of these surfaces. The token and mailbox surfaces show status and metadata, plus whatever the reveal question above resolves to.

## Relationship overview

```text
connections (DNS / mail / proxy provider accounts)
    |  credential -> connection_credentials -> ADR-0019 versions
    v
managed_domains ──────────────> hosting_targets ──┐
    |    |    |                      ^            │ fronted_by_target_id
    |    |    |                      └────────────┘   (tunnel client -> fronting node)
    |    |    |
    |    |    +--> dns_records ──> dns_drift_findings
    |    |                              ^
    |    |                              |  produced by
    |    +--> mail_domains              |
    |    |        |                     |
    |    |        +--> mailboxes ──> application_secrets (generated password)
    |    |                 ^
    |    |                 +── materialized from mailbox_templates / _entries
    |    |
    |    +--> dns_provider_token_zones <── dns_provider_tokens ──> application_secrets
    |                                              |                 (minted token value)
    |                                              +--> hosting_targets
    v
reconcile_runs --> reconcile_run_steps
    ^
    +-- provider_operations (idempotency for non-idempotent creates)

monitor_targets (shared scheduling foundation)  <-- one row per domain, target type
                                                   `infrastructure_domain_reconcile`
audit_events (shared foundation)                <-- every operator intent change

NO economic_entities reference anywhere in this diagram, deliberately.
NO reference to orders, inventory, expenses, counterparties, or books.
```

## Migration plan sketch

### Ordering

Foreign keys dictate most of it. All migrations run through `loxep migrate` under the existing advisory lock, and startup never migrates (ADR-0018).

```text
1. hosting_targets                              (self-ref, connections, user)
2. managed_domains                              (connections, hosting_targets, user)
3. mailbox_templates, mailbox_template_entries   (independent)
4. dns_records                                  (managed_domains)
5. reconcile_runs, reconcile_run_steps          (user)
6. dns_drift_findings                           (managed_domains, dns_records, reconcile_runs, user)
7. provider_operations                          (reconcile_runs)
8. dns_provider_tokens, dns_provider_token_zones (hosting_targets, connections,
                                                  application_secrets, managed_domains)
9. mail_domains, mailboxes                      (managed_domains, connections, application_secrets)
```

Steps 1, 2, 4, 5, 6, and 7 are milestone 1 and can ship alone. Steps 3 and 9 are milestone 2. Step 8 is milestone 3 with the fleet surfaces. Step 3 is independent of everything and can move.

Verify at implementation time, and drop to hand-written SQL rather than weakening any constraint: Drizzle Kit support for the `inet` type, for partial unique indexes, for a unique index over a `coalesce(...)` expression, and for `CHECK` constraints referencing more than one column. Every one of these has a precedent in an earlier phase where the answer was "hand-write the SQL", and none of them should be softened to make a generator happy.

Foreign-key constraint names must be explicit where the generated name would exceed PostgreSQL's 63-byte identifier limit — `dns_provider_token_zones` and `mailbox_template_entries` are the two candidates.

### Which existing tables gain columns: none, with one open exception

- **`connections`** — no new columns. Provider account identifiers go in `config` under a namespaced key, exactly as store and instance base URLs already do.
- **`application_secrets`** — no new columns. New `purpose` values are text, plus registry entries in `@loxep/domain`. This is what that column is for.
- **`monitor_targets`** — no new columns. A new `target_type` value and a namespaced `config` key, which is the entire registration contract.
- **`audit_events`** — no new columns. New `action` and `resource_type` values only.
- **`economic_entities`, `expenses`, and every commercial table** — untouched, and not referenced.
- **Better Auth tables** — untouched, per ADR-0020.

The one exception is `managed_domains.reconcile_target_id`, which is a column on a table this design creates rather than an alteration to an existing one — and it exists only if the scheduling [open question](#open-questions) resolves toward reusing `monitor_targets`.

### Index strategy

Volumes here are tiny — tens of domains, hundreds of records, thousands of run steps a month. One index per named query, not defensive indexing.

```text
managed_domains       unique(name)                                    the lookup
managed_domains       index(state) where state <> 'ready'             "needs attention"
managed_domains       index(drift_detected_at) where not null         the drift badge
dns_records           unique(domain_id, type, name, content)          the diff key; the constraint IS the index
dns_records           index(domain_id) where desired_deleted_at is null  materialize/sync read
dns_drift_findings    the unresolved partial unique                   upsert probe
dns_drift_findings    index(domain_id) where resolved_at is null      the diff panel
hosting_targets       unique(name)
hosting_targets       index(fronted_by_target_id) where not null      resolution walk
reconcile_runs        index(subject_type, subject_id, started_at desc) subject history
reconcile_run_steps   unique(run_id, sequence)                        ordered read
provider_operations   primary key(idempotency_key)                    the only access path
dns_provider_token_zones  primary key(token_id, domain_id)
mailboxes             unique(domain_id, local_part)
```

Not indexed on purpose: `reconcile_runs.status` and `mode` (low cardinality, always accompanied by a subject or a date), `dns_records.owner` (small per-domain fan-out).

## Open questions

Each item is a genuinely unresolved decision with a recommendation, not a placeholder. **A recommendation is not an answer.** Items marked **OWNER-REVIEW-CRITICAL** are irreversible or unrecoverable once real provider state exists and must be answered before the milestone that depends on them starts.

1. **OWNER-REVIEW-CRITICAL — May a human ever read a stored secret back?** [Configuration & Secrets](../configuration-and-secrets/#secret-handling-rules) rule 2 says no. Minted per-host tokens and generated mailbox passwords are useless if the answer is no, because they exist to be carried to another system by a person.

   *Recommendation:* amend the rule by ADR rather than making a silent exception. Introduce a per-purpose `operator_readable` flag in the bundle registry; allow an admin-only `revealSecret` server function for those purposes only; write the `audit_events` row **before** returning the value; show `last revealed` in the UI; and prefer a one-time reveal at creation over indefinite readability where the workflow allows it. Explicitly keep every purpose that Loxep itself consumes — provider account tokens, OAuth tokens, keysets — **not** operator-readable, so the exception cannot widen by default.

   *The owner must confirm:* whether that exception is acceptable at all; if not, whether minted tokens and mailbox passwords should instead be shown once at creation and never stored, which makes the secrets vault surface disappear and makes a lost value a mandatory roll.

   ***RESOLVED (PROVISIONAL) by [ADR-0022](../../decisions/0022-minted-secret-reveal/):*** reveal-once at mint time, write-only forever after — the plaintext may be shown to the requesting admin exactly once, **in the response to the creating action**, and no read-back path exists afterwards for anyone. A missed reveal is a rotation, not a recovery.

   *What milestone 2 (loxep-lmy.2) found when it implemented against that:* **the one-time channel does not reach a job-minted secret.** Loxep mints a mailbox password inside `infrastructure.sync-mailboxes`, which runs whenever delegation and ownership verification finally complete — potentially days after the operator declared the mailbox, with no admin waiting on it. There is no creating response to reveal into, so clause 1 is inapplicable, clause 2 applies from birth, and the password is write-only with rotation as its only remedy. The port it is written through has no read member at all, so this is structural rather than a convention.

   *Consequence milestone 3 must not get wrong:* a UI offering the one-time reveal has to **move the mint into a request-scoped admin action**. Adding a read-back to the stored value instead is what clause 2 forbids, and the two produce identical pixels.

   *Milestone 3 (loxep-lmy.3) did exactly that.* `tokens.ts`'s `mint`/`roll` are called synchronously from a request-scoped admin server function and return the plaintext in their own response; the `/infrastructure` fleet UI's `RevealOnceDialog` shows it with a copy button and an explicit "you will not see this value again." `dns_provider_tokens.secret_id` is write-only afterward — no server function, route, or UI reads it back — and a lost value is a roll, never a recovery, exactly as this resolution specifies.

2. **OWNER-REVIEW-CRITICAL — What is the CAA policy content?** A CAA record set closes a real certificate-misissuance path and the materializer emits one by default. A **wrong** CAA record silently breaks certificate renewal, and the failure surfaces at expiry rather than at write time.

   *Recommendation:* make it an installation-level registered application setting (`infrastructure.caa_policy`) with a documented default naming the issuers the estate actually uses, plus a per-domain override, and refuse to materialize a CAA set until the setting has been explicitly reviewed once. Never ship a guessed issuer list as a working default.

   *The owner must confirm:* which certificate authorities the estate uses today, including any used indirectly by a proxying DNS provider or a reverse proxy, and whether wildcard issuance needs a separate property.

3. **OWNER-REVIEW-CRITICAL — Does automatic deletion of unexpected provider records ever happen?** This design says never: unexpected records are reported and require an explicit resolution.

   *Recommendation:* hold that line permanently. An automatic delete is unrecoverable, it assumes Loxep's intent is complete, and that assumption is wrong the first time somebody adds a record in a provider dashboard.

   *The owner must confirm:* that a "strict mode" which prunes unmanaged records is not wanted. If it is ever wanted, it must be per-domain, off by default, and must still refuse to touch records the sweep has not observed across at least two runs.

4. **OWNER-REVIEW-CRITICAL — What happens to a `pending` row in `provider_operations` after a crash?** The ledger stops double-creates, but a row stuck in `pending` means "we may or may not have created something at the provider" — the state the ledger exists to make visible and cannot itself resolve.

   *Recommendation:* never auto-retry a `pending` operation. Reconcile it by **reading** the provider for the object the operation would have created, keyed by its natural name, and completing or failing the row from what is actually there. Only if that read is impossible does it become an operator decision surfaced in the UI. Zone and mailbox creates are readable this way; a token create is **not**, because the value is returned once — so a `pending` token create resolves to "assume created, value lost, roll it".

   *The owner must confirm:* that the token case's resolution — a mandatory roll — is acceptable, since it is the one path where a crash costs a redeployment on the affected host.

5. **Where does recurring reconcile cadence live?** Register a target type against the shared scheduling model, or put `next_reconcile_at` and backoff columns on `managed_domains` and sweep them with one recurring job.

   *Recommendation:* register the target type `infrastructure_domain_reconcile`, following the resolved [Commerce open question 6](../commerce-schema-design/#open-questions) precedent, with `managed_domains.reconcile_target_id` as a real foreign key at the Infrastructure end. It reuses claim, backoff, and cadence machinery and avoids a second scheduling concept. The honest counter-argument is that Infrastructure's cadence is uniform and its row count is tiny, so the columns-plus-sweep alternative is genuinely simpler here in a way it was not for Commerce.

   *The owner must confirm:* which of the two, and — if the target type is chosen — whether Phase 7 being the **third** registering domain should first convert `@loxep/market`'s closed target-type enum into a runtime registration seam, removing the structural config re-declaration rather than adding a third copy of it.

6. **Is `provider_operations` Infrastructure-owned or shared foundation?** It is written with no infrastructure-specific columns and would serve any domain making non-idempotent outbound calls.

   *Recommendation:* ship it Infrastructure-owned and documented as promotable, exactly as scheduling was handled before Commerce forced the question. Promoting it later is a Domain Boundaries edit, not a migration. Do not pre-promote it — cross-domain rule 6 says do not create a generic abstraction until concrete workflows show it is real, and today there is one workflow.

   *The owner must confirm:* the name, since a shared-foundation table called `provider_operations` claims a fairly general noun that a future domain might reasonably want.

7. **Should `dns_records` soft-deletes remain in the unique key's scope?** With `unique(domain_id, type, name, content)` covering all rows, a record that was soft-deleted and is later re-declared collides with its own tombstone.

   *Recommendation:* keep the unique across all rows and have the materializer **resurrect** a soft-deleted row — clear `desired_deleted_at` — rather than inserting a second one. That preserves the audit trail and the natural key simultaneously. The alternative, a partial unique `where desired_deleted_at is null`, permits an unbounded pile of tombstones for the same record and makes "has this ever been declared" a scan.

   *The owner must confirm:* nothing security-relevant; this is reversible and is flagged because it is the kind of detail an implementer will decide silently and wrongly at 2am.

8. **Do registrar adapters ever get built?** This phase deliberately builds none, treats `registrar` as a text note, and verifies delegation through the DNS provider's zone status.

   *Recommendation:* build none until a specific registrar's API demonstrably removes manual work the operator actually does repeatedly. Registrar APIs are heterogeneous, several are unpleasant, and nameserver delegation is a one-time act per domain. The precedent for a denormalized name with no integration is `acquisitions.vendor_name`.

   *The owner must confirm:* that manual nameserver entry at the registrar is acceptable as the permanent workflow for milestone 1, and whether any registrar in use has an API worth a later adapter.

9. **How long are `reconcile_run_steps` retained?** An hourly sweep across a portfolio of domains produces steady, unbounded growth of rows that are interesting for days and archaeological after that.

   *Recommendation:* no automatic deletion in this phase — matching the observation hypertable's "no automatic retention by default" stance — but add a registered setting and a maintenance job in the same milestone that adds the sweep, so the decision is available before the table is large. Reconcile runs that **changed** something should be retained longer than checks that found nothing; the `mode` column makes that policy expressible in one predicate.

   *The owner must confirm:* whether unbounded growth is acceptable initially, given a self-hosted PostgreSQL the owner also backs up.

10. **Does a proxying-capable DNS provider's wildcard and certificate behavior support the default-on proxy toggles?** The design defaults both apex and wildcard proxying to on, per the specification.

    *Recommendation:* verify against the actual account's plan before shipping the default, and have `capabilities()` report it so the UI degrades honestly. If proxied wildcards are unavailable, the default must be off rather than a toggle that appears to work. Separately, confirm whether automatic certificate coverage extends past one label of subdomain; if it does not and nested subdomains are expected, that is a reverse-proxy or advanced-certificate concern the design must not paper over.

    *The owner must confirm:* nothing until implementation; this is a verification gate, listed so it is not skipped.

## Contradictions and tensions found in existing documentation

Recorded for a human to resolve; this document does not attempt to fix them.

1. **The Master Domain Map's non-goal versus this phase's existence.** *"Loxep is not an infrastructure management platform"* is a documented non-goal, and this phase builds an infrastructure control plane. This design argues the line in [the opening section](#the-non-goal-this-design-runs-against) — own declared DNS intent and its reconciliation, link everything else — but the map's wording currently admits no such carve-out. If the phase is accepted, that bullet should be tightened to say what Loxep does not become (configuration management, deployment orchestration, container and host operations) rather than reading as a blanket exclusion, and [Companion Services](../../product/companion-services/#infrastructure-operations) should record that DNS and name intent are the deliberate exception. If the phase is rejected, this document should be marked superseded rather than left to contradict the map.

2. **Principle 18 versus the absence of a companion for this problem.** *"Integrate before rebuilding mature specialist products"* is the right default, and the honest position is that this phase does not clear it by finding no tool at all — several DNS-as-code tools exist. It clears it by arguing that none of them integrates with the rest of what Loxep already knows, and that the reconciler is fifty lines of diff logic over machinery Loxep has four times over. That is a weaker argument than the one made for, say, not rebuilding an invoicing product, and it should be tested in review rather than accepted because it appears in a design document.

3. **Companion Services' integration-health model overlaps this domain's health columns.** [Integration health](../../product/companion-services/#integration-health-as-a-loxep-feature) proposes a generic `integration_health` table keyed by `(subject_type, subject_id)`, with connections, notification endpoints, and storage backends as subjects. `managed_domains` carries its own `last_error_at`/`last_error_code`/`consecutive_errors`, which is a fourth subject with a private copy of the same idea. Neither table exists yet. Whichever is built second should adopt the other's shape rather than both shipping; this design uses per-table columns because that is what `connections` and `monitor_targets` actually do today.

4. **`provider_objects` and `source_events` are named for inbound provenance, but nothing in the foundation says so explicitly.** This design reads them as inbound-only and therefore creates a separate outbound run ledger. That reading is consistent with every existing use and with their column names, but the [Foundational Data Model](../foundational-data-model/#provider-ingestion-and-provenance) never states the restriction. If outbound calls are meant to land there, this design's run ledger is redundant and should be revisited before implementation, not after.

## Before implementing this schema

1. resolve open questions 1 through 4 — every one is unrecoverable after real provider state exists, and question 1 additionally requires an ADR before any UI is designed;
2. resolve open question 5 (reconcile cadence ownership) — it decides which package owns the sync job and whether `@loxep/market`'s registration seam is refactored first, exactly as Commerce's equivalent question decided package boundaries rather than table shapes;
3. verify every provider's current API behavior against upstream sources before fixing any operation name, record set, or status vocabulary — this document deliberately lists none, and a value carried forward from memory is the failure mode these adapters are most prone to;
4. verify current Drizzle Kit support for `inet`, partial unique indexes, expression unique indexes, and multi-column `CHECK`s, and fall back to hand-written SQL rather than weakening a constraint;
5. write the materializer's tests before the materializer — the fronting-node hop, mail records never proxied, manual records passed through untouched, and the mail-only domain shape are the four cases that must be covered before a line of provider code exists;
6. write the reconcile idempotency tests before the reconciler: same intent twice, a crash between `provider_operations` insert and the provider call, a drift finding detected twice, and a soft-deleted record re-declared — all against real PostgreSQL;
7. assert the transactional-enqueue property with a test that rolls back an intent change and proves no job survives, because the guarantee is silent when it breaks;
8. confirm no adapter can place a token value, a mailbox password, or an `Authorization` header into `reconcile_run_steps` or a job payload — a test per adapter, not a code review;
9. keep provider SDK types at the integration boundary (ADR-0009); none of the columns above may be typed from a provider library;
10. update this document, the roadmap, and Domain Boundaries when implementation reality diverges, rather than letting the documentation drift.

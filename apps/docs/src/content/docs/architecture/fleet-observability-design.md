---
title: Fleet Observability Design (Phase 8)
---

This document designs Phase 8 — the **observe and link** layer of the `/infrastructure` workspace. [Infrastructure Control Plane Design (Phase 7)](../infrastructure-control-design/) named this layer, deferred it, and drew the line it must stay inside. Phase 8 does not extend that line; it lives entirely underneath it.

**Design work only.** No migration, Drizzle schema, integration package, or service code is authorized by this page. Every upstream fact below was verified against current sources on 2026-08-13 and must be **re-verified immediately before implementation** per the [dependency policy](../../development/dependency-policy/) — three of the six candidate tools shipped a release within the last ninety days, and one of them is eight months old.

Phase 8 depends on the foundation and, for its user-facing surfaces only, on Phase 7 milestones. Its first milestone depends on neither.

## The line this phase inherits

Phase 7's ownership statement is binding here, and Phase 8 is almost entirely its third row:

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

[Domain Boundaries](../domain-boundaries/#infrastructure) states the same rule as a boundary: Infrastructure does not own *"container orchestration, host metrics, or uptime probing… Infrastructure may hold links and health state for them under the generic external-resource and integration-health models, and must not grow into a reimplementation of them."*

Phase 8 adds one falsifiable marker of its own, because the third row is easy to cross by accident:

> **Loxep stores the latest observed status of a subject. It never stores a metric sample.**

If a milestone proposes a hypertable, a chart of CPU over time, a retention policy for host metrics, or a "last 24 hours of response times" table, that milestone has started rebuilding Beszel or Gatus and the [Master Domain Map's non-goal](../../product/master-domain-map/#what-loxep-is-not) wins. One row per subject, overwritten in place, is the shape that makes the rule enforceable by inspection rather than by intent.

The second marker follows from the first:

> **Loxep never calls a mutating endpoint on a fleet tool.**

Dockhand can restart a container and redeploy a stack over HTTP. Beszel can update a system record. Those calls exist and are reachable. An adapter that made one would be doing exactly what the fourth row forbids, regardless of how the UI described it. Adapters designed here are **read-only by construction**, with one deliberate exception argued below that writes Loxep's own health outward and touches nothing on any host.

## The self-monitoring trap, which decides most of this phase

Every other Loxep integration observes something Loxep does not run on. eBay does not stop working because the Loxep container died. The fleet does.

```text
Loxep runs on the fleet it would be observing.

Therefore anything Loxep is in the critical path of cannot report
Loxep's own outage — and the outage of the host Loxep runs on is
the single most important alert in the whole estate.
```

That one observation resolves the largest open design question — whether infrastructure alerts should route through Loxep's notification pipeline — and it resolves it against Loxep. It also inverts the phase's most obvious assumption: the most valuable thing Loxep can do with Gatus is not *read* it, but **be watched by it**.

### What the operator already has

Every candidate tool speaks ntfy natively:

```text
beszel     Shoutrrr, with Ntfy among 25 services      settings -> notifications
gatus      Ntfy alerting provider (topic/url/token/priority)
netdata    SEND_NTFY / DEFAULT_RECIPIENT_NTFY in health_alarm_notify.conf
dockhand   ntfy among ~10 outbound notification channels
```

The operator running Loxep already has ntfy configured, because [ntfy is Loxep's first notification transport](../../development/implementation-contract/#notifications). So a host-down alert from Beszel and a price-drop alert from Loxep already arrive on the same phone, in the same app, from the same server — **and ntfy, not Loxep, is what unified them.** Inserting Loxep as a relay between Beszel and ntfy adds a hop, a failure mode, and a dependency on the very machine being reported on, in exchange for a unification that already exists.

### What the delivery ledger physically is

Independently of that argument, the schema says no. `notification_deliveries` is not domain-neutral today:

```text
notification_deliveries
market_event_id   uuid NOT NULL references market_events(id)
endpoint_id       uuid NOT NULL references notification_endpoints(id)
unique(market_event_id, endpoint_id)
```

and `market_events.marketplace_item_id` is itself `not null` against `marketplace_items`. The `notifications.deliver` job payload is `{ marketEventId, endpointId }`, and the deduplication key — the property that makes at-least-once delivery safe — is that unique pair. There is no seam for a subject that is not a market event about a marketplace item.

The **transport** is genuinely neutral: `NotificationMessage` is `{ title, body, priority?, tags?, url? }` and knows nothing about markets. The **ledger and the rule matcher** are not. Routing an infrastructure alert through the existing pipeline therefore means altering a shipped foundation table to a polymorphic subject, rewriting the dedupe key, and generalizing `notification_rules.market_event_type`. That is a real, defensible piece of work — it is simply not work this phase should do in order to become a slower ntfy.

### The resolution

```text
DETECTION      the companion tool detects (host down, endpoint failing,
               container unhealthy). It is better at this than Loxep and
               it keeps running when Loxep does not.

DELIVERY       the companion tool delivers, directly to ntfy. Loxep is not
               in the path. No change to notification_deliveries.

EVIDENCE       Loxep may additionally receive a copy as an inbound webhook,
               record it, and roll it into health state. Recording is not
               delivering.
```

This is the contract's *"event detection and notification delivery remain separate concepts"* rule read honestly, with Loxep on the consuming side of a detection it did not perform. It is also the only arrangement in which the alert still fires when Loxep is the thing that broke.

**What would falsify it:** if the operator ever wants one Loxep-authored rule that fans an infrastructure alert to several transports, this design is wrong and the ledger must be generalized. That is [an open question](#open-questions), not a settled call.

## Does Loxep run its own uptime probes?

Loxep already owns a scheduler ([`monitor_targets`](../foundational-data-model/#monitoring-model)), durable jobs with backoff, and health conventions ([ADR-0018](../../decisions/0018-runtime-processes-migrations-health/)). Adding an "enter a URL and an interval" form is perhaps a day's work. [Principle 18](../principles/#18-integrate-before-rebuilding-mature-specialist-products) says do not.

The recommendation is **no**, and the line is drawn by *what the subject is*, not by how the check is implemented:

```text
Loxep PROBES        a subject that is already a Loxep record and that Loxep
                    itself depends on — a connection, a notification endpoint,
                    a storage backend, a registered companion tool's own
                    health path. "Can Loxep reach the things Loxep needs?"

Loxep DOES NOT      an arbitrary operator-supplied URL, port, DNS name, TLS
PROBE               expiry, or certificate, on a schedule the operator tunes,
                    with per-check conditions and per-check alerting.
                    That is Gatus, and Gatus is very good at it.
```

The first is **integration health** and Loxep has needed it since Phase 0 — [Companion Services](../../product/companion-services/#integration-health-as-a-loxep-feature) proposes it, Phase 6 assumes it exists, Phase 7 assumes it exists, and it has never been built. The second is **uptime monitoring**, a mature product category with two strong self-hosted answers.

The distinction survives the obvious objection. Probing Beszel's `/api/health` looks like uptime monitoring, but the subject is a registered Loxep record with a known provider and a documented health path, not a free-text URL — and the reason for the probe is that Loxep's own read adapter depends on it. **If a milestone ever ships a form whose first field is a URL the operator types, the line has been crossed.** That is the test to apply in review.

The stronger version of this argument is that a Loxep-run probe *cannot check the one thing that matters most*: whether Loxep is up. Gatus can, because it is a separate process. Which leads to the recommendation that gives this phase its best return.

## Publish Loxep's own health outward

Gatus exposes exactly one write path in its entire route table:

```text
POST /api/v1/endpoints/:key/external?success=<bool>&error=<msg>&duration=<ns>
     Authorization: Bearer <token declared in gatus YAML>
     key format:  <GROUP_NAME>_<ENDPOINT_NAME>
```

The endpoint must already be declared in Gatus's YAML under `external-endpoints` with its own bearer token, optionally with `heartbeat.interval` so the endpoint goes down on its own if no push arrives. It cannot create endpoints, and it cannot change configuration.

That is a near-perfect fit for the self-monitoring problem, and it runs the integration in the direction nobody expects:

```text
Loxep  ──(one POST per push, per subject)──>  operator's existing Gatus
                                                     |
                                              Gatus's own alerting
                                                     |
                                                   ntfy

If Loxep stops pushing, the heartbeat interval expires and Gatus
raises the alert Loxep could never have raised about itself.
```

What Loxep would publish is the state only Loxep knows: worker backlog, order-sync freshness per connection, notification delivery success, the reconciler's drift count, migration/readiness state. None of it is inventable by an external probe of `/health/ready`.

**Cost:** one outbound job, one bearer token in `application_secrets`, one configuration form. No new table, no new domain concept, and a hard cap on blast radius — a compromised token lets an attacker mark a Gatus endpoint healthy, and nothing else.

This is the cheapest genuinely new capability in the phase and it should ship before any reader.

## Per-tool verdicts

Verified 2026-08-13. Each verdict is the tier the tool is worth today, not the tier it might reach.

```text
tier 0   no relationship          Loxep does not model it at all
tier 1   link                     external_resources + resource_links; a deep link on a
                                  fleet record. No credential, no probe, no adapter.
tier 2   link + reachability       tier 1 plus a documented unauthenticated health path,
                                  projected into integration_health. Still no credential.
tier 3   read adapter             tier 2 plus a connections row, an encrypted credential,
                                  an integration package, normalized status per subject.
tier 4   evidence ingestion        the tool posts alerts to Loxep; Loxep records them.
                                  Never a delivery path. Orthogonal to 1–3.
```

| Tool | Verified upstream surface | Verdict |
| --- | --- | --- |
| **Gatus** | Apache-2.0, v5.36.0 (2026-05-19). Read API `/api/v1/endpoints/statuses`; unauthenticated `/health`, `/api/v1/config`, badges, per-endpoint uptimes/response-times. Basic auth is header-based; **OIDC is session-cookie only**. `POST …/external` push. Fully templated custom-webhook alerting. Config is files only. | **tier 2 + tier 3 + outbound push.** The best-integrated tool in the set, in both directions. Never push config. |
| **Beszel** | MIT, v0.18.7 (2026-04-05), **still pre-1.0 after two years**. Hub is PocketBase; REST is the PocketBase API (`/api/collections/systems/records`, filter DSL, JWT). Unauthenticated `GET /api/health`. Shoutrrr alerting incl. ntfy + generic webhook. Iframe embedding effectively unsupported. | **tier 2 now; tier 3 only on owner approval.** The read API requires a **superuser** credential and upstream warns record shapes *"may change in minor releases"*. |
| **Dockhand** | BSL-1.1 (converts to Apache-2.0 on 2029-01-01), v1.0.41 (2026-08-09), repo created **2025-12-28**, ~weekly releases, ~130 endpoints, **no OpenAPI** (issue #814 open, unanswered), unversioned `/api`, contradictory auth documentation, `GET /metrics` Prometheus. | **tier 1, and no adapter.** Also the one tool whose every interesting endpoint is a mutation. See below. |
| **Netdata** | GPLv3+ agent (dashboard UI closed-source but free), v2.11.0 (2026-08-12). **v3 API is current; v1/v2 deprecated in Netdata's own OpenAPI.** `/api/v3/nodes`, `/api/v3/data`, `/api/v3/alerts`, `/api/v3/alert_transitions`. Documented `custom_sender()` webhook and native ntfy. Iframe-able by default. | **tier 2, plus optional embed. No adapter.** Not because the API is weak — it is the best of the six — but because there is nothing to authenticate with, and because ingesting it would be building a metrics product. |
| **Cockpit** | LGPL-2.1+, release 365 (2026-07-30). **No stable REST API**; the channel protocol is described upstream as unstable. `GET /ping` → `{"service":"cockpit"}`, CORS-enabled and documented. `X-Frame-Options: sameorigin` is **hard-coded** with no configuration knob. | **tier 2.** Deep link plus `/ping`. Embedding requires same-origin behind one reverse proxy; do not design for it. |
| **Uptime Kuma** | MIT, v2.5.0 GA (2026-08-01), ~90k stars. Upstream wiki: the API is *"not officially supported for third-party integrations. Breaking changes may occur between versions without prior notice."* CRUD is socket.io. Public `GET /api/status-page/heartbeat/:slug` exists. | **tier 1, as the recognized alternate to Gatus.** No adapter against an API upstream disclaims. |
| **Grafana / Prometheus / Loki** | — | **tier 0, permanently.** Named here so the boundary is explicit: the correct consumer of Dockhand's and Netdata's `/metrics` is Prometheus, not Loxep. Loxep must never become a metrics pipeline, and an operator who wants one already knows what to install. |

### Gatus, in detail

Gatus is the only candidate whose integration is worth building in both directions, and its constraints are sharp enough to design around now.

- **Configuration is files, and Loxep must not write them.** Gatus reads `config/config.yaml` or, when the path is a directory, deep-merges every `*.yaml` beneath it, polling for changes every 30 seconds. Loxep owning `50-loxep.yaml` in a shared volume is technically clean and is exactly the trap: writing configuration files onto a host is configuration management, the fourth row of the inherited line. **Loxep does not push Gatus configuration.** The operator authors endpoints; Loxep reads them and links to them.
- **The read adapter must branch on the auth mode.** `/api/v1/endpoints/statuses` sits behind `security`. Basic auth is header-based and machine-consumable; OIDC resolves a client from a **session cookie**, with no bearer path — so against an OIDC-secured Gatus a server-to-server reader **cannot authenticate at all**. `GET /api/v1/config` is unauthenticated and returns `{ oidc, authenticated }`, which makes it the probe the adapter uses to decide what it can do. Against OIDC it degrades to the unprotected per-endpoint uptime and response-time routes, which requires knowing endpoint keys in advance — i.e. to `external_resources` rows the operator created. **The UI must say which mode it is in.** Silent degradation to a partial view of a status page is the failure mode that makes an operator trust a green dashboard that is not looking at everything.
- **Alert evidence, if it ships, has no schema negotiation.** Gatus's `custom` provider has no default body: the operator supplies the URL, method, headers, and body template, and Gatus substitutes `[ENDPOINT_NAME]`, `[ENDPOINT_GROUP]`, `[ENDPOINT_URL]`, `[RESULT_ERRORS]`, `[RESULT_CONDITIONS]`, `[ALERT_TRIGGERED_OR_RESOLVED]`, `[ALERT_DESCRIPTION]`. Loxep therefore **publishes the exact JSON contract it wants to receive** and documents the snippet to paste, rather than parsing somebody else's schema. That is the cleanest webhook relationship in the whole candidate set.

### Beszel, in detail

Beszel is the right metrics tool to link and the wrong one to build an adapter against today. Three facts, in order of weight:

1. **A read consumer needs a superuser credential.** There is no scoped read-only token; third-party precedent (Homepage's Beszel widget) documents username/password of an admin-equivalent account. Loxep can store that safely — it is an ordinary [ADR-0019](../../decisions/0019-secret-schema-and-crypto-binding/) bundle — but storing it means a Loxep database compromise *plus* keyring access yields administrative control of the monitoring hub for the entire fleet, to read a status summary. That trade must be made deliberately, not as a side effect of adding a catalog card, and the connection form must say what the credential actually is rather than labelling it "API token".
2. **Pre-1.0 after two years, with an explicit shape warning.** Upstream states record shapes *"may change in minor releases"*. [ADR-0009](../../decisions/0009-integration-boundaries/) already requires Loxep-owned types behind an adapter with validation at the boundary, so this is survivable — but it is a standing maintenance cost for a read-only summary, and it should be priced in rather than discovered.
3. **`GET /api/health` is unauthenticated**, inherited from PocketBase, returning `{"status":200,"message":"API is healthy."}`. That gives tier 2 for free, with no credential at all — which is the recommendation until the owner decides on point 1.

Beszel's alerting is Shoutrrr with native ntfy, so the detection-and-delivery path is already complete without Loxep. Iframe embedding is effectively unsupported upstream; link out.

### Dockhand, in detail, and the honest reason it stays at tier 1

Dockhand is the tool the epic named first and the one with the weakest case, for reasons that have nothing to do with its quality.

- **Its verbs are the forbidden ones.** Start, stop, restart, exec a terminal, browse files inside a container, edit and redeploy a Compose stack, inject secrets at deploy time. Every one of those is *"anything that runs ON a host"*. A read-only Dockhand adapter is possible in principle — list containers, list stacks — but the value of Dockhand is the mutations, and an adapter that deliberately refuses them is a worse Dockhand embedded in Loxep. **A deep link opens the real thing, with the operator's own session and Dockhand's own RBAC.** That is strictly better on every axis including security.
- **The API is not yet a stable target.** ~130 endpoints, no OpenAPI specification (the request is open and unanswered), an unversioned `/api` base path with only an informal additive-changes promise, and API documentation that describes session-cookie auth while the manual describes API tokens — a contradiction that cannot be resolved without reading source. The project is eight months old and ships roughly weekly. Phase 7 already warns that undocumented operation names must be treated as *"unverified until checked against the running provider"*; here that would apply to the entire surface.
- **Loxep cannot verify it the way Loxep verifies everything else.** Dockhand's repository carries an explicit prohibition on AI/LLM ingestion of its contents, and an automated fetch of the README was refused on those grounds during this research. Loxep's adapters are built and reviewed by coding agents reading upstream source — that is how the eBay, WooCommerce, Medusa, and Invoice Ninja boundaries were verified. For Dockhand that method is unavailable by the maintainer's stated wish. An adapter would have to be hand-written from a rendered documentation site with no source verification and no specification, against an unversioned API, on a weekly release cadence. **That is not a risk to accept for a capability Loxep has already decided it must not use.**
- **Licensing is not the blocker.** BSL-1.1 with a 2029 conversion to Apache-2.0, and the additional-use grant explicitly permits internal business use and *"embedding or integrating the Licensed Work into internal tools or platforms that are not offered commercially to third parties"*. Loxep calling Dockhand's API is permitted; only offering a commercial hosted Docker-management service would not be. Worth one line in any future ADR, and no more.

Dockhand's outbound generic webhook and ntfy channels remain available for tier 4 evidence ingestion on the same terms as everything else.

### Netdata, and why the best API here is still not an adapter

Netdata has the strongest machine interface of the six and should still be linked rather than read, for one reason that is architectural rather than technical:

**there is no credential to store.** Bearer-token protection on the agent requires the agent to be *claimed to Netdata Cloud with an active connection*; tokens are issued through a Cloud redirect and cannot be obtained offline. A purely self-hosted, unclaimed agent's API is protected by IP allowlists in `netdata.conf` or by a reverse proxy — that is, by network position. A Loxep "connection" for Netdata would be a base URL with an empty credential bundle, which misrepresents the [configuration and secrets model](../configuration-and-secrets/#secret-handling-rules) rather than fitting it.

Two supporting reasons: Netdata and Beszel occupy the same slot, and an installation running both does not need two Loxep adapters — **pick at most one metrics adapter, ever**. And the data Netdata exposes is per-second time series, which Loxep is forbidden to store.

What Loxep should record, if the design is implemented: the v3 endpoint set (`/api/v3/nodes`, `/api/v3/alerts`, `/api/v3/alert_transitions`), because Netdata's own OpenAPI states *"V1 and V2 APIs are deprecated… New integrations should use V3 exclusively"* and the `/api/v1/alarms` family is gone from the specification entirely. Any future adapter targets v3. The agent dashboard iframes cleanly (`x-frame-options` defaults to empty), so an embed is available if a later surface wants one.

## `integration_health`: the only new table

[Companion Services](../../product/companion-services/#integration-health-as-a-loxep-feature) sketched this table. [Phase 6](../services-billing-schema-design/#external-resource-integration-surfaces) says its companion integrations *"reuse the `integration_health` subject model… No new table."* Phase 7 lists the overlap between it and `managed_domains`' private health columns as an unresolved tension. **Three designs assume a table that does not exist.** Phase 8 is where it gets built, because Phase 8 is the first phase whose entire value proposition is health rollup.

```text
integration_health
subject_type            text not null
subject_id              uuid not null
status                  text not null
source                  text not null
checked_at              timestamptz not null
last_success_at         timestamptz null
last_failure_at         timestamptz null
consecutive_failures    integer not null default 0
detail                  jsonb not null default '{}'
updated_at              timestamptz not null
primary key(subject_type, subject_id)
check(subject_type in ('connection','notification_endpoint','storage_backend',
                       'external_resource','hosting_target','managed_domain'))
check(status in ('ok','degraded','failing','unknown'))
check(source in ('probe','adapter','ingest','report'))
check((status = 'ok') = (consecutive_failures = 0))
```

The decisions worth arguing:

- **One row per subject, overwritten in place.** This is the phase's enforceable boundary marker. An append-only health table with a `checked_at` key is a time series, and a time series of host status is the product Loxep must not build. The primary key *is* the upsert probe, so a sweep is idempotent by construction, matching the discipline `dns_drift_findings` uses for its unresolved partial unique.
- **No surrogate key.** `(subject_type, subject_id)` is total and stable; a uuid on this row would exist only to be ignored. The precedent is `resource_links`, which carries no surrogate key for the same reason.
- **`subject_id` is deliberately not a foreign key**, because it is polymorphic across six tables. This is a real cost, honestly stated: nothing stops an orphan row when a connection is deleted, and the owning service must clear its own health row in the same transaction as the delete. The precedents are `reconcile_runs.subject_id` and `journal_entry_source_links`, both of which made this trade for the same reason. It is the one place this design accepts weaker integrity than the rest of the schema, and the mitigation is a service rule with a test, not a constraint.
- **`source` distinguishes how the row was learned**, which changes how it should be read. `probe` means Loxep checked. `adapter` means Loxep read a tool's API. `ingest` means a webhook told us. `report` means an out-of-band push (a backup job's success callback). A `report` from a tool that has since died goes silently stale, so **staleness is derived from `checked_at`, never asserted as a status** — there is no `stale` value. This is the same discipline Phase 7 applied when it refused to make `degraded` a state.
- **`integration_health` never drives retry or backoff.** That resolves the Phase 7 tension rather than papering over it: `managed_domains.consecutive_errors`, `connections.last_error_at`, and `monitor_targets.backoff_until` stay authoritative for their own retry behavior, and this table is a **derived rollup** for display and for deciding whether anything needs attention. Two copies with different jobs, one of them derived from the other, is [cross-domain rule 4](../domain-boundaries/#cross-domain-rules), not duplication. **Nothing may be dropped from the owning tables when this ships** — see [open questions](#open-questions).
- **`detail` is the one jsonb, and it is small, Loxep-owned, and redacted.** Counts, a short message, an error taxonomy kind. Never a provider response body, never a header, never a URL carrying credentials. The contract permits raw payloads only at explicit provenance boundaries, and this is not one. Per-adapter redaction follows the [ADR-0021](../../decisions/0021-order-payload-retention/) `redact*` precedent.
- **`check((status = 'ok') = (consecutive_failures = 0))`** is a cheap cross-column invariant in the same spirit as `order_fees`' scope check: a green row with a failure streak is a bug that would otherwise render as a green dashboard.

**Ownership: shared foundation, not Infrastructure.** Four of its six subject types are foundation records that have nothing to do with the fleet, and two other phases already depend on it. It lives in `@loxep/domain` alongside the connections, settings, and secrets services. Infrastructure and the fleet are *consumers*, exactly as Commerce is a consumer of the shared scheduling model.

### What Phase 8 does not create

```text
metric samples, time series, hypertables         the boundary marker; permanently out of scope
uptime checks over operator-entered URLs         Gatus/Uptime Kuma; see the probe section
container, image, stack, or host records         Phase 7 already excludes these permanently
command execution, SSH, terminal proxying        same
configuration files written onto any host        same — including Gatus YAML
a second notification ledger                     alerts are delivered by the tools, to ntfy
changes to notification_deliveries               deliberately none; see open question 1
a health history table                           deferred, and it must stay a deliberate decision
per-tool foreign keys on any domain table        external_resources exists precisely to prevent this
economic-entity attribution                      cross-domain rule 12; installation-scoped, like Phase 7
an agent, a collector, or anything installed     Loxep ships one container; that does not change
  on a monitored host
```

## The link model, and its vocabulary

No new table. [`external_resources` and `resource_links`](../foundational-data-model/#external-companion-resources) shipped in Phase 0 for exactly this, and `resource_links` gained `unique(external_resource_id, resource_type, resource_id, purpose)` so a link is an idempotent upsert probe. Following [Phase 6's vocabulary table](../services-billing-schema-design/#external-resource-integration-surfaces) precisely:

```text
provider     external_type   resource_type    purpose
------------ --------------- ---------------- ------------------------
beszel       system          hosting_target   host_metrics
beszel       hub             hosting_target   metrics_console
gatus        endpoint        hosting_target   uptime_check
gatus        endpoint        managed_domain   uptime_check
gatus        dashboard       hosting_target   status_page
dockhand     environment     hosting_target   container_console
dockhand     stack           hosting_target   stack
netdata      node            hosting_target   host_metrics
cockpit      host            hosting_target   host_console
uptimekuma   monitor         managed_domain   uptime_check
tailscale    device          hosting_target   private_network
termix       host            hosting_target   terminal_access
```

Three rules carry over unchanged and one is added:

- **`metadata` holds sync metadata only** — last-observed instant, the tool's own status string, an ETag. Never a copy of the tool's data. The moment a container list is authoritative in two places, one of them is stale.
- **Direction of authority is fixed per purpose.** Every purpose above is *tool-authoritative*: Beszel owns host metrics, Gatus owns uptime results, Dockhand owns container state. Loxep records the link and the latest status, and nothing more. Not one purpose in this phase makes Loxep authoritative — which is the tell that the phase is on the right side of the inherited line.
- **No provider-specific column anywhere.** There is no `hosting_targets.beszel_system_id`.
- **New:** a link is what makes a tool's health *attributable*. A Gatus endpoint failing is interesting; a Gatus endpoint failing that is linked to the hosting target three managed domains point at is the fleet view [Workspaces](../../product/workspaces/#infrastructure-is-a-future-peer-root-and-it-is-about-the-installation-itself) reserved the workspace for. The correlation is the product; the link row is the whole mechanism.

**The known-tool registry is code, not schema.** Each supported provider needs an icon, a label, a documented health path (`/api/health`, `/ping`, `/health`), and whether it is embeddable. That is a small typed constant in `@loxep/domain` keyed by `provider`, in the shape of the integrations catalog — never a table, and never a column on `external_resources`.

**Link-only tools do not get an integrations-catalog card.** `/settings/integrations` is the catalog of services Loxep *integrates with* — a card there implies an account, a credential, and a connection. A Cockpit deep link has none of those. Link-only tools are created from an "Add tool link" form on a fleet record and documented under Guides. Only tiers 3 and 4 earn a catalog entry, because only they create a `connections` row.

## Connections, credentials, and reachability

Tier 3 tools are ordinary provider connections, created in-app and never in Compose:

```text
connections.provider = 'gatus'  | 'beszel'
connections.config              base URL; for Gatus, the observed auth mode
connection_credentials          gatus_credentials  { username, password }   (basic auth)
                                beszel_credentials { email, password }      (PocketBase superuser)
application_secrets             infrastructure.gatus_push.<id>  { token }   (outbound push)
```

- The base URL is **non-secret connection config**, exactly as a WooCommerce store URL is, and for the same reason: it must stay readable without a decryption round-trip.
- The Beszel bundle is named for what it is. A form field labelled "API token" over a superuser password is the kind of small dishonesty that later gets someone to reuse a password.
- **Reachability is a deployment fact this design must not assume.** These hubs commonly live on a private network, behind a tunnel, or on a Tailscale address. Loxep reaching them is not guaranteed by the fact that a human's browser can. Every tier-2 and tier-3 subject must therefore render "unreachable from Loxep" as a **distinct, explained state**, not as `failing` — otherwise a network topology problem reads as a fleet outage. This is the most likely first-day support question in the whole phase.
- No adapter may follow a redirect to a different host, and no adapter may send its credential to a URL it did not construct from stored config.

## Probing, jobs, and where cadence lives

```text
health.sweep         one recurring Graphile Worker job
                     reads integration_health + the subject registry
                     probes only subjects whose next check is due
                     upserts one row per subject
```

**Recommendation: a single recurring sweep, and no `monitor_targets` rows.** Phase 7 registered a target type against the shared scheduling model because a domain's reconcile cadence is genuinely per-subject and operator-tunable. Health probing is neither: the cadence is uniform, there is no per-subject intent worth an operator setting, and the contract's rule is specifically against *one permanent cron per monitored item* — one cron for the whole sweep is the shape the contract prescribes.

Due-ness and backoff need no extra column. `checked_at` and `consecutive_failures` are already on the row, so the sweep computes the next check as `checked_at + interval(consecutive_failures)` and skips what is not due. A dead host backs off to a long interval on its own, and the state that drives the backoff is the same state the UI renders.

Phase 7's [open question 5](../infrastructure-control-design/#open-questions) asks the same question for reconcile cadence and reaches a different answer. That is not a contradiction — the cases genuinely differ — but the owner should answer both together, because answering them inconsistently for bad reasons is easier than answering them differently for good ones.

Handlers are idempotent by the primary key. A probe carries no credential in its job payload: it passes the subject key and resolves the credential inside the task, per Configuration & Secrets rule 5.

## Evidence ingestion, if it ships

Everything above needs no inbound HTTP surface. Tier 4 does, and that surface **does not exist today**: `apps/web/src/routes/` has four API routes (Better Auth, the eBay OAuth callback, avatar upload, avatar fetch) and no webhook receiver. [Principle 15 and the contract](../../development/implementation-contract/#external-api) design *toward* a stable `/api/v1`; none is built.

So tier 4 is not a small addition to Phase 8 — it is the first inbound integration surface Loxep has ever had, and it should be judged as that:

```text
POST /api/v1/hooks/fleet/:connectionId
     Authorization: Bearer <per-connection ingest token>

  -> verify token against connection_credentials (constant-time)
  -> write ONE source_events row  (the existing inbound provenance envelope:
     connection identity, event type, external id, payload, payload hash,
     processing state) — no new table
  -> enqueue a job that projects it into integration_health with source='ingest'
  -> write NO notification_deliveries row, ever
```

Reusing `source_events` is the whole reason this costs no schema: it is *"the durable ingestion envelope [for] what an external provider delivered"*, with payload-hash deduplication already in it, and an alert webhook is exactly that. Retention follows [ADR-0021](../../decisions/0021-order-payload-retention/)'s per-object-class reasoning.

The security properties are the hard part, and they are why this is [OWNER-REVIEW-CRITICAL](#open-questions): the endpoint must be unauthenticated by session and authenticated by a per-connection bearer token; it must be rate-limited and size-capped before parsing; it must never echo the payload back; a bad token must not distinguish itself from an unknown connection in the response; and once the URL has been pasted into five tools' configuration, withdrawing it is a fleet-wide reconfiguration rather than a deploy.

Gatus makes this the most attractive it can be, because Loxep dictates the payload rather than parsing one. Beszel, Netdata, and Dockhand all offer generic webhooks with their own shapes, which means one small normalizer per provider at the integration boundary — never in the receiver.

## Where this surfaces

Following [Frontend Standards](../../development/frontend-standards/) throughout — the donor `DataTable` stack, `useAppForm`, semantic tokens.

```text
/infrastructure              adds a fleet-health summary beside the domain/drift summary:
                             subjects by status, what is failing, what is stale
/infrastructure/fleet/$name  a "Tools" panel per hosting target: every linked tool with
                             its latest status, its source, when it was last checked,
                             and a deep link that opens the real tool
/settings/integrations       catalog cards for tier-3 tools only
/settings/connections        Gatus/Beszel accounts, like every other provider account
/dashboard/overview          the Operations health band gains fleet subjects
```

Three behaviors that are design constraints rather than presentation choices:

- **Every status renders its provenance.** "Beszel says this host is up, read 4 minutes ago" and "Loxep could not reach Beszel for 20 minutes" are different statements and must look different. A status with no visible age is a status an operator will over-trust.
- **A deep link opens the tool, not a Loxep copy of it.** No embedded container list, no metric chart, no proxied terminal. Where an embed is genuinely available (Netdata) it may be offered as an option; Cockpit's same-origin constraint and Beszel's lack of support mean it must never be assumed.
- **The Operations band keeps [its existing rule](../../product/workspaces/#dashboard-workspace): real data only.** A fleet with no linked tools renders as absent, not as green. "Nothing configured" and "everything healthy" must never look alike — on a fleet dashboard that confusion is the one that gets somebody paged at 3am for nothing, or worse, not paged at all.

## Migration plan sketch

One table, one migration, no alterations.

```text
1. integration_health   (no foreign keys; polymorphic subject by design)
```

Indexes — volumes are tens of subjects, not thousands:

```text
integration_health   primary key(subject_type, subject_id)      the upsert probe and the only lookup
integration_health   index(status) where status <> 'ok'         "what needs attention"
integration_health   index(checked_at)                          the sweep's due-work scan
```

Not indexed on purpose: `source` and `subject_type` alone — low cardinality, always accompanied by a subject or a status.

Which existing tables gain columns: **none.** `external_resources` and `resource_links` are used exactly as shipped; `connections` gains provider values, not columns; `application_secrets` gains purposes, which is what that column is for; `notification_deliveries`, `notification_rules`, and `market_events` are untouched by design.

Verify at implementation time: Drizzle Kit support for a composite primary key with `CHECK` constraints referencing more than one column, and drop to hand-written SQL rather than weakening the invariant — the same instruction every earlier phase gives.

## Open questions

Each is a genuinely unresolved decision with a recommendation. **A recommendation is not an answer.** Items marked **OWNER-REVIEW-CRITICAL** are either irreversible in practice or are where the [Phase 7 non-goal tension](../infrastructure-control-design/#the-non-goal-this-design-runs-against) bites hardest.

1. **OWNER-REVIEW-CRITICAL — Does Loxep ever become the delivery path for infrastructure alerts?** This design says no: the tools detect and deliver to ntfy; Loxep records evidence.

   *Recommendation:* hold that line. Loxep runs on the fleet, so it cannot alert on its own outage, and ntfy already unifies the alert stream without Loxep in it. Making Loxep a relay would additionally require altering the shipped `notification_deliveries` ledger from market-event identity to a polymorphic subject — real work, undertaken to become a slower ntfy.

   *The owner must confirm:* that per-transport fan-out and Loxep-authored rules for infrastructure alerts are not wanted. This is marked critical because it is irreversible in the way that matters — once operators rely on Loxep for host alerts, the alert that never fires during a Loxep outage is unrecoverable, and removing the feature afterward is a trust event.

2. **OWNER-REVIEW-CRITICAL — Does Loxep run its own uptime probes?** This design says no for arbitrary endpoints and yes for registered subjects Loxep depends on.

   *Recommendation:* hold the subject-based line, and treat "a form whose first field is a URL the operator types" as the review test. Gatus and Uptime Kuma are mature, they run independently of Loxep, and one of them can watch Loxep itself.

   *The owner must confirm:* that endpoint monitoring stays a companion capability permanently. This is where the [Master Domain Map's non-goal](../../product/master-domain-map/#what-loxep-is-not) bites hardest, because uptime monitoring is the easiest thing in this phase to build and the least defensible.

3. **OWNER-REVIEW-CRITICAL — May Loxep store a Beszel superuser credential?** The read adapter has no other option; there is no scoped read token.

   *Recommendation:* ship tier 2 (unauthenticated `/api/health` plus a link) first and treat tier 3 as a separate decision. If it is taken, label the field honestly as a superuser account, use a dedicated Beszel account rather than the operator's own, and document that Loxep never calls a `PATCH`.

   *The owner must confirm:* that fleet-wide monitoring-hub administrative access, held in Loxep's database, is an acceptable price for a status summary. It is effectively irreversible: once the credential has been stored and used, withdrawing consent means rotating it.

4. **OWNER-REVIEW-CRITICAL — Does Loxep expose an inbound webhook receiver?** Tier 4 needs one; Loxep has never had one.

   *Recommendation:* defer it behind the first three questions and treat it as the opening move of the `/api/v1` surface rather than a fleet feature, with its own review of authentication, rate limiting, size caps, and error-response uniformity. The health rollup is useful without it.

   *The owner must confirm:* whether a publicly reachable ingest path on the installation is wanted at all. Once the URL is configured in several tools, withdrawing it is a fleet-wide reconfiguration, and a leaked token is a durable spam and forgery vector into health state.

5. **OWNER-REVIEW-CRITICAL — Is "no mutating call to any fleet tool" a permanent rule?** This design says yes, and it is the rule most likely to be eroded by a reasonable-sounding request ("just a restart button for a container we can already see").

   *Recommendation:* make it permanent and testable — an adapter-level rule that only `GET` (plus the Gatus health push) may leave the fleet integration boundary, with a test per adapter rather than a code-review convention. The moment a restart button exists, Loxep is a container manager with a small feature set.

   *The owner must confirm:* that no lifecycle action ever appears in `/infrastructure`, and that the deep link is the permanent answer.

6. **Does `integration_health` ship as shared foundation, and does Phase 7 project into it?** Phase 6 and Phase 7 both assume the table; Phase 7 also carries private health columns.

   *Recommendation:* ship it in `@loxep/domain` as shared foundation, have Phase 7 write a projection alongside its own columns, and **never drop the owning tables' columns** — they drive retry and backoff, which this table must not. Reversible either way, which is why it is not marked critical, but shipping a fifth private copy of health state instead would make three documents false at once.

   *The owner must confirm:* the ownership call, and whether `hosting_target` and `managed_domain` belong in the subject set from the first migration or are added when Phase 7 lands.

7. **Does health history ever get stored?** This design stores current state only, deliberately.

   *Recommendation:* keep it that way. "How often was this host down last month" is Gatus's and Beszel's question and both answer it well; a Loxep history table is the first step toward the observation store this phase exists not to build. If it is ever wanted, it must arrive as an explicit ADR naming what Loxep can answer that the tools cannot.

   *The owner must confirm:* that a status timeline in `/infrastructure` is not expected.

8. **One metrics adapter, or none?** Beszel and Netdata occupy the same slot; Netdata has the better API and no credential model.

   *Recommendation:* at most one, ever, and Beszel if any — it is [already the recommended companion](../../product/companion-services/#infrastructure-operations), it is MIT, and it has a real credential to store. Netdata stays tier 2 plus an optional embed.

   *The owner must confirm:* which metrics tool the estate actually runs, since building the adapter for the other one is pure waste.

9. **Does Loxep publish its own health into Gatus?** The `external-endpoints` push is the cheapest new capability in the phase.

   *Recommendation:* yes, and first. It is the only mechanism here that solves the self-monitoring problem, it needs no new table, and its blast radius is one bearer token that can mark one Gatus endpoint healthy.

   *The owner must confirm:* which facts should be published — worker backlog, sync freshness, drift count, readiness — since each becomes visible outside Loxep, and that a Gatus instance exists to receive them.

10. **Do link-only tools stay out of the integrations catalog?** This design says yes: a catalog card implies an account and a credential.

    *The owner must confirm:* nothing security-relevant; flagged because it is the kind of detail that gets decided silently and wrongly, producing a `/settings/integrations` page full of bookmarks.

## Contradictions and tensions found in existing documentation

Recorded for a human to resolve; this document does not attempt to fix them.

1. **Companion Services names Dockhand as the container-management companion, and this design gives it the weakest verdict of the six.** That recommendation predates Dockhand's current state — the project did not exist when Loxep's companion list was written. Nothing here argues against *using* Dockhand; it argues against Loxep *integrating* with it. If the recommendation stands, the reason it stays a link should be recorded next to it, so a later reader does not mistake the tier-1 verdict for an oversight.

2. **The Master Domain Map's non-goal versus this phase's existence — again, and more sharply than Phase 7.** Phase 7 argued a narrow carve-out for DNS intent. Phase 8 has no equivalent argument to make and does not try: every capability here is either a link, a link plus a probe, or a read. That is the strongest form of the non-goal, not an exception to it. If the map's bullet is tightened as Phase 7 proposed, this phase is the evidence that the tightening is honest.

3. **`integration_health` is assumed by three documents and built by none.** Companion Services sketches it, Phase 6 states its integrations reuse it, Phase 7 lists the overlap with its own columns as an open tension. Whichever phase implements first must adopt the shape here or amend it; shipping a fourth private copy of health state would make all three documents false simultaneously.

4. **Phase 7 registers a scheduling target type; Phase 8 recommends a single sweep.** Both cite the same [shared scheduling rule](../domain-boundaries/#scheduling-is-shared-foundation-infrastructure) and reach different answers, for reasons stated in each. They should be reviewed together. If the shared model is chosen for both, Phase 8 becomes a fourth registering domain and the runtime registration seam Phase 7 raised is no longer optional.

5. **The notification foundation is described as transport-neutral and is only half so.** [The foundational data model](../foundational-data-model/#notifications) presents notifications generically — endpoints, rules, deliveries — while the shipped `notification_deliveries` is keyed on `market_event_id NOT NULL`. The transport interface genuinely is neutral; the ledger and rule matcher are market-shaped. That is a reasonable Phase 1 decision and it is not what the foundation document says. Whether it is generalized or the document is corrected, the two should agree before a second domain tries to send a notification.

## Before implementing this phase

1. resolve open questions 1 through 5 — questions 1, 2, and 5 decide whether the phase's shape is correct at all, and questions 3 and 4 are unrecoverable once a credential is stored or a URL is distributed;
2. re-verify every upstream claim in the [per-tool verdicts](#per-tool-verdicts) against current sources. Netdata shipped 2026-08-12 and Dockhand 2026-08-09; Beszel is pre-1.0 and warns that its shapes change in minor releases. Nothing in that table should be trusted at implementation time because it appears here;
3. confirm the Gatus auth-mode branch against a running instance before shipping a reader — the OIDC case cannot authenticate at all, and a reader that silently shows a partial status page is worse than one that refuses;
4. decide the `integration_health` ownership question (6) before the migration, since it determines the package and whether Phase 7 projects into it from day one;
5. write the sweep's idempotency tests before the sweep: two probes of the same subject, a subject deleted between probe and write, an unreachable subject rendering as unreachable rather than failing, and a stale `report` row deriving staleness from `checked_at`;
6. assert by test, per adapter, that no method other than `GET` can leave the fleet integration boundary — this is open question 5's rule made enforceable rather than aspirational;
7. assert by test that no fleet adapter writes a `notification_deliveries` row, so question 1's resolution cannot be eroded quietly;
8. confirm no probe or adapter can place a credential into `integration_health.detail`, a job payload, or a log line — a test per adapter, not a code review;
9. keep provider shapes at the integration boundary ([ADR-0009](../../decisions/0009-integration-boundaries/)); PocketBase record types and Gatus status structs must not become Loxep types;
10. update this document, the roadmap, Workspaces, and Domain Boundaries when implementation reality diverges, rather than letting the documentation drift.

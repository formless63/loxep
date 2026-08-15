---
title: Pangolin Integration & Chain-Provisioning Templates
---

This document designs the **last provider in the Phase 7 chain** and the **template engine that drives the whole chain from one form**. [Infrastructure Control Plane Design (Phase 7)](../infrastructure-control-design/) named the reverse-proxy/tunnel provider, reserved its task name and its column, and shipped without it. Everything here lands into those reservations rather than beside them.

**Design work, with milestone 1 now shipped on top of it.** No migration, Drizzle schema, service, or route beyond milestone 1's own scope is authorized by this page. Every upstream fact below carries the URL and the date it was fetched; milestone 1's implementation additionally verified the adapter surface against `fosrl/pangolin@main`'s own source (stronger grounding than documentation prose) and ran one live reconnaissance pass — see the **M1 CLOSEOUT** note immediately below and the corrections folded into [the adapter surface](#the-adapter-surface) and [endpoints section](#endpoints-and-the-verb-convention-that-will-bite).

This is also the first integration in Loxep whose writes can **lock the owner out of their own services**. A wrong bypass rule, a deleted resource, or a rule update that replaces a working address with a wrong one removes the operator's own access to the estate — including, in this installation, access to Loxep itself. The [write-authorization model](#the-write-risk-model) is therefore the load-bearing part of this design, not the adapter surface, and it is flagged **OWNER-REVIEW-CRITICAL**. Nothing about milestone 1 touches this section: M1 has no write verb at all.

**Implementation status, updated 2026-08-15 (`loxep-acj.2`, M2 shipped on top of M1):** `@loxep/integration-pangolin` (M1) ships the read surface, the five-kind taxonomy, the rate budget, the credential bundle (`pangolin_credentials` in `@loxep/domain`), the redactors, a catalog entry + guided form + connecting guide, and a live reconnaissance run (see the closeout note below). M2 lands the reserved contract into `packages/infrastructure/src/tasks.ts` for real: `proxy-port.ts` (the `ProxyProviderPort` + pure planner), `proxy.ts` (`infrastructure.sync-proxy-resource`'s service, CHECK MODE ONLY), migration `0027` (`proxy_resources`/`proxy_resource_rules`, and `reconcile_runs.subject_type` widened to include `proxy_resource`), and `packages/app`'s composition-root wiring (`pangolin.ts`'s per-connection adapter factory, `infrastructure-proxy.ts`'s `proxyProviderPortFromPangolinAdapter` + task registration in `registry.ts`). `hosting_targets.proxy_connection_id` (nullable since migration `0012`) now drives the provider resolution for real; `hosting_targets.external_site_id` is exposed on the same fleet-detail panel that links a connection. Fleet detail (`/infrastructure/fleet/$name`) and domain detail (`/infrastructure/domains/$name`) render the chain. Nothing writes to Pangolin: the M1 adapter has no write verb at all, and `proxy.ts`'s `reconcile()`/`reconcileDomain()` both throw `ProxyWritePolicyError` before any provider call if `mode: 'apply'` is ever requested — the write-authorization gate (M3, `loxep-acj.3`) has not shipped. Children are filed under `loxep-acj`.

:::note[M1 closeout — read this before M2]
Milestone 1's live reconnaissance (2026-08-15, against the owner's real instance, read-only) found the standalone Integration API server's port is **not reachable from the build/CI network on any path tried** — not the public origin, not any of five plausible dedicated-subdomain guesses, not a confirmed direct Tailscale connection to the actual Pangolin host. One genuine live confirmation did land: the dashboard's own sibling `/api/v1` route (session-cookie-gated, sharing the same response-wrapper code) answered `HTTP 401` with `{"data":null,"success":false,"error":true,"message":"Unauthorized","stack":null}` — live proof of the envelope shape this design predicted from documentation, even though the bearer-authenticated Integration API surface itself remains unverified against a live read. `test/live-pangolin.test.ts` records this as a `not_found` classification (an HTTP 404 from the dashboard's own catch-all route) rather than crashing, and is written to start exercising real reads with no code change once the operator's instance has a working reverse-proxy route for the Integration API's port. Two source-verified corrections against this document's original endpoint table are folded in below: the canonical resource path is `/resource` (not `/public-resource`, which is a registered alias), and every list endpoint except DNS records nests its array under a named key plus a `pagination` object rather than answering a bare array. M2 should re-run the live suite as its own first step, once reachability is fixed, before building the reconciler on top of unverified read shapes.
:::

:::note[M2 closeout — read this before M3]
The Integration API's reachability had not changed as of M2's implementation (2026-08-15): still unreachable from this build network, so M2's own live-verification attempt was not re-run — re-running `test/live-pangolin.test.ts` (`LOXEP_LIVE_TESTS=pangolin`) remains the correct first step once the operator adds the missing reverse-proxy route, and it needs no code change to start reporting real counts. Every M2 test (`packages/infrastructure/test/proxy-port.test.ts`, `proxy.test.ts`, `targets.test.ts`; `packages/app/test/infrastructure-proxy.test.ts`) drives a fake `ProxyProviderPort` or a stub `PangolinAdapter` — noted honestly rather than silently, per this design's own opening instruction. One structural choice worth recording for M3: `proxy_resources`/`proxy_resource_rules` carry no target-intent table (`ObservedProxyTarget`/`DesiredProxyTarget` exist in the port's type surface and are exhaustively planner-tested, but `proxy.ts`'s real `buildDesired()` always supplies an empty `targets: []` this milestone) — a resource's origin is expressed once, as `proxy_resources.hosting_target_id`, and Pangolin's own per-target `{siteId, ip, port}` shape has no Loxep-side intent column yet. M3 (or whichever milestone first needs to CREATE a target) is where that gap gets a real answer — a computed target from `hosting_targets`' own address plus a new port column, or a dedicated intent table — rather than this milestone guessing at one no write path exercises. `hosting_targets.proxy_connection_id`/`external_site_id` are now editable in-app (`/infrastructure/fleet/$name`'s new "Proxy connection" panel, `HostingTargetsService.updateProxyConnection`) — the one write this milestone ships anywhere, and it edits Loxep's own row, never Pangolin.
:::

## What already exists, and what this design may not re-invent

Nothing below is new machinery. The reconciler, the ledger, the run history, and the drift model all shipped in Phase 7 milestones 1–3 and Phase 8 milestone C, and this design's whole job is to add one provider and one compiler on top of them.

```text
materialize.ts        pure intent -> desired records                  SHIPPED
reconcile.ts          pure diff; apply and check are ONE code path    SHIPPED
sync.ts               runRecordSync: read -> diff -> (apply) -> findings, step-logged
                                                                      SHIPPED
drift.ts              dns_drift_findings; never deletes 'unexpected'  SHIPPED
operations.ts         provider_operations: pending BEFORE the call,
                      never blindly retried, resolved by read-back    SHIPPED
container-hosts.ts    the newest reconciler leg: a per-CONNECTION
                      subject, a pure planner, no drift table         SHIPPED
mail-sync.ts          the resumable desired-state loop with a gate
                      in the middle that takes DAYS                   SHIPPED
```

Three of those are load-bearing precedents this design follows rather than restates:

- **`container-host-port.ts` is the port template.** A Loxep-owned observed type, a payload type, a **closed** operation union, a `*Capabilities` interface, the `read`/`apply`/`capabilities` triple, and a pure planner — plus an explicit statement of what is deliberately absent. Its operation union has no `delete` "so that adding a delete requires an owner ruling rather than a one-line union member". This design copies that sentence and means it harder.
- **`container-hosts.ts` resolves the provider PER SUBJECT, not per installation.** `createRecordSyncService` takes one installation-wide `provider` because there is one DNS account; `reconcile()` takes a `ContainerHostProviderPort` as an *argument* because a host can be registered against any of several connections. **Pangolin is the second case and must follow it** — see [multi-instance](#multi-instance-is-already-solved).
- **`mail-sync.ts` is the template engine's ancestor.** Its module doc is the argument this design reuses wholesale: a workflow with a step in the middle that takes days *cannot* be a linear script, so `runMailDomainSync` "advances the domain as far as it currently can, records exactly where it stopped, and returns". The template engine is that shape, generalized to six steps and three providers — and to **nothing more than that**.

### The reserved contract this design lands into

`packages/infrastructure/src/tasks.ts` already carries the name and the payload, with no service behind them:

```text
SYNC_PROXY_RESOURCE_TASK = "infrastructure.sync-proxy-resource"
interface SyncProxyResourcePayload { domainId: string }
job key                    domain:{id}:proxy
trigger                    a HOSTING change — a domain's apex target, or a
                           target's proxy_connection_id / external_site_id
registered in registry.ts  NO, deliberately, so an accidental enqueue fails
                           loudly as an unrecognized task
```

`hosting_targets.proxy_connection_id` (nullable FK to `connections`) and `hosting_targets.external_site_id` (text) shipped in migration `0012` for this and have been unused since. `dns_records.owner` already accepts `'proxy_resource'`, and `managed_domains`' materialized-owner set in `domains.ts` already includes it. **No migration is needed to make the DNS half of the chain work.**

## The chain, end to end

```text
registrar  ──delegation──>  Cloudflare zone
                                 │
                     dns_records owner='apex'/'wildcard'/'proxy_resource'
                                 │   A/AAAA @ and *  ->  the Pangolin node's address
                                 v
                          Pangolin resource            full domain, SSL, auth,
                                 │                     rule set
                                 ├── target ────────>  hosting_target (the origin,
                                 │                     reached over the newt tunnel)
                                 └── rules ─────────>  bypass / allow / block
                                 
                          Purelymail domain  ──> noreply@ user, routing rules
                                 ^
                                 └── its seven DNS records are written at CLOUDFLARE,
                                     never at Purelymail
```

Two facts about that picture decide most of this design:

1. **Every arrow already has an owner except the two Pangolin ones.** The Cloudflare arrows are `sync.ts`; the Purelymail arrows are `mail-sync.ts`; the hosting-target arrow is `materialize.ts`'s fronting-chain walk. The template engine does not re-implement any of them — it *sequences* them.
2. **The Purelymail leg writes no DNS.** Purelymail's required record set is computed **locally**, with no API call (`requiredRecords({domainName, ownershipCode})` in `@loxep/integration-purelymail`, seven records: MX at priority 50, SPF TXT, ownership TXT, three DKIM CNAMEs, and `_dmarc` as a **CNAME**, not a TXT). Those records are published at Cloudflare by the existing materializer. The only Purelymail *writes* the template needs are `addDomain` and `createUser`.

## The API verdict

Every fact below was fetched **2026-08-15** from Pangolin's own documentation, its live OpenAPI specification, or its source. Where the documentation is silent and the answer came from source, that is said. Current release at the time of writing is **1.21.1** ([release notes](https://github.com/fosrl/pangolin/releases/tag/1.21.1), 2026-07-30). `docs.fossorial.io` now redirects to [`docs.pangolin.net`](https://docs.pangolin.net/manage/integration-api.md).

### The stability statement, first, because it changes the adapter's shape

> *"Pangolin is in heavy development. The REST API routes and behavior may include breaking changes between updates. We will do our best to document large changes."*
> — [Integration API](https://docs.pangolin.net/manage/integration-api.md), 2026-08-15

There is no changelog, no deprecation policy, no `info.version` beyond the literal string `"v1"`, and deprecations happen **in place** (the resource schema's `http` and `protocol` fields are marked *"Deprecated. Use `mode` instead. Legacy compatibility only"* while still being accepted). Phase 7's own provider-shape warning applies directly: *"structure the adapter as one generic call function plus a single exported map of operation names — so correcting a wrong name is a one-line change rather than a refactor."* Pangolin publishes a **fetchable OpenAPI document** at `/v1/openapi.json` (unauthenticated), so the second half of that warning — extract the schema rather than transcribing method names — is not merely possible here, it is the obvious move.

### Auth

```text
header        Authorization: Bearer <apiKeyId>.<apiKeySecret>
NOT           X-API-Key   (a live probe returns "API key required" — the key is ignored)
tiers         Organization API keys  scoped to ONE org
              Root API keys          cross-org; SELF-HOSTED EDITIONS ONLY
scoping       granular ACTION lists per key (~182 actions, e.g. createResourceRule,
              updateTarget, createOrgDomain); every route is guarded by
              verifyApiKeyHasAction
surface       a SEPARATE Express server on port 3003, path prefix /v1,
              enabled by flags.enable_integration_api: true
              (self-hosted: https://docs.pangolin.net/self-host/advanced/integration-api.md)
```

Sources: [Integration API](https://docs.pangolin.net/manage/integration-api.md); key format verified in [`server/middlewares/integration/verifyApiKey.ts`](https://github.com/fosrl/pangolin/blob/main/server/middlewares/integration/verifyApiKey.ts) (splits the bearer token on `.`).

**Two consequences for Loxep, both good.** First, the granular action list means the owner can issue Loxep a key that *cannot* delete a resource even if Loxep asked — genuine scope-limiting of the kind Purelymail cannot offer at all. The connecting guide must name the exact action set per milestone. Second, the integration API is a *different port* from the dashboard, so the connection's base URL is not the dashboard URL the owner uses in a browser, and the guided form must say so or the first connection attempt fails confusingly.

### Object model

```text
Org        orgId is a STRING SLUG (e.g. 'home-lab'), immutable, visible in the
           dashboard URL. One instance hosts MANY orgs.
Site       type: 'newt' | 'wireguard' | 'local'.
           M1 CORRECTION, source-verified 2026-08-15: the pg schema's own
           inline comment (`server/db/pg/schema/schema.ts`) documents only
           `"newt" or "wireguard"` for this column; `'local'` does not
           appear there. `@loxep/integration-pangolin`'s `PangolinSiteFact`
           therefore types `type` as a plain string rather than this union
           until a live read confirms which values actually occur.
Resource   PUBLIC resources (proxied hostnames) and PRIVATE resources (ZTNA).
           Public create is an anyOf: an HTTP-ish shape {name, domainId,
           subdomain, mode: http|ssh|rdp|vnc|tcp|udp} or a raw shape
           {name, proxyPort 1..65535, mode: tcp|udp}.
           `http: boolean` and `protocol` are DEPRECATED in favour of `mode`.
Target     {siteId, ip, port, method, mode, enabled, path/pathMatchType,
           rewritePath, priority 1..1000, health-check fields}
Domain     org-level. type: 'wildcard' | 'ns' | 'cname'.
           {domainId, baseDomain, verified, type, failed, tries,
            configManaged, certResolver, preferWildcardCert}
niceId     sites, resources and clients carry a human-readable, org-unique
           stable identifier alongside the numeric id
```

Sources: [Organizations / org id](https://docs.pangolin.net/manage/organizations/org-id.md), [Understanding sites](https://docs.pangolin.net/manage/sites/understanding-sites.md), [Domains](https://docs.pangolin.net/manage/domains.md), and the live [OpenAPI spec](https://api.pangolin.net/v1/openapi.json).

**`niceId` is the join key.** It is exactly the `hosting_targets_name_uq` ↔ "unique display name" correspondence `container-host-port.ts` built its identity bootstrap on, except Pangolin *guarantees* org-uniqueness. Loxep prefers the numeric id once known and falls back to `niceId` — the same prefer-id-then-name rule, with no fuzzy matching, ever.

### Endpoints, and the verb convention that will bite

**`PUT` creates. `POST` updates.** That inversion of the usual convention is the single most likely source of a wrong-verb bug in this adapter, and it is worth a comment at the top of the operations map.

```text
sites       PUT  /org/{orgId}/site               create (returns newt credentials)
            GET  /org/{orgId}/sites | /org/{orgId}/site/{niceId} | /site/{siteId}
            GET|POST|DELETE /site/{siteId}
            GET  /org/{orgId}/pick-site-defaults  pre-generate newt id/secret

resources   PUT  /org/{orgId}/resource            create   (alias: /org/{orgId}/public-resource)
            GET  /org/{orgId}/resources                    (alias: /org/{orgId}/public-resources)
            GET|POST|DELETE /resource/{resourceId}         (alias: /public-resource/{resourceId})

targets     PUT  /resource/{resourceId}/target             (alias: /public-resource/{resourceId}/target)
            GET  /resource/{resourceId}/targets            (alias: .../public-resource/{resourceId}/targets)
            GET|POST|DELETE /target/{targetId}

RULES       PUT    /resource/{resourceId}/rule           create   (alias: /public-resource/{resourceId}/rule)
            POST   /resource/{resourceId}/rule/{ruleId}  update
            DELETE /resource/{resourceId}/rule/{ruleId}
            GET    /resource/{resourceId}/rules

domains     GET  /org/{orgId}/domains
            GET  /org/{orgId}/domain/{domainId}
            POST /org/{orgId}/domain/{domainId}                update
            GET  /org/{orgId}/domain/{domainId}/dns-records
```

:::note[M1 correction, source-verified 2026-08-15]
`fosrl/pangolin@main`'s `server/routers/integration.ts` registers `/resource`/`/resources` as the CANONICAL path for every resource/target/rule route above, with `/public-resource`/`/public-resources` as a registered alias — the reverse of how this table originally presented them (design-authoring time relied on documentation prose; this correction reads the Express route registrations directly). `@loxep/integration-pangolin` uses `/resource` as primary. Separately: **every list endpoint above except `.../dns-records` nests its array under a named key plus a `pagination` object** — `GET /org/{orgId}/sites` answers `data: {sites: [...], pagination: {...}}`, and the same shape holds for `orgs`/`resources`/`targets`/`rules`/`domains`. `GET .../dns-records` is the one exception, answering a bare array. Neither correction changes any verb, tier, or risk conclusion below — both are adapter-shape details, source-verified against the same commit the auth/envelope facts below already cite.
:::

Every response is wrapped in `{data, success, error, message, status}` — **confirmed twice**: in source, every router this adapter reads registers this exact OpenAPI response schema (`error` is a boolean flag, not a code string — Pangolin publishes no per-domain error-code table the way Purelymail does); live, 2026-08-15 against the owner's instance, an unauthenticated request answered `HTTP 401` with `{"data":null,"success":false,"error":true,"message":"Unauthorized","stack":null}` (see the M1 closeout note above for what that probe did and did not reach). Phase 7's warning applies literally: **an RPC-style envelope means HTTP 200 does not imply success**, and the adapter must branch on the envelope first and the status second — the identical shape `@loxep/integration-purelymail` already handles, where a live-verified auth failure arrives as HTTP 200 with `{"type":"error","code":"invalidToken"}`.

**Rule vocabulary, exactly as the spec has it** (the UI labels differ, and the design must speak API):

```text
action   'ACCEPT' | 'DROP' | 'PASS'
         UI:      Bypass Auth   Block Access   Pass to Auth
match    'CIDR' | 'IP' | 'PATH' | 'COUNTRY' | 'COUNTRY_IS_NOT' | 'ASN' | 'REGION'
value    string
priority int          rules evaluate top-down by priority
enabled  boolean
```

Source: [Rules](https://docs.pangolin.net/manage/access-control/rules.md) plus the spec. The owner's named need — "applying bypass rules to many resources" — is `action: 'ACCEPT'` with `match: 'CIDR'` or `match: 'PATH'`, and `loxep-v29`'s option 1 (scope an auth exception to the API path prefixes Loxep's Dockhand and Termix adapters use) is `match: 'PATH'` rules on those two resources.

### The three verdicts that shape the design

**1. There is NO bulk rule endpoint, and NO alias/IP-group primitive. Loxep must fan out.**

The rule endpoints above are strictly one-at-a-time per resource. The only "set all rules in one call" endpoint in the entire API is on **resource policies** — `POST /public-resource-policy/{resourcePolicyId}/rules`, documented as *"Set all rules for a resource policy at once. This will replace all existing rules"*, and verified in source to run inside a single database transaction. But resource policies are **[Cloud and Enterprise only](https://docs.pangolin.net/manage/resources/public/resource-policies.md)**, licence-gated at the route. The owner self-hosts.

The alias question has a definitive answer too, and it is no. Pangolin's "[Aliases](https://docs.pangolin.net/manage/resources/private/alias.md)" feature is a client-side DNS name for *private*-resource destinations and is not referenceable from a rule; the rule `value` is a plain string. The dedicated shared-IP-set pull request ([#1248](https://github.com/fosrl/pangolin/pull/1248)) was **closed unmerged** on 2025-10-07, the standing feature request ([discussion #2428](https://github.com/orgs/fosrl/discussions/2428)) is open, and the maintainer's answer to the rule-groups request ([#3497](https://github.com/orgs/fosrl/discussions/3497)) was *"I think this use case is covered by the resource policies"* — i.e. by the Cloud/EE feature.

What the community does instead is exactly what this design proposes: [`pangolin_rule_updater`](https://github.com/olizimmermann/pangolin_rule_updater) ([discussion #1326](https://github.com/orgs/fosrl/discussions/1326)) stores a list of `(resource_id, rule_id)` pairs and updates each one when the address changes. **So Loxep's named alias is not a nicety, it is the missing primitive**, and the fan-out is Loxep's to own. [Open question 4](#open-questions) resolves as "no provider primitive; build the Loxep-side alias" rather than staying open.

**2. Rule creates are NOT idempotent, and there is no concurrency control anywhere.**

A `PUT .../rule` always inserts; there is no upsert. There are no ETags, no `If-Match`, no version fields, and no idempotency keys anywhere in the specification (a grep of the full 273 KB document returns zero hits). Writes are last-write-wins.

That has a precise consequence: **every rule create is a non-idempotent provider create and must go through `provider_operations`** — `pending` inserted *before* the call, resolved after, never blindly retried. At-least-once job delivery plus a non-idempotent create is exactly the pairing that ledger exists for, and the failure it prevents here is a duplicated access rule, which is both confusing and a security-relevant surprise.

It is also the **ideal ledger case**, in `container-hosts.ts`'s vocabulary: a stuck `pending` resolves by calling `GET /public-resource/{id}/rules` and matching on `(action, match, value, priority)`. It never becomes an operator decision the way a token mint does.

**3. Rules can be DISABLED. This removes most of the need for a delete verb.**

Rule update carries an `enabled` boolean. Retiring a rule is therefore `POST .../rule/{ruleId}` with `enabled: false` — **reversible, recoverable, and tier 2 rather than tier 3**. This is a better answer than the one this design started with, and it is adopted: *retirement means disable, not delete.* The `DELETE` verb stays out of the operation union indefinitely, and [open question 2](#open-questions) narrows from "may Loxep delete?" to "does Loxep ever need to?" — to which the honest answer is probably not.

Note the one sharp edge: `priority` is **required** on rule update. An update that forgets to carry the current priority will move the rule in the evaluation order, which for an access rule is a behavior change disguised as a no-op. The planner must always send the full comparable set.

### Newt registration, API-side

`PUT /org/{orgId}/site` with `type: 'newt'` **returns `siteId`, `niceId`, `newtId`, and `secret`** ([Common API routes](https://docs.pangolin.net/manage/common-api-routes.md)). Credentials can alternatively be pre-generated with `GET /org/{orgId}/pick-site-defaults`. A newt client needs exactly three things — endpoint, id, secret ([Site credentials](https://docs.pangolin.net/manage/sites/credentials.md), [Install a site](https://docs.pangolin.net/manage/sites/install-site.md)) — and credential **rotation is Enterprise-only**.

**This design does not create sites, and the reason is ADR-0022.** A site create returns a secret exactly once, which is the reveal-once channel Phase 7 milestone 2 already discovered *does not reach a worker job*: there is no admin waiting on the response of a background reconcile. Loxep would mint a newt secret into a write-only store, and the operator could never read it to configure the newt container — the identical trap `sync-mailboxes` fell into. Site creation therefore stays a dashboard action, and Loxep **reads** sites to address resources at them. If it is ever wanted, it has to be a request-scoped admin action with a `RevealOnceDialog`, exactly like `mintDnsProviderToken` — never a template step, never a job.

### Domain creation is undocumented, unspecced, and edition-restricted

The owner's template step *"add the domain in pangolin"* runs into the one genuinely rough patch in this API. `GET /org/{orgId}/domains` and `POST /org/{orgId}/domain/{domainId}` are in the published specification. **`PUT /org/{orgId}/domain` and `DELETE /org/{orgId}/domain/{domainId}` are not** — they exist in `server/routers/integration.ts` in all builds but carry no OpenAPI registration at all, and their behavior is build-dependent: the open-source build permits only `type: 'wildcard'`, the hosted build only `ns`/`cname`, enterprise all three.

**Verdict: treat domain creation as unstable and do not put it on the happy path.** The template's domain step *resolves* an org domain by base name and blocks if it is absent, with copy telling the operator to add it in the dashboard — the same shape the Cloudflare zone step takes for the same reason (`@loxep/integration-cloudflare` has no zone-create verb either). If the M1 reconnaissance finds `PUT /org/{orgId}/domain` reliable on the owner's self-hosted build for `type: 'wildcard'`, it can be promoted to a real step later; shipping a template that depends on an unspecced endpoint is how a workflow breaks on a patch release.

### Blueprints: Pangolin's own declarative layer, and why Loxep does not compile to it

Pangolin ships [Blueprints](https://docs.pangolin.net/manage/blueprints.md) — declarative desired state (`PUT /org/{orgId}/blueprint`, base64-encoded JSON) that can define public resources *including their rules*, private resources, policies, and sites, applied inside a single database transaction. On the face of it this is a better target than N imperative calls: one atomic apply, and Pangolin's own idea of convergence.

**It is rejected as the primary path, and the reason is not aesthetic.** A blueprint apply is opaque: it returns success or failure for the whole document, so Loxep would lose per-operation results, per-step `reconcile_run_steps` evidence, the `provider_operations` ledger's per-create identity, and — most importantly — **check mode**. The reconciler's central property is that `apply` and `check` are *one code path*, which is what makes drift reports trustworthy; a blueprint has no check mode, so a blueprint-based reconciler would need a separate read-and-compare path, and the first time the two disagreed nobody would know which was right. That is the exact failure `reconcile.ts`'s module doc exists to prevent.

It stays recorded as a real alternative, and as the right answer if Loxep ever wants a genuinely transactional multi-rule apply — which is the one thing the per-rule endpoints cannot give. [Open question 6](#open-questions) is where that trade lives.

### Multi-instance is already solved

One Pangolin instance hosts many orgs; an org key is bound to one org; root keys are per-instance and self-hosted-only; there is no cross-instance federation of any kind. So **N instances means N base URLs and N keys** — which is precisely what the `connections` table models, with the base URL and `orgId` as non-secret `connections.config` (exactly as a WooCommerce store URL and a Medusa base URL already are) and the key in an ADR-0019 bundle.

Nothing in the schema assumes one. But **one thing in the code would**, if copied carelessly: `createRecordSyncService` takes a single installation-wide `provider` in its constructor options, because there is one DNS account. `container-hosts.ts` deliberately does the opposite — `reconcile()` takes the port as an **argument**, because "which provider" is a per-subject fact resolved from the stored link. Pangolin is the second case. The proxy reconciler resolves its port per subject from `hosting_targets.proxy_connection_id` / the proxy resource's own connection, and a reviewer should check for this specifically, because the wrong shape compiles fine and only fails when the second instance is added.

### Rate limits

**Not documented, and verified absent in source**: `server/integrationApiServer.ts` installs no rate-limit middleware. The dashboard API server does (`express-rate-limit`, defaults of 500 requests per minute), but that is a different port. Whether the hosted product adds edge limiting is unverified.

So the adapter's local token bucket is doing real work rather than mirroring a published ceiling — the same situation `@loxep/integration-purelymail` documented for a provider that publishes no limit, and it drew the right conclusion there: *the absence of a published limit is an argument for a smaller default, not a larger one.* Propose the Purelymail numbers (capacity 6, refill 1/s) and a registered `integration.pangolin.rate_budget` setting so the operator can raise them without a restart.

## The adapter surface

`packages/integrations/pangolin`, `@loxep/integration-pangolin`, built to the `add-integration-provider` skill and shaped like its two closest siblings. Provider shapes stop here (ADR-0009); no Pangolin response type is exported; the five-kind taxonomy and the rate budget are **duplicated, never shared**.

Because the API publishes a fetchable OpenAPI document, the adapter follows Purelymail's structure rather than Cloudflare's: **one generic call function plus a single exported operations map**, so a renamed route is a one-line change.

### Reads — the whole surface, and all of milestone 1

```text
listOrgs()                                    -> PangolinOrgFact[]
listSites(orgId)                              -> PangolinSiteFact[]
getSite(siteId | niceId)                      -> PangolinSiteFact | null
listResources(orgId)                          -> PangolinResourceFact[]
getResource(resourceId)                       -> PangolinResourceFact | null
listTargets(resourceId)                       -> PangolinTargetFact[]
listRules(resourceId)                         -> PangolinRuleFact[]
listDomains(orgId)                            -> PangolinDomainFact[]
findDomainByBaseName(orgId, baseDomain)       -> PangolinDomainFact | null
listDomainDnsRecords(orgId, domainId)         -> PangolinDomainDnsRecordFact[]
capabilities()                                -> PangolinCapabilities
stats()                                       -> PangolinAdapterStats
```

`capabilities()` reports what this *instance* can do, which is not a constant here: resource policies and their bulk rule endpoint are licence-gated, root keys exist only on self-hosted, and domain creation differs per build. Phase 7's reason for adding `capabilities()` to the port triple applies precisely — *"it lets the UI degrade honestly rather than offering a control that silently does nothing."*

```text
interface PangolinCapabilities {
  provider: 'pangolin';
  bulkRuleSet: boolean;        // resource policies present (Cloud/EE) — false self-hosted
  ruleAliases: false;          // constant; no provider alias primitive exists
  ruleDisable: boolean;        // the `enabled` flag on rule update
  domainCreate: boolean;       // undocumented + build-dependent; default false
  siteCreate: boolean;         // reported, but Loxep does not use it (ADR-0022)
  ruleMatches: readonly string[];
  ruleActions: readonly string[];
}
```

### Writes — the minimal set, each with its risk note

Nothing here ships before [milestone 3](#milestones-sequenced-by-write-risk) has built the gate.

```text
createResource(orgId, payload)          TIER 1  additive
    Worst case: a resource exists that nobody uses. Recoverable in the
    dashboard. NON-IDEMPOTENT -> provider_operations, read-back via
    listResources matched on niceId.

updateResource(resourceId, patch)       TIER 2  access-affecting
    Carries `sso`, `blockAccess`, `emailWhitelistEnabled`, `applyRules`.
    Worst case: a resource that required auth stops requiring it, or a
    resource nobody can reach. Convergent, so no ledger row — but it is
    the operation the self-lockout preflight exists for.
    Loxep sets ONLY the fields its intent describes; every auth-related
    field is opt-in per resource and absent by default.

createTarget(resourceId, payload)       TIER 1  additive
    Worst case: traffic reaches a wrong origin. NON-IDEMPOTENT ->
    provider_operations, read-back via listTargets on (siteId, ip, port).

updateTarget(targetId, patch)           TIER 2  access-affecting
    Repointing a live resource at a different origin.

createRule(resourceId, payload)         TIER 1  additive, and the owner's
                                                headline use case
    Worst case: an extra ACCEPT rule grants access it should not, or an
    extra DROP rule blocks traffic. NON-IDEMPOTENT and there is NO upsert
    -> provider_operations, read-back via listRules matched on
    (action, match, value, priority).

updateRule(resourceId, ruleId, payload) TIER 2  access-affecting
    MUST carry `priority` — it is required, and omitting it silently
    reorders evaluation. Also the retirement verb: `enabled: false`.

resolveDomain(orgId, baseDomain)        READ    the template's domain step
```

**Deliberately absent, and the absence is the design:**

- **`deleteRule`, `deleteResource`, `deleteTarget`, `deleteSite`, `deleteOrg`.** The operation union has no delete member, following `ContainerHostOperation`'s closed `create | update` union so that widening it needs an owner ruling rather than a one-line edit. Disabling supersedes rule deletion entirely.
- **`createSite`.** ADR-0022 — a site create returns a newt secret exactly once, and a worker job has no reveal channel. See above.
- **Everything about users, roles, orgs, identity providers, access tokens, whitelists, passwords, and pincodes.** Cross-domain rule 10, and the contract's no-ACL-engine rule. Loxep reads the *shape* of a resource's auth configuration so an operator can see it; it does not manage who may pass it.
- **API-key management** (`PUT /org/{orgId}/api-key`, `POST .../actions`). Loxep does not mint its own credentials at a provider whose credentials it holds.
- **Blueprints.** See above.

### Redactors

An `Authorization: Bearer <apiKeyId>.<secret>` must never reach a `reconcile_run_steps` summary, and neither must a site-create response's `secret` — which is why `redactPangolinSiteCreate` ships in milestone 1 even though nothing calls `createSite`, following `redactCloudflareTokenCreate`'s precedent of shipping the rule before the code that could violate it.

## The proxy provider port

`packages/infrastructure/src/proxy-port.ts`, structurally re-declared and not imported, guarded by a compile-time assignability test in `@loxep/app`'s suite — the same three sentences `port.ts`, `mail-port.ts`, and `container-host-port.ts` each open with.

```text
ObservedProxyResource   { externalResourceId, niceId, name, fullDomain,
                          domainId, subdomain, mode, proxyPort, ssl, enabled,
                          ssoEnabled, blockAccess, applyRules,
                          emailWhitelistEnabled }
ObservedProxyTarget     { externalTargetId, siteId, ip, port, method, enabled,
                          path, pathMatchType, priority }
ObservedProxyRule       { externalRuleId, action, match, value, priority,
                          enabled }

ProxyResourcePayload    the create/update shape
ProxyRulePayload        { action, match, value, priority, enabled }

ProxyOperation =
  | { kind: 'create-resource'; resource: ProxyResourcePayload }
  | { kind: 'update-resource'; externalResourceId: string; resource: Partial<…> }
  | { kind: 'create-target';   externalResourceId: string; target: … }
  | { kind: 'update-target';   externalTargetId: string; target: Partial<…> }
  | { kind: 'create-rule';     externalResourceId: string; rule: ProxyRulePayload }
  | { kind: 'update-rule';     externalResourceId: string;
                               externalRuleId: string; rule: ProxyRulePayload }
                          // NO delete member, deliberately and permanently

ProxyProviderPort       read(subject) / apply(operation) / capabilities()
ProxyResourcePlan       { operations, unmatchedObserved }
planProxyResourceOperations({ desired, observed })   PURE
```

Three properties the port encodes structurally rather than by convention:

- **No secret material crosses this boundary in either direction.** A resource's password and pincode are settable at Pangolin and are not part of any Loxep intent; the observed types carry `ssoEnabled` and `emailWhitelistEnabled` as *presence*, never the whitelist's contents — the same presence-bit asymmetry `ObservedContainerHost` uses for TLS material, for the same reason: a port that accepted the value would put it into every diff and every run-step summary.
- **`unmatchedObserved` is never turned into deletes.** At Cloudflare an unexpected record is unusual; here it is the normal case, because the owner manages resources in the dashboard and always will. The plan surfaces them so the UI can say "Pangolin knows about six resources Loxep does not", which is information rather than drift.
- **The planner always emits the full comparable rule payload on an update**, because `priority` is required and a partial update reorders evaluation. Pure, no I/O, exhaustively unit-testable — the same reason `diffDnsRecords` is pure.

## The write-risk model

**OWNER-REVIEW-CRITICAL.** This section is the one the owner must rule on before any milestone that writes.

### Why this provider is different from every other one Loxep writes to

Loxep already writes to Cloudflare (`apply`), Purelymail (`addDomain`, `createUser`, routing rules), and Dockhand (host registration). Each of those has a bad day: a wrong DNS record breaks a name, a wrong mailbox costs money, a wrong Dockhand row makes a host unreadable. **None of them removes the operator's ability to fix the mistake.**

Pangolin does. It is the identity proxy in front of the estate, and this installation's own evidence says so: `loxep-v29` measured that `dockhand.example.com` and `termix.example.com` return `302 → pangolin.example.com`, and that **repeating the probe from inside the running `loxep` container on `tunnel_net` returned the identical redirect** — "Pangolin applies its auth per resource regardless of where the client sits". The corollary is the risk: a Pangolin write that removes access removes it for Loxep too, and Loxep's own UI is one of the resources behind it.

So the design's first rule is not about rules at all:

> **Loxep must never be the only path to fix what Loxep broke.**

Three consequences, all binding:

- **Loxep never manages the Pangolin dashboard's own resource.** The resource whose full domain matches the connection's base-URL host is refused by the planner, in every mode, the way `assertNoUnexpectedDeletions` refuses a class of operation rather than trusting a caller not to build one.
- **Loxep never manages the resource that fronts Loxep itself.** Same guard, keyed on the deployment's configured base URL (`apps/web/src/config/site.ts` / the installation's own `LOXEP_*` base URL). An operator who genuinely wants Loxep's own resource under management does it in the Pangolin dashboard, deliberately, out of band.
- **The owner keeps a route to Pangolin that does not traverse Loxep.** Stated in the operator guide, not enforced in code, because Loxep cannot enforce it — but a design that writes to an access proxy without saying this out loud is incomplete.

### The four tiers

```text
tier 0  READ                      list orgs/sites/resources/targets/rules
        always permitted          no gate, no confirmation, no policy flag

tier 1  ADDITIVE, REVERSIBLE      create a resource, add a target,
        write policy + apply      ADD a rule
                                  worst case: something new does not work

tier 2  MUTATING, ACCESS-AFFECTING  update a rule's value, change a target,
        write policy + explicit     toggle a resource's auth settings
        apply from a shown plan      worst case: something that worked stops

tier 3  LOCKOUT-CLASS             DISABLE the last rule granting the operator
        write policy + typed      access, turn off SSO on a resource that
        confirmation + preflight  needs it, repoint the resource that fronts
                                  Loxep itself
                                  worst case: the operator cannot get back in
```

**There is no delete tier, because there are no delete verbs.** Pangolin's rule update carries an `enabled` boolean, so retirement is `enabled: false` — reversible, recoverable, and visible in the observed set afterwards. That discovery ([verdict 3](#the-three-verdicts-that-shape-the-design)) removes the entire class of unrecoverable operation this design was originally built around, and the operation union simply never gains a `delete` member.

### Six binding rules

1. **Write authorization is a stored, per-connection policy that defaults to off.** A new registered setting, `infrastructure.provider_write_policy`, keyed by connection id, with values `read_only` (default) and `allow`. Flipping it is an admin-only server function that writes an `audit_events` row in the same transaction. Nothing about this is Pangolin-specific: it also gives Cloudflare and Purelymail an honest answer for the owner's current credentials (a full-account read-only Cloudflare token, and a Purelymail admin token the owner has ruled is to be treated as read-only), and it turns "the call will fail with `auth` after we have already decided to make it" into "we refuse before the call and say why".
2. **`add-then-retire`, never `replace`.** Any rule change that alters an address is applied as *add the new rule first*, verify, and retire the old one — by disabling it — as a **separate, later, tier-3 operation**. An in-place update whose new value is wrong removes the working access in the same call that installs the broken one. This is the same shape ADR-0024 used to make provisioning policy lockout-proof: *the policy never affects a user who already exists.* Pangolin's lack of any concurrency control (no ETag, no `If-Match`, no version field — last write wins) makes the in-place path worse still: a rule Loxep updates was not necessarily the rule Loxep read.
3. **No sweep, poll, or scheduled run may perform a tier ≥ 2 write.** The proxy reconciler forces `mode = 'check'` for `trigger ∈ {sweep, poll}`; only `manual` and `intent_change` may apply. Structural, in the service, with a test — not a convention.
4. **An `unexpected` Pangolin object is never touched, in any mode, ever** — not deleted, not disabled, not reordered. Phase 7's open question 3 carries over with the stakes raised: at Cloudflare, an unexpected record is unusual; at Pangolin, **unexpected is the normal case**, because the owner manages resources in the dashboard and always will. `unmatchedObserved` on the plan (the `ContainerHostPlan` precedent) is how they surface, and adopting one into intent is the escape hatch, exactly as `adopt` is for DNS drift.
5. **The operation union ships without `delete`, permanently.** Following `ContainerHostOperation`'s closed `create | update` union — *"so that adding a delete requires an owner ruling rather than a one-line union member"* — and made easy by Pangolin's `enabled` flag, which gives retirement a reversible form. Loxep therefore never issues `DELETE` to Pangolin at all. If a future need appears, it arrives as an owner ruling and a union member, not as an implementation detail.
6. **A tier-3 apply requires a typed confirmation naming the object.** Loxep has no such control today; the strongest existing pattern is the destructive `AlertDialog` on token roll (`hosting-target-tokens-panel.tsx`). **This design rules that pattern insufficient here** and specifies one new shared component — a confirmation whose primary action stays disabled until the operator types the resource's full domain — because a roll costs a redeployment while a wrongly retired access rule costs the way back in. One component, in `src/components/ui/`, so the next lockout-class action inherits it rather than reinventing it.

### The self-lockout preflight

Before any tier ≥ 2 apply, the planner runs a pure predicate over the *resulting* rule set, not the operation:

```text
wouldLockOut(resource, resultingRules, operatorContext) -> reason | null

  the resource is Loxep's own, or the Pangolin dashboard's       -> refuse
  the resulting set has no rule granting the operator's current
    address AND no auth method the operator holds                -> refuse
  the operation retires the only rule referencing a live alias   -> refuse
```

It is pure and unit-testable for the same reason `diffDnsRecords` is: this is where the subtle bug lives, and a predicate with no I/O can be exhaustively tested. It refuses rather than warns — a warning on the one action that removes your way back in is a warning nobody reads twice.

## Dynamic IP: named aliases, fan-out, and never a silent apply

The owner's second named need: *"updating rules when dynamic IPs change"*. A home connection's address changes, and every bypass rule that referenced it is now wrong — some of them silently, because a rule that grants access to an address nobody holds simply stops working.

### Where the address is referenced

Whatever the upstream answer to [the alias question](#the-api-verdict), Loxep must model the alias itself, because the alias is what makes the operator's job one edit instead of N. A rule's stored value is a **reference**, not a literal:

```text
proxy_resource_rules.value    '203.0.113.7'        a literal, never resolved
                              'alias:home'          resolved at materialization
```

Materialization resolves `alias:home` to today's address exactly as `materializeDesiredRecords` resolves an apex target to a fronting node's address — pure, no I/O, and an unresolvable alias is an **error, not a fallback**. That is the same rule that stops a broken fronting chain from publishing an origin address, applied to the case where publishing the wrong thing removes access instead of adding it.

### Where the address comes from

One registered setting, `infrastructure.ip_aliases`, holding a small list:

```text
{ name: 'home',
  address: '203.0.113.7',
  source: 'manual' | 'dns' | 'pangolin_site',
  hostname: 'home.example.dyndns.net',   // source = 'dns'
  siteId: '…',                           // source = 'pangolin_site'
  previousAddress: '203.0.113.4',
  observedAt: '…', confirmedAt: '…' }
```

Three sources, ranked by how much Loxep has to trust:

- **`manual`** — the operator types it. Always available, always correct, and the fallback when the other two are unavailable. Ships first.
- **`dns`** — Loxep resolves a hostname the operator already maintains (a dynamic-DNS name, which is what a dynamic address usually already has). One DNS lookup, no new outbound dependency, no third party learning the installation's addresses.
- **`pangolin_site`** — read the address Pangolin *itself* observes for the newt site. This is the best source when it exists, because it is already-observed truth on a connection Loxep already holds, and because it is the same address Pangolin will match rules against. Whether the API exposes it is [an open question](#open-questions), and the design does not depend on it.

**Explicitly rejected: an external "what is my IP" HTTP service.** It adds an outbound dependency and a trust boundary to a value that becomes a firewall rule, for a convenience the two options above already provide.

### The update flow, and why it is never silent

```text
detector observes a new address for alias 'home'
   -> the alias is updated, previousAddress retained
   -> materialization now yields a DIFFERENT desired rule set for every
      resource whose rules reference alias:home
   -> a CHECK run records the difference and emits ONE notification
      (eventClass 'infrastructure', subject 'hosting_target' or the
       resource's managed_domain — both already in the closed subject set)
   -> the operator sees "7 rules across 4 resources reference an address
      that changed" and applies with one click
```

The apply obeys rule 2 — **add the new rule, keep the old one** — so the worst case of a wrong detection is a superfluous rule granting access to an address the operator no longer holds, not a lost route in. Retiring the previous address is a separate tier-3 action (`enabled: false`, never a delete) that the operator takes once they have confirmed the new one works, and the design deliberately makes that the *slow* half.

Two details the research pins down. The rule Loxep adds is `{action: 'ACCEPT', match: 'CIDR', value: '<address>/32', priority: …, enabled: true}`, and **`priority` must be carried on every update** because the API requires it and omitting it silently reorders evaluation — for an access rule, a behavior change disguised as a no-op. And because a rule create is non-idempotent with no upsert, each fan-out create goes through `provider_operations` with a natural key of `(resourceId, action, match, value)`; a stuck `pending` resolves by reading the resource's rules back and matching, never by retrying.

**Auto-apply is an open question, not a default.** The temptation is obvious: a dynamic address changes at 4am and one-click is not click-less. The recommendation is a per-alias `autoApply` flag defaulting to **off**, permitted only for `add` operations (never retirement), only when the alias's source is `dns` or `pangolin_site` (a `manual` alias has no detector to trust), and never for a rule on a resource the [preflight](#the-self-lockout-preflight) refuses. Even then the notification still fires — an automatic change to an access rule that nobody is told about is the failure mode this whole section exists to avoid.

## The template engine

The centerpiece, and the part most likely to be over-built. So the first two sentences of its design are constraints:

> **A template is a strictly ordered list of idempotent steps, each of which writes intent into a table that already exists and enqueues a task that already exists.**
>
> **The engine compiles and drives. It does not execute provider calls itself.**

Everything else follows from those.

### What a template is

The precedent is `mailbox_templates` / `mailbox_template_entries`, and Phase 7 says exactly why it is a table rather than a constant: *"This is what makes 'provision the standard addresses' a setting rather than a deploy. Edit the template once and every future domain picks it up; the alternative is a hardcoded list inside the materializer that nobody can change without shipping code."* The same sentence is true of "provision a standard domain", so the same shape applies.

```text
provisioning_templates
  id, name, description
  version           integer, bumped on every edit
  is_default        unique(is_default) where is_default    -- the singleton idiom
  created_by_user_id, created_at, updated_at

provisioning_template_steps
  template_id, sequence
  step_kind         CLOSED, CHECKed — see the vocabulary below
  provider          'cloudflare' | 'purelymail' | 'pangolin' | null (Loxep-only step)
  params            jsonb — Loxep-owned, validated by a zod schema per step_kind
  optional          boolean — a blocked or failed optional step does not stop the run
  unique(template_id, sequence)
```

`params` is jsonb and that is deliberate: the parameters of "create a resource named `$name` with rule set `$rules`" are genuinely heterogeneous across step kinds, and columns for the union of them would be the "shared table containing unrelated optional columns" cross-domain rule 5 forbids. It is safe because `step_kind` is **closed and `CHECK`ed**, so every jsonb shape has exactly one zod schema that parses it, and an unknown kind fails at the constraint rather than at a switch statement.

The `step_kind` vocabulary, closed on purpose, is small because each member must map to an existing service:

```text
domain.declare              managedDomains.create + updateIntent      (intent only)
dns.point-at-target         set apex_target_id / proxied flags; the
                            materializer does the rest                (intent only)
dns.manual-record           addManualRecord                           (intent only)
proxy.ensure-resource       proxy_resources intent + sync-proxy-resource
proxy.ensure-rules          proxy_resource_rules intent + sync-proxy-resource
mail.enable                 enableMail + ensure-mail-domain
mail.ensure-mailbox         mailbox intent + sync-mailboxes
```

Seven kinds. A template that wants an eighth thing is a template that wants a new service, and the closed set forces that conversation instead of letting `params` grow a scripting language.

### What a template RUN is

Two tables, and the split between them is the resumability story:

```text
template_runs
  id, template_id, template_version
  inputs            jsonb — the operator's answers ({domain: 'example.com', …})
  compiled_plan     jsonb — the FROZEN step list, resolved against the template
                    at start. A template edited mid-run does not change a run.
  status            'running' | 'succeeded' | 'partial' | 'failed'
  started_at, finished_at, actor_user_id

template_run_steps
  run_id, sequence, step_kind, provider
  status            'pending' | 'running' | 'succeeded' | 'blocked' | 'failed' | 'skipped'
  blocked_reason    'credential_scope' | 'awaiting_delegation' | 'write_policy' | …
  reconcile_run_id  -> reconcile_runs.id, the EVIDENCE this step produced
  provider_operation_key -> provider_operations.idempotency_key, when the step
                    made a non-idempotent create
  error_code, error_detail, occurred_at
  unique(run_id, sequence)
```

`compiled_plan` is the single most important column. Freezing the plan at start is what makes a run reproducible after a template edit, what makes "resume" mean the same thing three days later, and what lets the UI show the whole ladder — including steps not yet reached — instead of only what has happened.

`reconcile_run_id` is the second. **A template step does not invent its own evidence.** A `dns.point-at-target` step's evidence is an ordinary `reconcile_runs` row of kind `sync-records`, identical to one an operator's manual re-sync would produce, with the same redacted `reconcile_run_steps` beneath it. The template run is a *spine*; the vertebrae are the runs the existing reconciler already writes. That is what keeps this from being a second execution engine.

`reconcile_runs.subject_type` is a closed `CHECK`ed set (`domain`, `hosting_target`, `token`) and gains two members: `proxy_resource` and `template_run`. Widening a `CHECK` is a one-word migration edit; discovering the overload later is a migration plus a data repair — the same reasoning that gave `dns_records.owner` its `caa` value.

### The driver

**One Graphile Worker task**, `infrastructure.run-provisioning-template`, payload `{ runId }` and nothing else (rule 1 of `tasks.ts`: no credential ever enters a payload), job key `template_run:{id}`, `job_key_mode: 'preserve_run_at'` because a template run legitimately waits days for delegation and re-enqueueing must not reset its backoff.

Its body is `mail-sync.ts`'s shape, generalized:

```text
load the run and its frozen plan
for each step in sequence:
    already succeeded?          continue
    blocked, still blocked?     stop, run stays 'partial'
    prerequisites not met?      mark 'blocked' with the reason, stop
    otherwise:                  run the step, record its status
mark the run succeeded / partial / failed and return
```

**Advance as far as you currently can, record exactly where you stopped, return.** Run it again in an hour, a day, or a week and it picks up from wherever reality now is. Every run is safe, every run is idempotent, and no run is "the one that has to work". A step that has already succeeded is skipped by its own `template_run_steps` row; a step that made a non-idempotent provider create is protected a second time by `provider_operations`, which short-circuits a `succeeded` key and refuses to blindly retry a `pending` one.

The delegation gate is not special-cased. `mail.enable`'s step *is* `runMailDomainSync`, which already contains the gate, already classifies "correctly waited" as success, and already knows not to burn the provider's patience. The template engine learns nothing about DNS delegation; it asks a service that already knows.

### Partial failure, from the operator's side

Step 3 of 6 failed. What the operator sees, and what they can do:

```text
✓ 1  domain.declare          example.com declared             run #4812
✓ 2  dns.point-at-target     A/AAAA @ and * -> pangolin-node  run #4813, 4 applied
✗ 3  proxy.ensure-resource   FAILED  provider_unavailable     run #4814
                             "Pangolin did not respond"       [ Retry step ]
· 4  proxy.ensure-rules      pending
⊘ 5  mail.enable             BLOCKED  credential_scope
                             "The Purelymail connection's write policy is
                              read_only. Allow writes for this connection to
                              continue."                       [ Review policy ]
· 6  mail.ensure-mailbox     pending

Run status: partial          [ Resume run ]   [ Abandon run ]
```

Three properties of that screen are design constraints, not presentation choices:

- **Resume is the primary action and it is safe.** It re-enqueues the same task with the same `runId`; succeeded steps short-circuit, the failed step retries, the blocked step re-evaluates its reason.
- **Abandon does not undo anything.** It marks the run `failed` and stops the driver. Everything created stays. There is no rollback, [by rule](#not-worth-building), and the button copy says so.
- **A blocked step names the exact remedy.** "`credential_scope`" alone is useless; "the Purelymail connection's write policy is `read_only`" plus a link to the surface that changes it is the difference between a state and a dead end.

### Where it lives in `/infrastructure`

```text
/infrastructure/templates            list; the default badge; run counts
/infrastructure/templates/$id        the step ladder, editable; version history
/infrastructure/templates/$id/run    the wizard: pick a template, answer its
                                     inputs, PREVIEW the compiled plan,
                                     then start — the preview is where an
                                     operator sees "this will create 4 Pangolin
                                     resources" before it does
/infrastructure/runs                 template runs join reconcile runs here,
                                     distinguished by kind
/infrastructure/runs/$id             for a template run: the step ladder above,
                                     each step linking to the reconcile run it
                                     produced
```

The wizard writes intent and enqueues, then redirects — Phase 7's own rule, restated because the temptation to await the first provider call is strongest on exactly this screen. And the **plan preview is mandatory**: a template that creates resources at an access proxy must show what it will create before the operator commits, which is the tier-2 "explicit apply from a shown plan" rule arriving one level up.

## Purelymail's write leg, and what "blocked" means

The adapter is **already complete** for what the template needs. `@loxep/integration-purelymail` ships `addDomain(domainName)` and `createUser({userName, domainName, password, …})` today, and `mail-sync.ts` already drives both through `provider_operations` with read-back resolution (`findDomainByName`, `listUsers`). A mailbox create is billable, which is the case the ledger was written for.

So the constraint is **not** an adapter gap. It is the owner's credential policy: the Purelymail token is a fully-scoped account admin token, ruled *treated as read-only* until the owner says otherwise, with any real interaction limited to `loxep.com` and non-destructive. Purelymail has **no token scoping at all** — one token carries every operation including `deleteDomain` and `deleteUser` — so there is no safe-by-construction credential to ask for. Safety has to come from Loxep.

That is exactly what rule 1's write policy provides, and it is why the flag is per *connection* rather than per provider:

```text
step                              policy      outcome
purelymail.add-domain             read_only   BLOCKED, reason 'credential_scope',
                                              with the exact policy flip that unblocks it
purelymail.create-user            read_only   BLOCKED, same
purelymail.add-domain             allow       runs, ledgered, gated on delegation
```

**A blocked step is a first-class state, never a silent skip and never a failure.** It has its own status value alongside `pending`/`running`/`succeeded`/`failed`/`skipped`, it renders distinctly, it names the credential scope or policy that would unblock it, and the run's overall status becomes `partial` rather than `succeeded` — the same honest classification `mail-sync.ts` already applies to a domain waiting on delegation. Recording it as a failure would light up every health indicator for a condition that is entirely intentional; recording it as a skip would let a template silently produce half an estate.

The same mechanism covers Cloudflare: the owner's token is full-account **read-only** today (rescopable on request). Under `read_only`, a template's record-publishing step blocks with the scope it needs — `Zone:Read` + `DNS:Edit` for the named zones — instead of failing with an `auth` taxonomy error after the decision to write has already been made.

One real gap, recorded rather than discovered later: **`@loxep/integration-cloudflare` has no zone-create verb** (`listZones`/`findZoneByName`/`getZone`/`read`/`apply` and nothing else). A template step that needs a zone therefore *resolves* one and blocks if it is absent; creating a Cloudflare zone stays a deliberate act in Cloudflare's own dashboard until somebody designs the zone-create ledger path Phase 7 also deferred.

## Not worth building

Each of these is a thing a reasonable reader would expect this design to include. Each is deliberately absent, with the reason.

- **A workflow/DAG engine.** No branches, no conditions, no parallelism, no compensating transactions, no per-step retry semantics of its own. A template is a strictly ordered list of idempotent steps; "resume" is "run it again". The moment a template needs a conditional, the answer is a second template, not an expression language. Loxep already has one job system (ADR-0003/ADR-0013) and this must not become a second one.
- **Rollback.** A partially applied template is **never** unwound. Every step this design permits is either additive or convergent, and the delete verbs that a rollback would need are precisely the ones rules 4 and 5 refuse to ship. "Step 3 of 6 failed" resolves forward — fix and resume — or is abandoned in place with everything it created still there.
- **A Pangolin rule expression language, or a generic ACL engine.** The implementation contract forbids a generic ACL engine in this phase, and ADR-0017 forbids per-resource permission containers. Loxep stores rule *rows* it can diff; it does not gain a grammar.
- **Mirroring Pangolin's users, roles, orgs, or identity providers into Loxep.** Cross-domain rule 10: an application user, a provider account, a provider connection, a workspace, and an economic entity are distinct concepts, and a Pangolin org member is none of them. Loxep reads org and site names to address resources and stores nothing about who may use them.
- **Storing Pangolin traffic, bandwidth, or session metrics.** Rule 13: latest observed status may be stored; metric history may not.
- **Teardown ("delete everything this template made").** It is the delete class again, wearing a helpful hat.
- **Certificate management.** Pangolin/Traefik owns issuance for its own resources. Loxep's only certificate opinion is the CAA policy it already has, and that one is still unreviewed (Phase 7 open question 2).
- **Cross-instance synchronization.** Two Pangolin instances are two `connections` rows. Loxep never copies a resource from one to the other, never diffs them against each other, and has no notion of a "primary" instance.
- **A second scheduler for anything here.** The IP detector and the proxy drift cadence ride the existing shared scheduling foundation and the existing `health.sweep`-style single recurring job. No cron per resource, no cron per rule.
- **A "test this rule" simulator.** Predicting whether a rule set grants access requires reimplementing Pangolin's matcher, which is rule 13's reimplementation trap with a security blast radius. The [preflight](#the-self-lockout-preflight) answers the one narrow question Loxep can answer honestly — "does the resulting set still contain a rule that grants *this* operator" — and refuses to answer the general one.

## Milestones, sequenced by write risk

The ordering rule is explicit: **every milestone that writes is gated on the milestone that made writing safe, and the two gates that need an owner ruling are named as gates, not as risks.**

```text
M1  READ ONLY                              SHIPPED 2026-08-15, loxep-acj.1
    @loxep/integration-pangolin: the read surface, the five-kind taxonomy,
    the rate budget, the credential bundle (pangolin_credentials), the
    redactors. Catalog entry, guided form, connecting-pangolin guide. A
    live reconnaissance run against the owner's instance VERIFIED the
    envelope shape live (via the dashboard's own sibling /api/v1 route)
    but found the standalone Integration API server itself UNREACHABLE
    from the build network on every path tried — see the M1 closeout
    note near the top of this document. Two source-verified corrections
    landed: /resource is canonical (/public-resource is the alias, not
    the reverse), and list responses nest under a named key + pagination.
    Nothing writes. Nothing can.

M2  INTENT + CHECK-MODE RECONCILER      SHIPPED 2026-08-15, loxep-acj.2
    proxy-port.ts (structural re-declaration + pure planner), the
    proxy_resources / proxy_resource_rules intent tables (migration 0027),
    the sync-proxy-resource SERVICE, and registry.ts finally registering
    the reserved task — in CHECK MODE ONLY, enforced in the service
    (assertCheckModeOnly throws ProxyWritePolicyError before any provider
    call). hosting_targets.proxy_connection_id comes alive: proxy.ts
    resolves the provider PER RESOURCE from it (never an installation-wide
    constructor option, per container-hosts.ts's own precedent). Fleet
    detail and domain detail render the chain: domain -> Cloudflare
    record -> Pangolin resource -> hosting target, plus unmatchedObserved
    ("Pangolin knows about N resources Loxep does not") and a rules list
    with a hide-disabled-by-default / only-disabled filter.
    Still nothing writes — the M1 adapter has no write verb to call, and
    the service refuses mode:'apply' unconditionally regardless. No
    monitor_targets registration or poll-executor route yet (mirrors
    RECONCILE_CONTAINER_HOST_TASK's own base-milestone shape — a periodic
    cadence is a later milestone's addition, once intent-authoring exists).
    No live leg: the Integration API remains unreachable from this build
    network (M1's finding, unchanged), so every M2 test drives a fake
    ProxyProviderPort — noted honestly rather than silently.

M3  THE WRITE-AUTHORIZATION MODEL      *** OWNER RULING REQUIRED ***
    infrastructure.provider_write_policy (per connection, default
    read_only), the admin flip with its audit event, the four tiers, the
    self-lockout preflight, the typed-confirmation primitive, and the
    'blocked' step state. Applied to Cloudflare and Purelymail too, since
    both of the owner's current credentials are read-only by policy.
    Ships with no Pangolin write verb — this milestone builds the gate,
    not the thing behind it.

M4  TIER-1 PANGOLIN WRITES             gate: M3 shipped + owner flips the
                                             connection to 'allow'
    create resource, add target, ADD rule. The first real payoff is
    loxep-v29: bypass rules scoped to the API path prefixes Loxep's
    Dockhand and Termix adapters use, applied across resources in one
    action instead of one dashboard visit each.
    First write targets a throwaway resource, with the owner watching.

M5  DYNAMIC-IP ALIASES                 gate: M4 + owner ruling on auto-apply
    infrastructure.ip_aliases, the manual and DNS detectors, alias
    resolution at materialization, fan-out across every referencing rule,
    the add-then-retire apply, and the notification. autoApply ships
    OFF and stays off unless the owner rules otherwise.

M6  THE TEMPLATE ENGINE                gate: M4 (the Pangolin write leg)
                                             + Purelymail write policy for
                                               the mail steps
    provisioning_templates / _steps / template_runs / template_run_steps,
    the compiler, the one driver task, the blocked state, the
    /infrastructure/templates surfaces, the mandatory plan preview, and
    resume. Ships with ONE seeded template — 'new domain' — matching the
    owner's named workflow.

M7  RETIREMENT BY DISABLE              *** OWNER RULING REQUIRED ***
    Retire a superseded rule with `enabled: false` — the reversible form,
    behind the typed confirmation and the preflight. Last on purpose,
    because it is the only operation whose worst case is "the operator
    cannot get back in", even in its reversible form. NO DELETE VERB
    ships in this milestone or any other.
```

M1 and M2 can ship against the owner's live instance today with no ruling and no credential change, and they deliver the visibility half of the owner's vision on their own. That is the argument for this ordering: **the read half is useful before the write half is safe.**

## Where this sits in existing documents

- **[Domain Boundaries](../domain-boundaries/)** — Infrastructure already owns "hosting targets (nodes, tunnels, and the relationship between a tunnel-connected host and the node that fronts it)". This design adds *proxy resource desired state and its rule intent* to that list, and adds the write-policy setting to the "does not own credential material, only the reference and the scope intent" clause. **Cross-domain rule 13 is not amended.** Rule 13 governs *companion tooling Loxep links and observes* — Beszel, Gatus, Dockhand, Termix, Netdata. Pangolin is not in that class: Phase 7 named it a **control-plane provider** alongside Cloudflare and Purelymail (`proxy_admin_credentials`, `packages/integrations/pangolin`, "sites and hostname resources") from the first draft, and a control-plane provider is one Loxep writes to by definition. Saying so explicitly matters, because the surface reading — "Pangolin is another tool on the fleet page, so rule 13 forbids writing to it" — is wrong for the right-sounding reason. What *does* carry over is the spirit: Loxep drives desired state and never reimplements the proxy.
- **[Infrastructure Control Plane Design (Phase 7)](../infrastructure-control-design/)** — gains an implementation-status note pointing here, and its "what did NOT ship" paragraph stops being open-ended.
- **[Configuration & Secrets](../configuration-and-secrets/)** — the write policy is a *setting*, not a secret, and lives in PostgreSQL like every other setting. No new bootstrap env var.
- **[Frontend Standards](../../development/frontend-standards/)** — every surface here is the donor `DataTable` stack, `useAppForm`, and semantic tokens. The typed-confirmation dialog is a new shared primitive under `src/components/ui/`, not a feature-local one.
- **The [integrations catalog](../../guides/)** — Pangolin becomes a fourteenth-plus entry in the `Infrastructure` category with a guided form and a `connecting-pangolin` guide, per the `add-integration-provider` skill.

## Open questions

Each item is a genuinely unresolved decision with a recommendation, not a placeholder. **A recommendation is not an answer.** Items marked **OWNER-REVIEW-CRITICAL** are unrecoverable once real provider state exists, or can remove the owner's own access, and must be answered before the milestone that depends on them starts.

1. **OWNER-REVIEW-CRITICAL — Is the four-tier write-authorization model the right shape, and is a per-connection stored write policy defaulting to `read_only` acceptable?**

   *Recommendation:* yes, and adopt it for Cloudflare and Purelymail at the same time rather than only for Pangolin. Both of the owner's current credentials are broad and ruled read-only by policy rather than by scope; a stored flag is the only place that policy can actually live, and it converts "the write will fail with `auth` after we decided to make it" into "we refused before the call and told you which flip unblocks it".

   *The owner must confirm:* whether a stored flag is enough, or whether write authorization should additionally require something out-of-band (a bootstrap env var, a CLI action) so that a compromised admin session cannot enable writes to the access proxy. The design's own view is that an env var here would violate the configuration rule that only bootstrap/pre-DB facts are env vars — but the blast radius is unusual enough to be worth asking.

2. **OWNER-REVIEW-CRITICAL — May Loxep retire a rule at all, given that retirement is now `enabled: false` rather than a delete?**

   The research narrowed this question considerably. Pangolin's rule update carries an `enabled` boolean, so there is no unrecoverable form of retirement to rule on — only a reversible one. **The design's answer is that Loxep never issues `DELETE` to Pangolin, ever**, and that stands whichever way this question goes.

   *Recommendation:* permit disable-retirement at M7, behind the typed confirmation and the preflight, never from a sweep. The alternative — Loxep only ever *adds* rules and the operator disables superseded ones in the dashboard — is genuinely viable, costs only that stale disabled-able rules accumulate, and is the safer default if the owner would rather Loxep's blast radius stayed strictly additive.

   *The owner must confirm:* which they want. Shipping a retirement verb "because add-then-retire is incomplete without one" is exactly the reasoning `ContainerHostOperation`'s closed union exists to prevent — and an accumulating pile of superfluous ACCEPT rules is itself a security smell, so neither answer is free.

3. **OWNER-REVIEW-CRITICAL — May a dynamic-IP alias change auto-apply?**

   *Recommendation:* ship `autoApply: false` and leave it off. Permit it, if at all, only for `add` operations, only for a detector-backed alias, and never for retirement — so the worst case of a bad detection is a superfluous rule rather than a lost route in. Notify either way.

   *The owner must confirm:* whether one-click at 4am is acceptable, or whether the convenience is worth the class of failure where Loxep silently rewrites an access rule from a value it inferred.

4. ~~**Does Pangolin have an alias primitive?**~~ **RESOLVED by research, 2026-08-15: no, and it is not coming.** The "Aliases" feature is a client-side DNS name for private-resource destinations and is not referenceable from a rule; the shared-IP-set pull request ([#1248](https://github.com/fosrl/pangolin/pull/1248)) was closed unmerged; the maintainer's answer to the rule-groups request was that resource policies cover it, and those are Cloud/Enterprise only. Loxep's own named alias is therefore the missing primitive, not a convenience, and the fan-out is Loxep's to own. Re-verify at M1 in case a release changes this.

5. **Does the API expose the newt site's observed public endpoint?** `GET /org/{orgId}/pick-site-defaults` returns an `endpoint` for *pre-generating* site defaults, which is not the same thing as the address Pangolin currently observes for an established site. If a site read exposes the live endpoint, `source: 'pangolin_site'` is the best alias detector available — already-observed truth, on a connection Loxep already holds, and the same address Pangolin matches rules against. **Answerable only against a running instance**, which is M1's job. If it is absent, `dns` and `manual` carry the feature and nothing else changes.

6. **Should Loxep ever use Blueprints for a genuinely transactional multi-rule apply?** The per-rule endpoints cannot be atomic across a set, and the one bulk endpoint that exists is Cloud/Enterprise-only. [Blueprints](https://docs.pangolin.net/manage/blueprints.md) can express resources and their rules and are applied inside a single transaction, on every edition.

   *Recommendation:* no, not as the primary path, for the reason given [above](#blueprints-pangolins-own-declarative-layer-and-why-loxep-does-not-compile-to-it) — a blueprint has no check mode, and the reconciler's trustworthiness rests on `apply` and `check` being one code path. Revisit only if a half-applied rule set turns out to be a real operational problem rather than a theoretical one; `add-then-retire` is specifically designed to make partial application survivable.

7. **Do proxy resources and their rules deserve their own intent tables, or should they ride `external_resources` / `resource_links` the way Dockhand host registration does?**

   *Recommendation:* their own tables. The Dockhand precedent works because a registered host is ~8 scalar fields in one jsonb blob; a **rule set is a multi-row set with per-row ownership**, which is precisely what `dns_records.owner` exists to express and what jsonb would turn into a code-only convention. The question is recorded because "no new tables" is a real virtue and the Dockhand path is a real precedent — but "which rules may the reconciler rewrite" must be a column, not a comment.

8. **Should proxy drift get findings rows, or ride the plan?**

   *Recommendation:* ride the plan, following `ContainerHostPlan.unmatchedObserved` — the newest precedent, and the one that ships no drift table. `dns_drift_findings` earned its table because an `unexpected` DNS record has no intent row to hang off *and* an hourly sweep needed an idempotent upsert probe. Proxy checks are not hourly, and the plan already carries `unmatchedObserved`. Revisit if the owner wants "how long has this rule been wrong" answered, which is the question only a findings table can answer.

9. **Retention for `template_runs` and their steps.** No automatic deletion in this design, matching Phase 7's stance on `reconcile_run_steps` and the observation hypertable. A template run is small and rare; the first installation to notice will be the first one that needs a policy.

10. **Does the `new domain` template ship as seeded data at all?** `mailbox_templates` ships **unseeded** — the installation starts with no template and the operator creates one, which is why `applyDefaultMailboxTemplate` can legitimately find nothing. *Recommendation:* follow that precedent exactly. Ship no rows, treat "no default template" as a legitimate state rather than an error, and put the `new domain` step list in the operator guide as something to create rather than in a migration as data. Seeding data in a schema migration is the shape this repo has avoided everywhere else.

## Before implementing any of this

1. **Re-verify every Pangolin API fact in this document against the running instance**, not against the documentation. Phase 7's own instruction applies with extra force here: *"treat every operation name and record set as unverified until checked against the running provider, and mark it as such in the module documentation."* The owner has a live Pangolin instance; a read-only reconnaissance run against it is milestone 1's whole point.
2. **Get the owner's ruling on the write-authorization model** before writing a line of write code. Milestones 1 and 2 need no ruling because they do not write.
3. **Confirm the self-lockout predicate against the owner's actual rule set** — including the `dev.loxep.com` resources with SSO plus bypass rules — before it gates anything, because a predicate that refuses a legitimate change is its own kind of outage.
4. **Never test a write against a resource the owner needs.** The first write must target a throwaway resource on a throwaway subdomain, created for the purpose, on the owner's instance, with the owner watching.
5. **Re-attach `tunnel_net` after any Compose recreation** (`docker network connect tunnel_net loxep`), or target the host address directly — the attachment is manual and drops on recreation. A live verification run that silently lost its network is a false negative that costs an afternoon.

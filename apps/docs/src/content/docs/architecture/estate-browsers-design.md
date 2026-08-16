---
title: Estate Browsers Design
---

This document designs the **estate browser** program (`loxep-47o`, owner ask 2026-08-16: *"the majority, if not all, of our integrations/connections should have this kind of estate browser… our app via the API links gives a wonderful place to easily tweak things, change settings, etc — no friction on our interface versus logging into tons of apps."*).

An **estate browser** is a per-connection page that renders a live read of everything one provider account actually contains, as that provider sees it, with the write affordances Loxep already owns mounted next to the rows they concern. The Pangolin estate browser (`loxep-pq2`) is the reference implementation the shell below was extracted from.

**Status: DESIGN, with Wave 0 and Wave 1a now SHIPPED on top of it.** [Section 9](#9-decomposition-into-child-beads) names the beads that ship it. Several affordances below are marked **OWNER-REVIEW-CRITICAL** — they require a credential-scope or write-policy grant the owner has not made; [section 8](#8-owner-review-critical) collects them in one place.

**Implementation status, updated 2026-08-16 (`loxep-47o.1`/`loxep-47o.2` shipped).** `loxep-47o.1` extracted the shell exactly as designed: the `/<workspace>/estate/$connectionId` route (Rule P1), a lightweight metadata registry (`apps/web/src/features/estate/provider-registry.ts`) plus a heavier per-workspace provider→`Sections`-component registry (`features/infrastructure/estate/section-registry.tsx`), the shared section primitives implementing Rules P3/P4/P13 (`features/estate/components/estate-section.tsx`, a generic `EstateSectionResult<T>` envelope so a classified provider-error kind survives the server-function boundary as data rather than a thrown error — `features/estate/error-taxonomy.ts`, mirroring the `ebay-oauth.ts` validation-result precedent), the `/infrastructure/estate` index (Rule N2), and the **Open estate** connections-row action (Rule N1, generalized from Pangolin-only). `loxep-pq2`'s route converged onto the convention with no server-function or component change — `PangolinEstateOverview`/`PangolinEstateResourceCard`/`AdoptPangolinResourceDialog` are byte-for-byte the shipped `loxep-pq2` components, now mounted through the registry instead of owning their own route file. `loxep-47o.2` is the shell's first consumer: Zones (`listZones`, one page per "Load more" click, cross-referenced against `managed_domains`) and a per-zone Records drill-in (`read()`, cross-referenced against `dns_records`/`dns_drift_findings`), both on the sanctioned `DataTable` path. Adopt-into-intent reuses `ManagedDomainsService.addManualRecord` — the EXACT write the shipped drift panel's own Adopt button already makes — through a new thin server function (`adoptCloudflareEstateRecord`) that adds no verb to `packages/infrastructure`; §3.1's own text anticipated needing one only if none already fit, and `addManualRecord` already did. One adapter-surface constraint worth recording: `@loxep/integration-cloudflare`'s `listZones`/`read` paginate internally from page 1 with no page-cursor parameter, only a cumulative `maxPages` ceiling, so "Load more" re-walks from page 1 rather than costing a guaranteed single call past the first page — acceptable given Cloudflare's own per-page ceiling (50 zones / 100 records) comfortably covers a single-account estate, and out of scope to change since `packages/integrations/cloudflare` sits outside this pair's edit fence. **Live verification (read-only, ONCE, 2026-08-16):** ran the exact adapter factory (`@loxep/app`'s `createCloudflareAdapterFactory`) against the real Cloudflare connection — 1 connection, 44 zones, a single `listZones` call (well under the 50/page ceiling, confirming the "exactly one call" claim above against real data). Drilled into one zone's records (the per-zone drill-in `read()` path) and found 9 records (2 A, 4 CNAME, 1 MX, 2 TXT; 2 proxied) — confirming the records section, the type/TTL/proxied mapping, and the proxied-count read all work end to end against a real account. No zone or record content was logged; only counts.

**`loxep-47o.4`/`loxep-47o.5` shipped, 2026-08-16.** `loxep-47o.4` (Dockhand, read-only per its own title): Environments — `listHosts()`, instance-wide, cross-referenced against `external_resources`/`resource_links` for a `'linked'` / `'unmatched'` / `'unknown'` verdict (`dockhandEnvironmentCrossReference`, unit-tested pure) — and the per-environment Containers+Stacks drill-in (`listContainers`+`listStacks`, two calls, keyed on `externalHostId` directly rather than through `fetchDockhandHostView`'s `hostingTargetId`, so it also works for an unmatched environment — see `dockhand-estate-functions.ts`'s own module doc for why this deliberately does not recruit the shipped per-host `DockhandContainersPanel`, Rule P16). The one write is **adopt-as-hosting-target**, mounting `adoptContainerHostAsHostingTarget` — the exact `/infrastructure/overview` `UnmatchedContainerHostsCard` server function, no new verb. `loxep-47o.5` (Gatus): Instance (`probeConfig()`+`health()`, both unauthenticated) recovers the three-way open/basic/oidc posture as a display-only inference (`inferGatusEstatePosture`, unit-tested pure) layered on the adapter's own binary `oidc` signal; Endpoints (`listEndpointStatuses()`, direct posture only) renders Rule P13's BLOCKED state — never an error — for the adapter's own structural OIDC refusal (`isGatusOidcDegradedRefusal`, unit-tested pure, keyed on the caught error's `detail.mode`), and excludes `gatusPushQuarantinedKeys()`'s keys in every posture with the excluded count rendered as a one-line explanation; the per-endpoint uptime drill-in (`endpointUptime(key, duration)`) works in every posture, unauthenticated by construction. Zero writes. **Live verification (read-only, ONCE, 2026-08-16):** Dockhand's `listHosts()` against the real connection returned 15 environments (via the package's own sanctioned `LOXEP_LIVE_TESTS=dockhand` live-test harness — the same read this bead's Environments section makes); a direct read-only count against the real database found 1 of the 15 already linked to a hosting target and 14 unmatched, confirming the cross-reference's three-way split renders real, non-trivial data rather than an all-linked or all-unmatched degenerate case. The same live harness's per-environment drill-in (`listContainers`/`listStacks`) returned 33 containers and 18 stacks for one environment, confirming the drill-in's field mapping end to end. Gatus's `probeConfig()` reported `mode: "direct"` (no stored Basic credential — the `'open'` posture leg) and `listEndpointStatuses()` returned 5 endpoints; the real installation's `infrastructure.gatus_push` setting has never been configured (no stored row), so `excludedHeartbeatCount` is honestly `0` today — the exclusion mechanism itself is proven by `gatus-estate-functions.test.ts`'s unit tests, not by this installation's current (empty) configuration. No hostname, environment name, endpoint key, or connection identity was logged or recorded; only counts.

**`loxep-47o.6`/`loxep-47o.7` shipped (2026-08-16).** `loxep-47o.6` ships the Tailscale estate exactly as designed: one section, one `listDevices()` call, cross-referenced against `external_resources`/`resource_links` keyed on the tailnet node id (never name/hostname) plus `tailscaleIgnoredDevicesSetting`, rendering the whole tailnet — linked, ignored, and plain candidates together, unlike the fleet-list candidates panel's unlinked-only remainder. Link/Declare/Ignore mount the EXACT existing candidates-panel server functions (`attachDiscoveredFleetResource`, `setTailscaleDeviceIgnored`) and the EXACT `LinkDeviceDialog`/`NewHostingTargetDialog` components, reshaped into that panel's own DTO shape rather than re-implemented (Rule P12); CGNAT addresses render as plain text with no copy affordance of any kind (the hard rule carried from `loxep-50t`). `loxep-47o.7` ships Beszel (Hub `health()` + Systems `listSystems()`, two calls, no drill-in ever) and Termix (Hosts `listHosts()`, instance-wide, read-only with no action of any kind — the design's "Writes: none, ever" covers Loxep-own writes too). Beszel's one verb is Attach, entered from the opposite direction `AttachDiscoveredResourceDialog` is (system-fixed vs. host-fixed) — a new thin picker component (`AttachBeszelSystemDialog`) wired to the SAME `attachDiscoveredFleetResource` write, mirroring the precedent `LinkDeviceDialog` already set for exactly this shape. **Termix Sessions ships instance-wide in this same change, per the owner's 5b ruling (2026-08-16) — see [§8.6](#86-instance-wide-termix-sessions-name-humans), which records the grant and supersedes this design's original "hosts only, sessions gated" acceptance criterion for `loxep-47o.7`.** The cross-reference-building logic all three server functions share (`external_resources` → `resource_links` → hosting target name) is extracted once into a tested pure helper (`features/estate/resource-cross-reference.ts`) rather than triplicated. Two new `@loxep/app` accessors (`getTailscaleAdapterForConnection`, `getBeszelAdapterForConnection` in `apps/web/src/server/admin.ts`, backed by newly re-exported `createTailscaleAdapterFactory`/`createBeszelAdapterFactory` from `packages/app/src/index.ts`) mirror the Cloudflare/Pangolin/Purelymail accessor pattern exactly — independently budgeted from the connection health probe's own reads, no package.json change. Zero migrations, zero new provider write of any kind. **Live verification (read-only, ONCE, 2026-08-16):** ran the exact adapter factories (`createTailscaleAdapterFactory`/`createBeszelAdapterFactory`/the pre-existing `createTermixAdapterFactory`) against the real connections — Tailscale: 1 connection, `listDevices()` returned 27 devices, 18 online, 0 with an unknown authorized state. Beszel: 1 connection, `health()` reported reachable (HTTP 200), `listSystems()` returned 1 system, up. Termix: 1 connection, `listHosts()` returned 1 host (0 reporting online — the design's own documented "`/status` is the weakest-provenance signal" caveat), `listSessions()` returned 0 active sessions. Confirms the estate wiring (factory → adapter call → DTO shape) works end to end against real accounts for all three providers, exactly as this same live device count independently corroborates `integrations-status.md`'s existing Tailscale connection-probe verification (27 devices, matching). No device name, hostname, system name, host name, or address was logged; only counts.

## 0. The one-paragraph shape

Every provider connection gets at most one page, addressed by connection id, never by provider name. The page makes a **fixed, small number of provider calls** — a constant independent of how large the estate is — and renders each response verbatim, each in its own section, each stamped with Loxep's own read clock. Nothing it reads is ever persisted: no table, no cache, no cadence, following the Dockhand containers panel precedent exactly. Row-level detail that would cost another call is fetched only when an operator expands that one row, and never when the overview already carries the answer. Every row that corresponds to a record Loxep owns says so and links to it — that cross-reference is what makes the page a pane of glass rather than a second copy of the provider's UI. Control appears **in context**: an action sits on the row it concerns, it is a write path that already exists and is already gated somewhere else, and no new provider-mutating path is ever born on an estate page.

## 1. Ground truth: the full adapter inventory

Read 2026-08-16 across all fourteen packages under `packages/integrations/`. "Read methods" counts exported adapter members that return provider facts, excluding `capabilities()`/`stats()` and pure helpers. "Write verbs" counts exported members that mutate provider state.

| Provider | Package | Read methods | Write verbs | Rate budget (capacity @ refill/s) | Write-policy status | Estate sections the reads support |
| --- | --- | --- | --- | --- | --- | --- |
| **Cloudflare** | `integration-cloudflare` | 4 — `listZones`, `findZoneByName`, `getZone`, `read` | 1 — `apply` (create/update/delete a record) | 8 @ 1 (docs ceiling 4/s, shared with the operator's own dashboard) | **GATED** — `assertWritePolicy` in `infrastructure/src/sync.ts:442`, tier 1, reason `write_policy`; UI-enforced | Zones (incl. zones with no `managed_domains` row); records per zone |
| **Purelymail** | `integration-purelymail` | 6 — `getOwnershipCode`, `listDomains`, `findDomainByName`, `listUsers`, `listRoutingRules`, `checkAccountCredit` | 6 — `addDomain`, `recheckDomainDns`, `createUser`, `deleteUser`, `createRoutingRule`, `deleteRoutingRule` | 6 @ 1 (provider publishes no limit; absence argued *down*) | **GATED** — `mail-sync.ts:384`, tier 1, reason `credential_scope`; UI-enforced | Account (credit, ownership code); domains; mailboxes (account-wide); routing rules |
| **Pangolin** | `integration-pangolin` | 11 — orgs, sites (+detail), resources (+detail), targets, rules, domains, domain DNS records, `probe` | 4 — `createResource`, `addTarget`, `createRule`, `updateRuleEnabled` (no DELETE anywhere, permanently) | 6 @ 1 | **GATED** — `proxy.ts` ×8 call sites, tiers 1 and 2, plus the `wouldLockOut` preflight; UI-enforced | Sites; resources (+ rules/targets drill-in); org domains |
| **Dockhand** | `integration-dockhand` | 5 — `probeSession`, `listHosts`, `listContainers`, `listStacks`, `readHosts` | 1 — `applyHost` (create/update an environment; **no delete member**) | 8 @ 2, login costs 4 | **GATED** (joined `loxep-47o.10`) — `assertWritePolicy` in `container-hosts.ts`'s `reconcile()`, tier 1, reason `write_policy`; UI-enforced. See [8.3](#83-dockhand-applyhost-is-write-capable-and-ungated) | Environments (instance-wide); containers and stacks per environment |
| **Beszel** | `integration-beszel` | 2 — `health`, `listSystems` | 0 | 8 @ 2 | n/a — read-only by construction (`capabilities().readOnly` is the literal `true`) | Hub health; systems (hub-wide) |
| **Tailscale** | `integration-tailscale` | 2 — `probe`, `listDevices` | 0 | 8 @ 2 | n/a — read-only by construction; only non-GET is the OAuth exchange | Tailnet devices (whole tailnet) |
| **Termix** | `integration-termix` | 3 — `probe`, `listHosts`, `listSessions` | 0 | 8 @ 2, login costs 2 | n/a — read-only by construction; forbidden-verb test asserts the exported surface | Hosts (instance-wide); active sessions |
| **Gatus** | `integration-gatus` | 5 — `probeConfig`, `health`, `listEndpointStatuses`, `endpointUptime`, `endpointResponseTime` | 0 (config is files-only; no API exists) | 10 @ 2 — the largest | n/a — read-only by construction | Instance posture/health; endpoints; per-endpoint uptime drill-in |
| **Invoice Ninja** | `integration-invoiceninja` | 5 — `probeConnection`, clients page + detail, invoices page + detail | 5 — `createClient`, `updateClient`, `createInvoice`, `updateInvoice`, `markInvoiceSent` (a **GET that mutates**) | 5 @ 2 (unexported; private to `adapter.ts`) | **UNGATED** — `pushDraftInvoice` guards only on a `resource_links` idempotency check. See [8.4](#84-invoice-ninja-writes-are-ungated-too) | Clients; invoices |
| **eBay** | `integration-ebay` | 8 — browse search/item ×2, sell orders + order + fulfillments, watchlist, won-list | 0 | 10 @ 1.5 (composition root) | n/a — read-only; `tradingCall` is a generic escape hatch the package only ever hands read call names | *Ruled out — see [section 4](#4-the-commerce-boundary)* |
| **WooCommerce** | `integration-woo` | 3 — `probeConnection`, orders page, products page | 0 — *"This package writes nothing"* | 5 @ 1 (composition root) | n/a | *Ruled out* |
| **Medusa** | `integration-medusa` | 3 — `probeConnection`, orders page, products page | 0 — same explicit note | 5 @ 2 | n/a | *Ruled out* |
| **Etsy** | `integration-etsy` | 5 — `ping`, listing, shop, active shop listings, private shop listings | 0 (the one POST is the OAuth token exchange) | 10 @ 10 — **ONE budget shared across every Etsy connection**, because the provider limit is per *application key*, not per account | n/a | *Ruled out* |
| **Reverb** | `integration-reverb` | 3 — `getListing`, `getMyListings`, `getAccount` | 0 | 5 @ 1 (self-described as *"a documented guess, not a verified Reverb number"*) | n/a | *Ruled out* |

### 1.1 Headline numbers

- **14 adapter packages. 65 read methods. 17 write verbs across 5 packages; 9 packages have zero write verbs by construction.**
- **3 of the 5 write-capable providers are write-policy gated today** (Cloudflare, Purelymail, Pangolin) — the same three, and only those three, in `WRITE_POLICY_ENFORCED_PROVIDERS` (`apps/web/src/features/settings/constants.ts`). **Dockhand and Invoice Ninja can write and are not gated.**
- **9 providers are estate-page candidates** (the eight Infrastructure-category providers plus Invoice Ninja). **5 are ruled out** (the commerce five).
- **Rate budgets span 5 @ 1/s to 10 @ 10/s.** Four providers refill at 1/s (Cloudflare, Purelymail, Pangolin, Woo, Reverb) — that is the number that sets the fan-out rule in [2.4](#24-budget-aware-fan-out-the-hard-numeric-rule).
- **Every adapter shares one five-member error taxonomy** (`auth`, `rate_limited`, `not_found`, `invalid_request`, `provider_unavailable`), deliberately duplicated per package per [ADR-0009](../../decisions/0009-integration-boundaries/). An estate page can therefore map error kind to an honesty state **once**, generically, for every provider.
- **No adapter exports a provider response type.** Every estate DTO re-declares shape structurally at the `apps/web` boundary, exactly as `pangolin-estate-functions.ts` already does.

### 1.2 The write-policy model, and what joining it costs

`packages/infrastructure/src/write-policy.ts` provides two independent gates. `assertWritePolicy` answers *"may this connection, on this trigger, from this actor, perform an operation of this tier?"* and throws `WritePolicyError`; `wouldLockOut` answers *"would applying this remove the operator's way back in?"* and takes **no policy parameter at all**, so it cannot be satisfied by raising a tier.

The stored setting is `infrastructure.provider_write_policy` — a `Record<connectionId, tier>` over `read_only` / `additive` / `access_affecting` / `lockout_class`, keyed by **connection id, not provider**, defaulting to `read_only` for any absent key. The tier vocabulary is provider-agnostic, so joining the model for a new provider requires **no type change**:

1. Thread `connectionId` (and, for tier-2-capable providers, the full `writeAuthorization` context) from `packages/app`'s composition root into the service — the `infrastructure-poll-executor.ts` / `infrastructure-mail.ts` / `infrastructure-proxy.ts` precedents.
2. Call `assertWritePolicy` immediately before the first provider write, with a required `unblockHint` naming the flip; catch `WritePolicyError`, record `writePolicyBlockedStep(error)` as a `blocked` step, finish the run `partial` — never `failed`, never a silent skip.
3. Add the provider string to `WRITE_POLICY_ENFORCED_PROVIDERS` so the connections-table cell renders a control instead of `—`. **Omitting this leaves the gate enforced with no way to flip it.**
4. Name the provider in `providerWritePolicySetting`'s description so the setting's own copy stays honest.
5. Add a `wouldLockOut` reason only if the provider's writes can genuinely remove operator access.

**Binding rule W1.** An estate page never mounts a write affordance for a provider whose write path is not gated. If the provider needs to join the model first, that joining is a prerequisite bead, not something the estate page does inline.

### 1.3 The estate-ish surfaces that already exist, and must be linked rather than duplicated

| Surface | Route | What it already is | Estate page's obligation |
| --- | --- | --- | --- |
| Dockhand containers panel | `/infrastructure/fleet/$name` | Live-read containers + stacks for **one linked host** | Stays. The estate page is **instance-wide**; the panel is per-host. Link each estate environment row to its fleet-detail page. |
| Termix sessions panel | `/infrastructure/fleet/$name` | Live-read sessions for **one linked host** | Same split. See [8.6](#86-instance-wide-termix-sessions-name-humans) before listing sessions instance-wide. |
| Gatus heartbeat mirror | `/infrastructure/overview` (`FleetSignalsBand`) + `GatusPushCard` on `/settings/application` | Gatus's opinion of *Loxep's own* heartbeat endpoint, plus the outbound push config | Stays where it is. The Gatus estate page renders *Loxep's read of Gatus*; the mirror renders *Gatus's opinion of Loxep*. Binding rule 2 of `loxep-1au` keeps those in separate fields permanently — the estate page must not merge them, and must exclude the quarantined `endpointKey` rows exactly as discovery does. |
| Tailnet candidates panel | `/infrastructure/fleet` | Persisted, unlinked Tailscale devices with link/declare/ignore | The estate page shows the **whole** tailnet including linked devices; the candidates panel keeps owning the *disposition* verbs. Estate rows link to the panel's actions, never re-implement them. |
| DNS records + drift | `/infrastructure/domains/$name` | Loxep's **desired** `dns_records` plus `dns_drift_findings` with Adopt/Dismiss | The Cloudflare estate shows the provider's **actual** zones and records, including zones Loxep has no `managed_domains` row for. A record that is already declared links to the domain page; it is never re-rendered as editable here. |
| Mail panel | `/infrastructure/domains/$name` | Per-domain mail enablement, mailbox template, mailbox lifecycle badges | The Purelymail estate is **account-wide** (users and routing rules are account-scoped API calls, not per-domain). Every domain row links back to its domain page. |
| Market + Commerce workspaces | `/market/*`, `/commerce/*` | Observed public items; owned catalog/listings/orders, provider-filterable | Ruled out as estate subjects — [section 4](#4-the-commerce-boundary). |
| Invoice Ninja push | `/finance/overview` dialog | On-demand draft-invoice push, idempotency-checked via `resource_links` | The Invoice Ninja estate lists clients and invoices and links each pushed draft to its Loxep record; it does not grow a second push entry point. |
| Connections table | `/settings/connections` | One unified table across all 14+ providers, with the `WritePolicyCell` | **The universal entry point** — see [section 5](#5-navigation). Its row menu currently links out to exactly one place (`/inventory/acquisitions`), and the route file's own comment records that there is no per-connection detail route to link to. This program creates one. |

## 2. The estate-page pattern

Extracted from `apps/web/src/server/pangolin-estate-functions.ts` (`loxep-pq2`) and generalized. Every rule below is binding on every estate page.

### 2.1 URL convention

**Rule P1.** The route is `/<workspace>/estate/$connectionId`. The parameter is a `connections.id` UUID. **The provider is read from the connection row, never encoded in the path.**

A role-named segment (`/infrastructure/proxy/$id`, `/infrastructure/dns/$id`) was considered and rejected: it is a guess that breaks for every provider spanning two roles — Cloudflare is zones *and* records, Pangolin is proxy *and* domains *and* sites — and it forces a second mapping that the connection row already carries. One route file per workspace, one shared page component, and one provider→sections registry keyed on `connections.provider` — the same "code, not schema, keyed by provider" shape `FLEET_TOOL_REGISTRY` and `integrations-catalog.ts` already use.

`loxep-pq2` predated this convention and its module doc originally named `/infrastructure/proxy/$connectionId`; `loxep-47o.1` converged it onto `/infrastructure/estate/$connectionId` — the route rename its own scope promised, with no server-function or component impact.

**Rule P2.** The page is **per connection, always**. Two Pangolin instances are two pages. N WooCommerce stores would be N pages. There is no "all Cloudflare zones across every account" view, no cross-connection rollup, and no page-level verdict spanning connections — the witness-not-verdict discipline `infrastructure-functions.ts` already documents for the fleet signals band applies unchanged.

### 2.2 Section anatomy

Every estate page is:

```text
Header       connection name · provider · non-secret account identity (base URL,
             account key) · connection health status WITH ITS OWN CLOCK · write-policy
             tier badge (or "not enforced for this provider") · deep link to the
             provider's own UI.

Section 1..N one provider list each. Each section carries:
             - a title and a one-line description naming the call it made
             - its OWN `readAt` stamp (Loxep's clock, fresh every render)
             - a DataTable on the sanctioned path (columns.tsx + useDataTable +
               DataTable + DataTableToolbar + DataTableSkeleton)
             - a cross-reference column: for every row, whether Loxep owns a
               corresponding record, and a link to it
             - its own empty / error / blocked state (2.6)
             - optional row expander (2.3)

Actions      attached to the row they concern. Never a page-level action bar.
```

**Rule P3.** Provider truth renders **verbatim**. Reshaping is permitted (numeric booleans to real booleans, unwrapping an envelope, flattening nesting); re-labelling is not. A provider's own status string renders as that string. Loxep never coins a verdict word for a provider fact, and never colours a row green on the strength of one.

**Rule P4.** **Every section stamps its own clock.** There is no page-level "last updated". *"Dockhand, read just now"*, *"Beszel says, 4 minutes ago"*, and *"Loxep could not reach Gatus for 20 minutes"* are three different statements and must look different — `loxep-hb7` §3.2 rule 2, carried over unchanged.

**Rule P5.** **Live-read, never persisted.** No table, no cache, no cadence, no background refresh, no prefetch. `readAt` is Loxep's own clock, not a staleness figure, because there is no storage for anything to become stale against. Persisting an estate read is how this program would turn into the time series [Phase 8](../fleet-observability-design/) exists not to build.

### 2.3 Lazy drill-in

**Rule P6.** A per-row detail read fires **only** on explicit operator expand, for **one row at a time**, and **only when the overview does not already carry the answer**. `pangolin-estate-functions.ts` states the general form: a resource already matched to a declared `proxy_resources` row has its rules sitting in the overview response's `declared` field (a database read, not a fourth provider call), so expanding it costs nothing further; only an *undeclared* resource pays for `listRules` + `listTargets`.

### 2.4 Budget-aware fan-out: the hard numeric rule

Four of the estate-candidate providers refill at **1 token/second** with a capacity of 6–8. That is the number the pattern is built around, and the reason is recorded in `pangolin-estate-functions.ts`' own module doc: capacity 5 refill 1/s is *"comfortably enough for the overview's fixed THREE calls… but NOT enough to fan out one `listRules`/`listTargets` pair per resource in the same render, which is exactly what the recon test that live-verified this adapter learned the hard way."*

**Rule P7.** **The overview's provider-call count is a constant, independent of estate size.** Concretely: **at most 3 calls for the overview, at most 2 per drill-in.** A section that would need one call per row is not a section — it is a drill-in.

**Rule P8.** Pagination is **operator-driven, never automatic**. A "Load more" affordance costs one call and says so. Nothing on an estate page walks every page of a paginated endpoint on render — that is what the poller's `maxPages` ceilings exist for, on a cadence, not on a page a human opened. Where a provider's list endpoint does not paginate at all (Tailscale devices, Pangolin lists, Purelymail's `listUsers` with its hard 1000 cap), the section renders the one call's full result and states the cap.

**Rule P9.** Filtering and sorting happen **within what was already fetched** (the `applyClientTableState` precedent the Dockhand and Termix panels already use), never by re-querying the provider. A filter box that could silently trigger a fan-out is forbidden.

### 2.5 Control in context

**Rule P10 — the hard one.** An estate page **mounts** existing write paths. It never **creates** one. Concretely, an action may appear on an estate page only if all four hold:

1. The write path already exists in a package outside `apps/web` (an adapter verb reached through a gated service, or a Loxep-own intent write).
2. It is already reachable from some other surface, or is a Loxep-own write that touches no provider.
3. If it touches a provider, it passes through `assertWritePolicy` at a call site that already exists.
4. The estate page adds no new provider verb, no new payload shape, and no new task.

The one write `loxep-pq2` adds is `adoptPangolinResourceAsProxyResource`, and it is admissible precisely because it makes **no Pangolin call of any kind** — it writes Loxep's own `proxy_resources` intent row through `declareFromObserved`. That is the shape to copy.

**Rule P11 — adopt-into-intent.** Where a provider has an intent model in Loxep (Cloudflare's `dns_records`, Pangolin's `proxy_resources`, Dockhand's container-host registration, the fleet `resource_links` model), the estate page's primary verb is **adopt**: turn an observed provider object into a declared Loxep record. Adoption is idempotent, changes nothing on the provider, does **not** enqueue a reconcile ("adopt" means *start controlling this from Loxep*, not *apply now*), and is admin-only. Where an operator confirmation is genuinely required to complete the record — which Loxep `managed_domain` a Pangolin domain corresponds to, which `hosting_target` actually serves a resource — the dialog asks; Loxep never guesses a foreign key.

**Rule P12 — mount, do not re-implement.** Where an action already has components (`ProxyResourceRow`, `RuleRow`, the retire/re-enable typed-confirmation flow, `AttachDiscoveredResourceDialog`, the tailnet candidates panel's link/declare/ignore), the estate page renders **those components wired to those server functions**. It must be impossible for the estate page to render a chain differently than the domain or fleet detail page does.

### 2.6 Honesty states

**Rule P13.** Four states, four distinct renders, never collapsed:

| State | What it means | Render |
| --- | --- | --- |
| **Empty** | The call succeeded and the provider genuinely has none of these | The section, with a stated empty message naming what was asked |
| **Blocked** | Loxep refused to try — no org id, OIDC posture with no server credential, an unwinnable call | The section, rendering the *reason* verbatim. `pangolin-estate-functions.ts`' `orgId === null` branch is the model: return the shape with empty lists and let the page say why, rather than throwing |
| **Error** | The provider or transport failed | The section, with the error kind's own sentence and a retry. `rate_limited` from the local budget (`detail.source === 'local_rate_budget'`) says *Loxep throttled itself*, which is a different sentence from the provider's 429 |
| **Absent** | This section does not apply to this connection at all | **The section does not render.** Nothing configured must never look like everything healthy — `loxep-hb7` §3.2 rule 3 |

**Rule P14.** A write affordance that policy currently forbids renders **visibly blocked with the flip named**, never hidden and never silently inert. This is the same `unblockHint` string `assertWritePolicy` already requires, surfaced in the UI rather than only in a `reconcile_run_steps` row.

**Rule P15.** No estate page, and no estate section, ever puts a count badge on a nav item. The unmapped, undeclared, unlinked majority of a provider's estate is the normal and permanent case, not a backlog — `loxep-1au` binding rule 3, which the tailnet candidates panel already shares.

### 2.7 Jurisdiction: the anti-soup rule versus the estate pattern

The **anti-soup rule** (`loxep-hb7` §3.2, three rules; today it lives only in bead text and code comments, and this section is its first statement in the docs) governs `/infrastructure/fleet/$name`. Its rule 1 is:

> A TOOL NEVER GETS A PANEL FOR ITS STATUS ALONE. Statuses live in the Companion tools panel and roll into the header chip. A tool earns a panel only by contributing rows Loxep cannot otherwise show (Dockhand's containers) or a write surface (host registration). This is what stops the page growing one card per integration forever.

**The two rules govern different spaces and cannot conflict.**

| | Fleet detail (`/infrastructure/fleet/$name`) | Estate page (`/<workspace>/estate/$connectionId`) |
| --- | --- | --- |
| Subject | **one hosting target**, described by N tools | **one connection** of **one** provider |
| Failure mode it guards against | one card per integration, forever | one call per row, forever |
| Governing rule | anti-soup: a tool earns a panel only by contributing rows nothing else can show | fixed-cost overview (P7) + verbatim truth (P3) |
| Scope of a list | that one host's containers, that one host's sessions | the whole instance, the whole tailnet, the whole account |

The anti-soup rule is satisfied **vacuously** on an estate page: there is exactly one tool on it by construction, so "one card per integration" cannot arise. Its replacement constraint is P7 — an estate page's growth is bounded by the rate budget, not by taste.

**Rule P16 — no cross-recruitment.** An estate page never grows a second provider's section; doing so would rebuild the fleet page badly and re-open the soup. The fleet detail page never grows a connection-wide inventory; doing so is precisely what anti-soup rule 1 forbids. When a provider gains an estate page, its **instance-wide** inventory moves there and its **per-host** panel stays on fleet detail. The shipped Dockhand containers panel and Termix sessions panel are per-host and correctly placed — this program does not move them.

## 3. Per-provider specifications

Each provider's own design's not-worth-building list still binds in full. Nothing below overrides one.

### 3.1 Cloudflare — `/infrastructure/estate/$connectionId`

**Sections.** (1) **Zones** — `listZones` (paginates, `maxPages`; capped at one page per Load-more click). Columns: name, status verbatim, plan, name servers, and the cross-reference *Managed by Loxep* / *Not declared* against `managed_domains`. (2) **Records** — a per-zone drill-in via `read({externalZoneId, zoneName})`, one zone at a time; columns type, name (FQDN via the adapter's own `toLoxepName`), content, TTL (`1` rendered as *automatic*), proxied, and the cross-reference against `dns_records` (*Declared* / *Drift finding open* / *Unexpected*).

**Drill-ins.** Records per zone. Nothing deeper — there is no `getRecord`.

**Writes today.** `apply` exists and is gated. **Adopt-into-intent** is the estate page's verb: adopting an observed record writes a `dns_records` row with `owner = 'manual'`, which is exactly what the shipped drift panel's Adopt button already does — the estate page mounts that server function, entered zone-first rather than drift-finding-first.

**Permanently read-only here.** Direct record editing, record deletion, zone creation (no verb exists), token mint/roll (a request-scoped admin action by hard constraint, and not an estate concern). The estate page never becomes a DNS editor; a declared record is edited on `/infrastructure/domains/$name` and applied through the reconciler.

**Highest-value fact this page adds:** the zones and records Loxep has **no** `managed_domains` row for. Nothing in Loxep can see those today.

### 3.2 Purelymail — `/infrastructure/estate/$connectionId`

**Sections.** (1) **Account** — `checkAccountCredit` (provider's own string, verbatim) and `getOwnershipCode` (per **account**, not per domain). (2) **Domains** — `listDomains`, with the cross-reference against `mail_domains`. (3) **Mailboxes** — `listUsers`, **account-wide** (the API has no per-domain filter), hard cap 1000, stated. (4) **Routing rules** — `listRoutingRules`, account-wide.

That is **four calls**, one over P7's overview budget of three. Resolution: the Account section is folded into the header and its two calls are made lazily on header expand, leaving domains + mailboxes + routing as the three-call overview. `requiredRecords` is synchronous and free.

**Drill-ins.** None — there is no detail endpoint for any Purelymail object. Every section is its one list call.

**Writes today.** All six write verbs are gated in `mail-sync.ts` at tier 1 with reason `credential_scope`. Per the generalized write-policy ruling ([8.1](#81-purelymail-writes)), the estate page mounts the two that already have a service-layer path — `runMailDomainSync` ("Sync now") and `runMailboxSync` ("Sync mailboxes") — on any domain row already registered on THIS connection, both rendering policy-blocked at the connection's current `read_only` tier. `deleteUser`/`createUser`/`createRoutingRule`/`deleteRoutingRule` have no per-row service-layer path and are not mounted — see [8.1](#81-purelymail-writes) and the follow-up bead it files (`loxep-47o.11`).

**Permanently read-only here.** `deleteUser` (destroys mail), `deleteDomain` (present in `operations.ts`, deliberately never called by Loxep), `appPassword.create` and the password-reset operations (deliberately unimplemented; `appPassword.create` is the one Purelymail response documented to return a credential, and [ADR-0022](../../decisions/0022-minted-secret-reveal/)'s reveal-once channel does not reach the reconciler's mint). Loxep never sends or reads mail through this connection.

**Highest-value fact this page adds:** mailboxes and routing rules that exist in the account but correspond to no `mailboxes` row — the account's real shape, which today is invisible outside the per-domain mail panel.

### 3.3 Pangolin — reference implementation (`loxep-pq2`)

**Sections.** Sites (status, newt liveness), resources (fullDomain, mode, enabled, SSO/auth posture, rule counts, cross-referenced against declared `proxy_resources`), org domains. **Exactly three calls regardless of estate size** — live-verified 2026-08-16 at 10 sites / 20 resources / 9 domains.

**Drill-ins.** Rules + targets per resource, two calls, **undeclared resources only**.

**Writes today.** `adoptPangolinResourceAsProxyResource` (Loxep-own, no provider call). Retire/re-enable per rule mount the existing M7 typed-confirmed server functions on the existing `RuleRow` component. Apply affordances render policy-blocked.

**Permanently read-only here.** The design's own ten-item not-worth-building list binds unchanged: no rollback, no rule-expression language or generic ACL engine, no mirroring of Pangolin users/roles/orgs/IdPs, no traffic or session metrics, no teardown, no certificate management, no cross-instance synchronization, no rule simulator. There is no DELETE verb in the adapter and there never will be.

**Open constraint.** No Pangolin write of any tier has ever executed against a live instance (`loxep-acj.9`). Until it has, every apply/retire affordance on this page renders policy-blocked — which it does today, because `prod-primary` sits at `read_only` by owner policy.

### 3.4 Dockhand — `/infrastructure/estate/$connectionId`

**Sections.** (1) **Environments** — `listHosts`, instance-wide, cross-referenced against `external_resources`/`resource_links` and the auto-attached hosting target. (2) **Containers** and (3) **Stacks** — per-environment drill-in (`listContainers` + `listStacks`, two calls, exactly what the per-host panel already makes).

**Drill-ins.** Containers + stacks per environment. Login costs 4 tokens against a capacity of 8, so a page render that has to authenticate has 4 tokens left — which is why the overview is `listHosts` alone and container reads are expand-only.

**Writes today.** `applyHost` exists but is **ungated** ([8.3](#83-dockhand-applyhost-is-write-capable-and-ungated)). Wave 2 ships this page **read-only**; the existing `ContainerHostRegistrationPanel` on fleet detail keeps owning registration. The estate page's one verb is **adopt-as-hosting-target** for an unmatched environment, which is the `/infrastructure/overview` card's existing server function mounted here — a Loxep-own write, no Dockhand call.

**Permanently read-only here.** Everything in `DOCKHAND_FORBIDDEN_PATH_SEGMENTS` and `DOCKHAND_FORBIDDEN_MEMBER_VERBS`: start, stop, restart, kill, pause, unpause, exec, logs, terminal, file browse, deploy, redeploy, prune, pull, push, images, networks, volumes, schedules, auto-update. No lifecycle control, and no UI that implies one — no disabled Restart button. Loxep never deletes a Dockhand host; the adapter has no delete member.

**Shipped (`loxep-47o.4`, 2026-08-16, read-only).** Environments cross-reference `external_resources`/`resource_links` for a `'linked'` / `'unmatched'` / `'unknown'` verdict, live-verified at 15 environments (1 already linked, 14 unmatched). The containers/stacks drill-in reads `listContainers`/`listStacks` by `externalHostId` DIRECTLY rather than through `fetchDockhandHostView`'s `hostingTargetId` indirection — see `dockhand-estate-functions.ts`'s own module doc for why this is deliberately NOT a call to the shipped per-host `DockhandContainersPanel` (Rule P16's "no cross-recruitment" applies to the component/query, not only the section) — so it also works for an environment Loxep has not attached to a hosting target yet. No lifecycle field exists on any DTO this page returns, and `test/forbidden-verbs.test.ts` remains the binding proof of the adapter's own exported surface.

### 3.5 Beszel — `/infrastructure/estate/$connectionId`

**Sections.** (1) **Hub** — `health` (unauthenticated). (2) **Systems** — `listSystems`, hub-wide, paginated at 200/page with a 25-page ceiling; columns name, host, port, status verbatim, `updated`, cross-referenced against linked hosting targets. **Two calls.**

**Drill-ins.** None. There is no `getSystem`, and there must never be a metric read.

**Writes.** None, ever. `capabilities().readOnly` is the literal type `true`.

**Permanently read-only here.** No metric samples, no time series, no CPU chart — *"a milestone that ships a CPU chart has started rebuilding Beszel"*. No alert configuration; Beszel alerts must not route through Loxep, since Loxep may be running on the monitored machine. The estate page's verb is **attach** (the existing operator-confirmed picker), nothing more.

**Shipped (`loxep-47o.7`, 2026-08-16).** The shipped `AttachDiscoveredResourceDialog` fixes the HOST and lets the operator pick a discovered system — the right direction for the fleet-detail page it was built for, but this page's rows are SYSTEMS. The estate page's Attach button therefore mounts a new thin picker (`AttachBeszelSystemDialog`) that fixes the SYSTEM and lets the operator pick the host — the SAME `attachDiscoveredFleetResource` write, entered from the opposite direction, exactly the precedent `LinkDeviceDialog` already established for the Tailscale estate page's own Link action (see §3.6 below). No new write path, no new payload shape (Rule P10) — only the picker's fixed side differs.

### 3.6 Tailscale — `/infrastructure/estate/$connectionId`

**Sections.** (1) **Tailnet** — `listDevices`, the whole tailnet in one unpaginated call; columns name, hostname, OS, online, lastSeen, authorized, addresses, cross-referenced against `resource_links` keyed on `nodeId`, plus the ignored-devices setting. **One call** — `probe` is the same read and is not repeated.

**Drill-ins.** None. No `getDevice` exists.

**Writes.** None against Tailscale, ever. The estate page mounts the tailnet candidates panel's existing **link / declare / ignore** verbs per row — all three Loxep-own writes.

**Permanently read-only here.** No ACL or policy-file content, no key management, no device authorize/remove, no route table, no per-device polling, no online history, and Loxep never pings a `100.64.0.0/10` address. A tailnet address must never write `hosting_targets.address_v4/v6` — those feed the DNS materializer, and a published CGNAT address is an outage that presents as a propagation problem.

**Note on scope.** A tailnet holds laptops and phones. The estate page shows all of them because that is what an estate page is; the *health* model deliberately does not, and that asymmetry is correct and must not be "fixed".

**Shipped (`loxep-47o.6`, 2026-08-16).** The whole tailnet renders from the one `listDevices()` call with three cross-reference states shown together — linked, ignored, plain candidate — never filtered to only the unlinked remainder (that filtering stays the fleet-list candidates panel's own job). Link/Declare/Ignore reshape each row into the candidates panel's own `UnmatchedTailscaleDeviceDto` shape and mount its EXACT `LinkDeviceDialog`/`NewHostingTargetDialog` components and `attachDiscoveredFleetResource`/`setTailscaleDeviceIgnored` server functions — no new write of any kind. Every address column renders plain, monospace text with no click handler, no copy icon, and no "use as address" affordance anywhere near it — the CGNAT rule enforced at the component level, since nothing server-side here ever touches `hosting_targets.address_v4/v6` to enforce it there.

### 3.7 Gatus — `/infrastructure/estate/$connectionId`

**Sections.** (1) **Instance** — `probeConfig` (unauthenticated; recovers the three-way `open`/`basic`/`oidc` posture) and `health`. (2) **Endpoints** — `listEndpointStatuses` (explicit page/pageSize; `direct` posture only), columns key, group, name, success, httpStatus, `observedAt` (**Gatus's** clock, distinct from Loxep's `readAt`), errorCount, cross-referenced against linked hosting targets. **Three calls.**

**Drill-ins.** `endpointUptime(key, duration)` per endpoint — the one read that works in **every** auth posture, since the per-endpoint uptime route is permanently unauthenticated. This is what makes Gatus's estate page usable even on an OIDC instance where the bulk read is unwinnable.

**Writes.** None. Gatus configuration is files-only with a 30s poll and no API. A copyable static YAML snippet is permitted; a written file or a config editor never is.

**Permanently read-only here.** No response-time charts, no multi-bucket renders, no history routes, no badge proxying, no suites, no fleet-wide uptime percentage, no Loxep-run URL checks.

**Mandatory exclusion.** The endpoints named by `gatusPushSetting.endpointKey` and its five derived fact keys (`gatusPushQuarantinedKeys()`) are excluded from this page's endpoint list in every posture, whether or not the push is enabled — for the same self-latching-loop reason discovery excludes them. Loxep's own heartbeat belongs on the `GatusPushCard`, not in an inventory of things Loxep watches.

**Shipped (`loxep-47o.5`, 2026-08-16).** The three-way posture is a display-only inference (`inferGatusEstatePosture`) layered on the adapter's own binary `oidc` signal, never gating a read. Endpoints renders Rule P13's BLOCKED state — never an error — for the adapter's own structural `detail.mode === 'oidc_degraded'` refusal (`isGatusOidcDegradedRefusal`), keeping a genuine credential rejection in direct posture (no `detail.mode`) as an honest ERROR instead. The mandatory exclusion reuses `@loxep/app`'s `gatusPushQuarantinedKeys()` (newly re-exported from `fleet-health.ts`, the SAME derivation `gatus-push.ts` pushes to and discovery's own `projectGatusEndpoints` excludes) rather than re-deriving it, and the excluded count renders as a one-line explanation. Live-verified 2026-08-16: `mode: "direct"`, 5 endpoints, `excludedHeartbeatCount: 0` honestly reflecting that this installation's `infrastructure.gatus_push` setting has never been configured.

### 3.8 Termix — `/infrastructure/estate/$connectionId`

**Sections.** (1) **Hosts** — `listHosts` (internally two calls: `/hosts` + `/status`), instance-wide, cross-referenced against linked hosting targets. (2) **Sessions** — `listSessions`, instance-wide. **Two adapter calls**, three HTTP requests, plus a login costing 2 tokens.

**Drill-ins.** None.

**Writes.** None, ever. `TERMIX_FORBIDDEN_MEMBER_VERBS` is asserted against the exported surface by a boundary test that is a security control, not a style check: this credential is full-power against a surface that includes terminal exec, stored SSH credentials, and Guacamole, and Termix has no read-only role.

**Permanently read-only here.** No command execution, no terminal embedding, no proxied session, no file manager, no credential/snippet/tunnel management, and no UI that implies any of them at any tier.

**Shipped (`loxep-47o.7`, 2026-08-16).** Both sections ship together. The instance-wide Sessions section was **OWNER-REVIEW-CRITICAL** at design time — see [8.6](#86-instance-wide-termix-sessions-name-humans) — and shipped only once the owner's 5b ruling (2026-08-16) granted it explicitly, on the same trust basis as the per-host panel's own 2026-08-15 grant. `sharedByUsername` renders verbatim, defensively parsed (Termix's own `stableRecordShapes: false`), reusing the per-host panel's EXACT column set (`termix-sessions-panel/columns.tsx`'s `termixSessionColumns`) rather than a parallel render.

### 3.9 Invoice Ninja — `/finance/estate/$connectionId`

**Sections.** (1) **Clients** — `fetchClientsPage`, page-number pagination, operator-driven Load-more. (2) **Invoices** — `fetchInvoicesPage`, same. Each cross-referenced against `resource_links` (`provider='invoiceninja'`, `purpose='billing_invoice_draft'`) and against `counterparties`. **Two calls.**

**Drill-ins.** `fetchClient` / `fetchInvoice` per row.

**Writes today.** Five write functions exist and **none is write-policy gated** ([8.4](#84-invoice-ninja-writes-are-ungated-too)). The estate page mounts **no** write affordance. Pushing a draft stays on `/finance/overview`'s existing dialog; the estate page links to it.

**Permanently read-only here.** No invoice editing, no `markInvoiceSent` (note it is a **GET that mutates**, so no "safe GET" assumption may be made anywhere near this provider), no pulling invoice lines back once issued, no second push entry point.

**Placement.** `/finance`, not `/infrastructure` — the workspaces map scopes `/infrastructure` to *"the machines and names Loxep and its owner's other services run on"*, and an Invoice Ninja client list is not that. This is why P1 parameterizes the workspace rather than hard-coding `/infrastructure`.

## 4. The commerce boundary

**Ruling: eBay, WooCommerce, Medusa, Etsy, and Reverb get no estate pages.** Four independent reasons, any one of which would be sufficient:

1. **There is no control to put in context.** All five adapters export **zero** write verbs, and *"Phase 3 ingestion is read-only against providers"* is a stated non-goal, not an omission. The owner's whole ask is *tweaking things without logging into the app*; a commerce estate page would offer nothing to tweak. It would be a read-only mirror of a UI the operator can already reach in one click.

2. **The normalized views already do the job, and are better at it.** `/commerce/listings` and `/commerce/orders` already render every channel listing and order with a **provider filter**, sortable and paged, joined to catalog items, fees, refunds, and fulfillments. `/market/items` already renders observed public listings with price history and availability timelines. A per-connection raw view would show strictly less, with no history, at a provider round-trip's cost.

3. **Raw provider truth already has a home, and a deliberate one.** `source_events` and `provider_objects` retain provider payloads verbatim, hash-deduped and redactable ([ADR-0021](../../decisions/0021-order-payload-retention/)), joined to orders through `order_source_links` with a `created`/`updated`/`unchanged` effect. `/commerce/orders/$id` already surfaces that provenance as **metadata** — hash, object type, redaction state — rather than payload body, which is the shipped precedent for exactly this question. An estate page rendering live provider payloads would re-open the data-minimization decision that made buyer identity a channel-native reference rather than a legal name.

4. **The budgets are worst exactly where the estates are biggest.** Etsy runs **one** budget of 10 @ 10/s shared across *every* connection, because the provider limit is per application key — so a human opening an estate page competes directly with the poller, and Etsy's 10,000-queries-per-24h ceiling is not enforced by the bucket at all. Woo and Reverb refill at 1/s. Browsing a shop's listing inventory from a page is the single most expensive thing this program could do.

**The one real gap, and where it actually belongs.** The honest question a commerce estate would answer is *"what does the provider have that Loxep has never ingested?"* — an unsynced Woo product, an eBay listing absent from `channel_listings`, an Etsy draft. That is a **coverage** question, and the house already has a shape for it: the unmatched-candidates panel (tailnet devices, unmatched container hosts, document candidates) — an opt-in, collapsed panel on the owning workspace's list page, with per-row link/declare/ignore, no badge, and `null` on pending/error/empty. If that gap becomes real, it is a candidates panel on `/commerce/listings`, not a new estate page, and it is out of this epic's scope. Filed as `loxep-47o.9` at P4 with these reasons attached so a future reader does not mistake the ruling for an oversight.

**ntfy** likewise gets no estate page: it is a notification transport configured under `/settings/notifications`, not an account with an estate.

## 5. Navigation

One coherent answer, three rules.

**Rule N1 — the universal entry point is the connection row.** `/settings/connections`' row action menu gains **Open estate**, enabled exactly when the row's provider has an estate page. This closes the dead-end the shipped route file's own comment records (*"there is no per-connection detail route to link to instead"*), and it means an operator never has to know which workspace a provider lives in. `/settings/integrations`' catalog cards continue to link to `/settings/connections`, unchanged.

**Rule N2 — one nav entry per workspace, never one per provider.** `config/navigation/infrastructure.ts` gains a single **Estates** item pointing at `/infrastructure/estate`, an index listing every infrastructure-category connection with its provider, health status, write-policy tier, and a link to its page. `/finance` gains the equivalent when Invoice Ninja's wave lands. There is deliberately **no** global cross-workspace estates index: `/settings/connections` already lists every connection of every provider, and a second global list would be a fifteenth surface duplicating it.

**Rule N3 — deep links in, never badges.** Additional entry points, all of which already exist and only need an added link: `FleetSignalsBand`'s per-provider tiles on `/infrastructure/overview`; `CompanionLinksPanel`'s per-tool row on `/infrastructure/fleet/$name` (alongside its existing deep link to the tool itself); `/infrastructure/domains/$name`'s mail panel and drift panel (to the Purelymail and Cloudflare estates respectively). None of these gains a count badge — P15.

## 6. Prioritization: build waves

Ranked by the owner's stated pain (*tweaking things without logging into apps*) weighted by readiness and inverse risk.

### Wave 0 — the shared shell (blocks everything) — SHIPPED

Extracted from `loxep-pq2`: the `/<workspace>/estate/$connectionId` route pattern, the provider→sections registry, the shared section primitives (clock-stamped header, the four honesty states, the budget-aware expander, the cross-reference column), the `/infrastructure/estate` index, and the **Open estate** connection-row action. Converged pq2's route to the convention. **No new provider read of any kind.** See the implementation-status note above `loxep-47o.1`.

### Wave 1 — the two the owner named (highest control value)

| Rank | Provider | Why first |
| --- | --- | --- |
| 1 | **Cloudflare** — SHIPPED (`loxep-47o.2`) | DNS records are the thing he most wants to tweak. Write policy already wired and UI-enforced. Adopt-into-intent has a shipped precedent (the drift panel's Adopt) — and the estate page's own adopt affordance reuses that EXACT service call, adding no new verb. The unique fact it adds — zones and records Loxep has no `managed_domains` row for — is invisible today. |
| 2 | **Purelymail** | Users and routing are the second-named pain, and the account-wide shape is invisible outside the per-domain panel. Ships **read-only**: the credential is an unscopable full admin token, `createUser` is billable and non-idempotent, `deleteUser` destroys mail ([8.1](#81-purelymail-writes)). |

### Wave 2 — the view-mostly fleet estates (zero write risk, cheap)

Ranked within the wave by how often the owner would look at it:

| Rank | Provider | Unique value over what exists |
| --- | --- | --- |
| 3 | **Dockhand** — SHIPPED (`loxep-47o.4`, read-only) | Containers and stacks **instance-wide**; today only per linked host. Two calls per environment, expand-only. |
| 4 | **Gatus** — SHIPPED (`loxep-47o.5`) | All endpoints plus per-endpoint uptime; today counts only, and the uptime read works even in OIDC posture. |
| 5 | **Tailscale** — SHIPPED (`loxep-47o.6`) | The **whole** tailnet including linked devices; today only the unlinked remainder. One call. |
| 6 | **Beszel** — SHIPPED (`loxep-47o.7`) | Every system on the hub with its verbatim status. Two calls. |
| 7 | **Termix** — SHIPPED (`loxep-47o.7`) | Hosts instance-wide, plus Sessions instance-wide — resolved per the owner's 5b ruling, [8.6](#86-instance-wide-termix-sessions-name-humans). |

### Wave 3 — billing

| Rank | Provider | Notes |
| --- | --- | --- |
| 8 | **Invoice Ninja** | `/finance/estate/$connectionId`, read-only. First estate page outside `/infrastructure`, which is what proves P1's workspace parameter. |

**Pangolin** is not given a wave: `loxep-pq2` builds it, and Wave 0 converges it.

## 7. Not worth building

Falsifiable markers, so a future reader can tell whether the reasoning has expired.

- **A merged cross-connection or cross-provider estate view.** Witness-not-verdict: each connection stands alone. *Expires if* Loxep ever gains a genuine multi-account aggregation requirement — it has not, and P2 is load-bearing.
- **Any provider-mutating write born on an estate page.** P10. Includes every verb in each provider's own forbidden list.
- **Persisted estate snapshots, history, or diff-over-time.** This is the metric-history line and Phase 8's permanent non-goal. *Expires never* — the first person to ask *"when was it last running"* turns an estate page into a time series.
- **A refresh cadence, background prefetch, or auto-poll.** P5. A request-scoped read has no staleness because it has no storage.
- **Embedded iframes of a provider's own UI.** `FLEET_TOOL_REGISTRY.embeddable` is a recorded fact, not a feature: *"a deep link opens the tool, not a Loxep copy of it."*
- **Server-side search that walks every page to answer.** P9.
- **Count badges on nav items for estate contents.** P15.
- **Estate pages for link-only tools.** Owner 2026-08-14: *"remove the link-only stuff from within the app. If it doesn't integrate we don't mention it."* Netdata, Cockpit, and Uptime Kuma were deleted from `FLEET_TOOL_REGISTRY` for this reason; do not re-add them here.
- **Estate pages for eBay, WooCommerce, Medusa, Etsy, Reverb** — [section 4](#4-the-commerce-boundary).
- **An estate page for ntfy** — a transport, not an account.
- **A generic raw-JSON payload viewer.** Every adapter ships redactors precisely so payloads do not reach the UI, and `/commerce/orders/$id`'s metadata-not-payload render is the shipped precedent.
- **A second write-policy vocabulary for estate pages.** The tiers are provider-agnostic already; an estate page reads the same map through the same `resolveProviderWritePolicy`.

## 8. OWNER-REVIEW-CRITICAL

Each item below needs an owner decision before the affordance it describes may be built. None blocks the read half of any wave.

### 8.1 Purelymail writes

**RESOLVED per the generalized write-policy ruling.** The stored credential is a **fully-scoped admin token for the whole account**, and Purelymail has **no token scoping at all** — one token carries every operation including `deleteDomain`. Standing policy is *treat as read-only; any real interaction must target only `loxep.com` and be non-destructive*. On top of that, `createUser` is **billable and not idempotent** (no upsert exists), and `deleteUser` takes the mail with it.

**Decided (owner ruling 2026-08-16, #3 — generalizes past this page's own per-verb question):** *"no per-verb owner whitelists — the per-connection write-policy tiers + admin gating + typed confirmation ARE the authorization model… estate pages still mount service-layer paths only (P10) — full exercise means building the service verbs behind tiers, not raw API passthrough."* This supersedes the original recommendation above (ship read-only with no write question asked past "whether any write may originate here"): the Purelymail estate page mounts the write affordances for whichever `mail-sync.ts` service-layer verbs ALREADY EXIST and are ALREADY gated — `runMailDomainSync` ("Register domain") and `runMailboxSync` ("Sync mailboxes"), both tier 1, `blockedReason: 'credential_scope'` (unchanged from `mail-sync.ts`'s own worked example, since the credential is still unscopeable). Both render **policy-blocked** at the connection's current `read_only` tier — the owner's standing policy has not changed, only the MODEL for exposing the gate has. `deleteUser`/`deleteDomain`/`appPassword.create`/the password-reset operations remain **permanently unreachable** from this page regardless of tier, because they are not implemented in the adapter and Loxep never calls them — that boundary is code-level, not policy-level, and no tier flip changes it. Mailbox/routing-rule row-level CREATE, UPDATE, or DELETE initiated from a single estate-page row has no existing service-layer path at all (Purelymail's own API has no single-mailbox-create outside the reconciler's whole-domain convergence) — filed as a follow-up child bead (`loxep-47o.11`) rather than built this wave, naming the ruling.

### 8.2 Cloudflare record editing

The stored token is **full-account read-only**; the owner has offered to rescope it to write for `loxep.com` plus one dormant domain on request. An *edit this record* affordance on the estate page would be a new raw write path, which P10 forbids independently of the token.

**Recommendation:** adopt-into-intent only; declared records are edited on the domain page and applied through the reconciler, which already has the gate, the ledger, and the drift model. **Decision needed:** none for wave 1 — recorded so the rescope is not requested for a capability this design does not want.

### 8.3 Dockhand `applyHost` is write-capable and ungated

**RESOLVED, joined. Decided (owner ruling 2026-08-16, #2): join now.** `packages/infrastructure/src/container-hosts.ts`'s `reconcile()` gates its one possible write (`applyHost`, fired at most once per call, both the `create` and `update` branches) with `assertWritePolicy` immediately before attempting it — the same shape `sync.ts`/`mail-sync.ts` already use, keyed on the declared link's own `connectionId` (read off the `container_console` resource link, not a constructor option, because a Dockhand host can be registered against any of several connections). Both operation kinds are tier 1 (additive): the write is narrow — it creates or updates a row in Dockhand's own database; nothing executes on the target machine (the owner's 2026-08-13 carve-out) — so a refusal uses the default `blockedReason: 'write_policy'`, unlike Purelymail's `credential_scope`. A refusal records a `'blocked'` `reconcile_run_steps` row and the run finishes `'partial'`, rendered by the existing `RunStepsList` component unchanged (`apps/web/src/features/infrastructure/components/run-steps-list.tsx` already shows `errorDetail` — the `unblockHint` — for any step regardless of status, so no UI change was needed to satisfy P14).

`dockhand` was added to `WRITE_POLICY_ENFORCED_PROVIDERS` (`apps/web/src/features/settings/constants.ts`) and named in `providerWritePolicySetting`'s description (`packages/domain/src/settings-defaults.ts`) — see [8.7](#87-the-write-policy-settings-description-is-now-stale).

**Behavior change, recorded in the connecting-dockhand guide:** a Dockhand connection defaults to `read_only` like every other provider, so a "Reconcile" apply that previously always executed now blocks until an admin raises the connection's tier on `/settings/connections`. "Check now" is never gated (it makes no write). Tests: `packages/infrastructure/test/container-hosts.test.ts`'s "the write-authorization gate" suite (blocked create, blocked update, unblocked once the tier is raised, check-mode is never gated, a `poll` trigger may still apply this tier-1 write).

### 8.4 Invoice Ninja writes are ungated too

`pushDraftInvoice` guards only on a `resource_links` idempotency check; `createClient`/`createInvoice` reach the provider with no policy gate, and `invoiceninja` is absent from `WRITE_POLICY_ENFORCED_PROVIDERS`. Every write path in this package is source-verified but **never live-verified** — no write credential has existed in this environment.

**DECIDED, stays ungated for now (owner ruling 2026-08-16, #2):** Invoice Ninja is **deliberately left ungated for now**. The existing `pushDraftInvoice` flow works today on its own idempotency check, and re-litigating it under the write-policy model is deferred rather than forced into this wave — recorded here so the asymmetry with Dockhand (which DID join, [8.3](#83-dockhand-applyhost-is-write-capable-and-ungated)) reads as a decision, not an oversight. The Invoice Ninja estate page (wave 3, `loxep-47o.8`) still mounts no write affordance — unchanged. Joining the write-policy model remains a prerequisite for any FUTURE write affordance on this provider, and revisiting the ruling is explicitly left open for later.

### 8.5 Pangolin's first live write has still never happened

`loxep-acj.9` is open: no Pangolin write verb of any tier has executed against the real instance, and the standing policy holds `prod-primary` at `read_only`. An estate page that renders Apply and Retire next to real resources makes an accidental first write materially easier.

**Recommendation:** every Pangolin write affordance renders policy-blocked with the `unblockHint` visible until `loxep-acj.9` closes — which is what the current tier already produces, so this is a rule that costs nothing to hold and something to break.

### 8.6 Instance-wide Termix sessions name humans

`TermixSessionFact.sharedByUsername` names a person. The owner approved **per-host** session rows on a trust basis (2026-08-15: *"the more info the better… this tool is meant to be used by people that trust one another"*). An **instance-wide** list of who is logged into what is a materially broader surveillance surface than the approval covered, and `loxep-wvm` §3.3(a) already flagged the general shape.

**RESOLVED — owner ruling 2026-08-16, item 5b: instance-wide Termix sessions are permitted, on the SAME trust basis the 2026-08-15 per-host grant already established.** This supersedes the original recommendation below (ship hosts-only, wait for a grant) and `loxep-47o.7`'s own acceptance-criteria text, which was written before this ruling landed. The instance-wide Sessions section shipped in the SAME change as the Hosts section (`loxep-47o.7`, 2026-08-16) — see §3.8's own "Shipped" note above — reusing the per-host panel's exact column set and DTO shape (`termixSessionColumns`, `TermixSessionRowDto`) rather than declaring a parallel render, and `sharedByUsername` renders verbatim exactly as the per-host panel already does.

*Original recommendation, superseded above, kept for the historical record:* wave 2 ships the Termix hosts section only. **Decision needed:** an explicit grant for the instance-wide sessions section, or a permanent no.

### 8.7 The write-policy setting's description is now stale

**RESOLVED for Dockhand.** `providerWritePolicySetting`'s description named *"Pangolin, Cloudflare, Purelymail as of milestone 3"*. Now that Dockhand has joined per [8.3](#83-dockhand-applyhost-is-write-capable-and-ungated), both places the provider set is written down were updated together: the setting's description (`packages/domain/src/settings-defaults.ts`) now names Pangolin, Cloudflare, Purelymail, and Dockhand, and records that Invoice Ninja stays deliberately ungated; `WRITE_POLICY_ENFORCED_PROVIDERS` (`apps/web/src/features/settings/constants.ts`) gained `'dockhand'` in the same change, with a comment pointing back at this section as the reason the two lists must stay hand-synchronized. **Invoice Ninja remains open** — owner ruling 2026-08-16 (#2) is to leave it ungated for now (a working push flow; revisit later, recorded not forgotten) — see [8.4](#84-invoice-ninja-writes-are-ungated-too).

## 9. Decomposition into child beads

Filed under `loxep-47o`, dependency-ordered. Every child cites this page's rule numbers and is cold-executable from them.

1. **`loxep-47o.1` — Wave 0: the estate shell. SHIPPED.** The `/<workspace>/estate/$connectionId` route pattern (P1, P2), the provider→sections registry, the shared section primitives implementing P3–P9 and P13–P15, the `/infrastructure/estate` index (N2), the **Open estate** connection-row action (N1), and the pq2 route convergence. Depends on `loxep-pq2`. No new provider read. Left OPEN per instruction (it blocks later waves).
2. **`loxep-47o.2` — Wave 1a: Cloudflare estate. SHIPPED.** [3.1](#31-cloudflare--infrastructureestateconnectionid). Zones + per-zone records drill-in, cross-referenced against `managed_domains`/`dns_records`, adopt-into-intent mounting `ManagedDomainsService.addManualRecord` — the same write the drift panel's Adopt button already makes. Depends on `.1`. Left OPEN per instruction.
3. **`loxep-47o.3` — Wave 1b: Purelymail estate.** [3.2](#32-purelymail--infrastructureestateconnectionid). Domains + account-wide mailboxes + routing rules, account facts lazy in the header. Domain-sync/mailbox-sync write affordances mounted policy-blocked per [8.1](#81-purelymail-writes); mailbox/routing-rule row CRUD deferred to `loxep-47o.11`. Depends on `.1`.
4. **`loxep-47o.4` — Wave 2a: Dockhand estate (read-only). SHIPPED.** [3.4](#34-dockhand--infrastructureestateconnectionid). Environments overview, containers/stacks expand-only, adopt-as-hosting-target mounting the existing overview-card server function. Depends on `.1`. Left OPEN per instruction.
5. **`loxep-47o.5` — Wave 2b: Gatus estate. SHIPPED.** [3.7](#37-gatus--infrastructureestateconnectionid). Posture + health + endpoints, per-endpoint uptime drill-in, mandatory quarantine of `gatusPushQuarantinedKeys()`. Depends on `.1`. Left OPEN per instruction.
6. **`loxep-47o.6` — Wave 2c: Tailscale estate. SHIPPED.** [3.6](#36-tailscale--infrastructureestateconnectionid). Whole tailnet in one call, mounting the candidates panel's link/declare/ignore per row. Depends on `.1`. Left OPEN per instruction.
7. **`loxep-47o.7` — Wave 2d: Beszel + Termix estates. SHIPPED.** [3.5](#35-beszel--infrastructureestateconnectionid) and [3.8](#38-termix--infrastructureestateconnectionid). Two small pages; Beszel read-only + Attach, Termix Hosts read-only + Sessions instance-wide (per the owner's 5b ruling, [8.6](#86-instance-wide-termix-sessions-name-humans), superseding this bead's original hosts-only acceptance criterion). Depends on `.1`. Left OPEN per instruction.
8. **`loxep-47o.8` — Wave 3: Invoice Ninja estate.** [3.9](#39-invoice-ninja--financeestateconnectionid). `/finance/estate/$connectionId` — the first estate page outside `/infrastructure`, which is what proves P1's workspace parameter. Read-only. Depends on `.1`.
9. **`loxep-47o.9` — Commerce coverage candidates panel (P4, deferred).** The one real gap [section 4](#4-the-commerce-boundary) identifies, filed with its reasons so the ruling is not mistaken for an oversight. Depends on nothing; deliberately outside the waves.
10. **`loxep-47o.10` — Write-policy joining for Dockhand and Invoice Ninja.** [8.3](#83-dockhand-applyhost-is-write-capable-and-ungated), [8.4](#84-invoice-ninja-writes-are-ungated-too), [8.7](#87-the-write-policy-settings-description-is-now-stale). Independent of the estate pages; a prerequisite for any future write affordance on either. Blocks nothing in waves 2–3, because both pages ship read-only.

`.1` blocks `.2` through `.8`. `.2` and `.3` are wave 1 and should land before `.4`–`.7`. `.9` and `.10` are independent.

## 10. Related documents

- **[Implementation Contract](../../development/implementation-contract/)** — provider SDK shapes stop at the integration boundary; server functions are internal; state ownership.
- **[Frontend Standards](../../development/frontend-standards/)** — the DataTable path every estate section uses, and the semantic-token rule. This design adds no standards edit of its own; its rules live here.
- **[Fleet Observability Design (Phase 8)](../fleet-observability-design/)** — the link model, the health tiers, and the permanent no-metric-history line. [2.7](#27-jurisdiction-the-anti-soup-rule-versus-the-estate-pattern) states the anti-soup rule's jurisdiction relative to this page for the first time in the docs; the rule itself has lived only in `loxep-hb7` §3.2 and in code comments until now.
- **[Infrastructure Control Plane Design (Phase 7)](../infrastructure-control-design/)** — the Cloudflare and Purelymail adapters, the reconcile/drift model, and the intent tables the adopt verb writes.
- **[Pangolin Integration & Chain-Provisioning Templates](../pangolin-chain-design/)** — the write-risk model, the six binding rules, the self-lockout preflight, and the only "not worth building" section this repo had before this page.
- **[Domain Boundaries](../domain-boundaries/)** — cross-domain rule 13 and why Pangolin, Cloudflare, and Purelymail are control-plane providers rather than fleet companions.
- **[Workspaces & Navigation](../../product/workspaces/)** — the routing rule and the workspace map [section 5](#5-navigation) places estate pages within.
- **[Integrations Status](../../product/integrations-status/)** — the per-provider readiness matrix this page's [inventory](#1-ground-truth-the-full-adapter-inventory) is the read/write counterpart to.
</content>
</invoke>

---
title: Estate Browsers Design
---

This document designs the **estate browser** program (`loxep-47o`, owner ask 2026-08-16: *"the majority, if not all, of our integrations/connections should have this kind of estate browser… our app via the API links gives a wonderful place to easily tweak things, change settings, etc — no friction on our interface versus logging into tons of apps."*).

An **estate browser** is a per-connection page that renders a live read of everything one provider account actually contains, as that provider sees it, with the write affordances Loxep already owns mounted next to the rows they concern. The Pangolin estate browser (`loxep-pq2`, in flight) is the reference implementation; this page is the generalization extracted from it.

**Status: DESIGN. No code is authorized by this page.** [Section 9](#9-decomposition-into-child-beads) names the beads that ship it. Several affordances below are marked **OWNER-REVIEW-CRITICAL** — they require a credential-scope or write-policy grant the owner has not made; [section 8](#8-owner-review-critical) collects them in one place.

## 0. The one-paragraph shape

Every provider connection gets at most one page, addressed by connection id, never by provider name. The page makes a **fixed, small number of provider calls** — a constant independent of how large the estate is — and renders each response verbatim, each in its own section, each stamped with Loxep's own read clock. Nothing it reads is ever persisted: no table, no cache, no cadence, following the Dockhand containers panel precedent exactly. Row-level detail that would cost another call is fetched only when an operator expands that one row, and never when the overview already carries the answer. Every row that corresponds to a record Loxep owns says so and links to it — that cross-reference is what makes the page a pane of glass rather than a second copy of the provider's UI. Control appears **in context**: an action sits on the row it concerns, it is a write path that already exists and is already gated somewhere else, and no new provider-mutating path is ever born on an estate page.

## 1. Ground truth: the full adapter inventory

Read 2026-08-16 across all fourteen packages under `packages/integrations/`. "Read methods" counts exported adapter members that return provider facts, excluding `capabilities()`/`stats()` and pure helpers. "Write verbs" counts exported members that mutate provider state.

| Provider | Package | Read methods | Write verbs | Rate budget (capacity @ refill/s) | Write-policy status | Estate sections the reads support |
| --- | --- | --- | --- | --- | --- | --- |
| **Cloudflare** | `integration-cloudflare` | 4 — `listZones`, `findZoneByName`, `getZone`, `read` | 1 — `apply` (create/update/delete a record) | 8 @ 1 (docs ceiling 4/s, shared with the operator's own dashboard) | **GATED** — `assertWritePolicy` in `infrastructure/src/sync.ts:442`, tier 1, reason `write_policy`; UI-enforced | Zones (incl. zones with no `managed_domains` row); records per zone |
| **Purelymail** | `integration-purelymail` | 6 — `getOwnershipCode`, `listDomains`, `findDomainByName`, `listUsers`, `listRoutingRules`, `checkAccountCredit` | 6 — `addDomain`, `recheckDomainDns`, `createUser`, `deleteUser`, `createRoutingRule`, `deleteRoutingRule` | 6 @ 1 (provider publishes no limit; absence argued *down*) | **GATED** — `mail-sync.ts:384`, tier 1, reason `credential_scope`; UI-enforced | Account (credit, ownership code); domains; mailboxes (account-wide); routing rules |
| **Pangolin** | `integration-pangolin` | 11 — orgs, sites (+detail), resources (+detail), targets, rules, domains, domain DNS records, `probe` | 4 — `createResource`, `addTarget`, `createRule`, `updateRuleEnabled` (no DELETE anywhere, permanently) | 6 @ 1 | **GATED** — `proxy.ts` ×8 call sites, tiers 1 and 2, plus the `wouldLockOut` preflight; UI-enforced | Sites; resources (+ rules/targets drill-in); org domains |
| **Dockhand** | `integration-dockhand` | 5 — `probeSession`, `listHosts`, `listContainers`, `listStacks`, `readHosts` | 1 — `applyHost` (create/update an environment; **no delete member**) | 8 @ 2, login costs 4 | **UNGATED** — zero `assertWritePolicy` call sites in `container-hosts.ts`; only dry-run + admin-only. See [8.3](#83-dockhand-applyhost-is-write-capable-and-ungated) | Environments (instance-wide); containers and stacks per environment |
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

`loxep-pq2` predates this convention and its module doc names `/infrastructure/proxy/$connectionId`. Converging it is a small route rename with no server-function or component impact, filed as `loxep-47o.1`'s last step and a no-op if the sibling lands on the convention.

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

**Writes today.** All six write verbs are gated in `mail-sync.ts` at tier 1 with reason `credential_scope`. **None is mounted on the estate page in wave 1.** See [8.1](#81-purelymail-writes) — this is the sharpest owner-review flag in the program.

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

### 3.5 Beszel — `/infrastructure/estate/$connectionId`

**Sections.** (1) **Hub** — `health` (unauthenticated). (2) **Systems** — `listSystems`, hub-wide, paginated at 200/page with a 25-page ceiling; columns name, host, port, status verbatim, `updated`, cross-referenced against linked hosting targets. **Two calls.**

**Drill-ins.** None. There is no `getSystem`, and there must never be a metric read.

**Writes.** None, ever. `capabilities().readOnly` is the literal type `true`.

**Permanently read-only here.** No metric samples, no time series, no CPU chart — *"a milestone that ships a CPU chart has started rebuilding Beszel"*. No alert configuration; Beszel alerts must not route through Loxep, since Loxep may be running on the monitored machine. The estate page's verb is **attach** (the existing operator-confirmed picker), nothing more.

### 3.6 Tailscale — `/infrastructure/estate/$connectionId`

**Sections.** (1) **Tailnet** — `listDevices`, the whole tailnet in one unpaginated call; columns name, hostname, OS, online, lastSeen, authorized, addresses, cross-referenced against `resource_links` keyed on `nodeId`, plus the ignored-devices setting. **One call** — `probe` is the same read and is not repeated.

**Drill-ins.** None. No `getDevice` exists.

**Writes.** None against Tailscale, ever. The estate page mounts the tailnet candidates panel's existing **link / declare / ignore** verbs per row — all three Loxep-own writes.

**Permanently read-only here.** No ACL or policy-file content, no key management, no device authorize/remove, no route table, no per-device polling, no online history, and Loxep never pings a `100.64.0.0/10` address. A tailnet address must never write `hosting_targets.address_v4/v6` — those feed the DNS materializer, and a published CGNAT address is an outage that presents as a propagation problem.

**Note on scope.** A tailnet holds laptops and phones. The estate page shows all of them because that is what an estate page is; the *health* model deliberately does not, and that asymmetry is correct and must not be "fixed".

### 3.7 Gatus — `/infrastructure/estate/$connectionId`

**Sections.** (1) **Instance** — `probeConfig` (unauthenticated; recovers the three-way `open`/`basic`/`oidc` posture) and `health`. (2) **Endpoints** — `listEndpointStatuses` (explicit page/pageSize; `direct` posture only), columns key, group, name, success, httpStatus, `observedAt` (**Gatus's** clock, distinct from Loxep's `readAt`), errorCount, cross-referenced against linked hosting targets. **Three calls.**

**Drill-ins.** `endpointUptime(key, duration)` per endpoint — the one read that works in **every** auth posture, since the per-endpoint uptime route is permanently unauthenticated. This is what makes Gatus's estate page usable even on an OIDC instance where the bulk read is unwinnable.

**Writes.** None. Gatus configuration is files-only with a 30s poll and no API. A copyable static YAML snippet is permitted; a written file or a config editor never is.

**Permanently read-only here.** No response-time charts, no multi-bucket renders, no history routes, no badge proxying, no suites, no fleet-wide uptime percentage, no Loxep-run URL checks.

**Mandatory exclusion.** The endpoints named by `gatusPushSetting.endpointKey` and its five derived fact keys (`gatusPushQuarantinedKeys()`) are excluded from this page's endpoint list in every posture, whether or not the push is enabled — for the same self-latching-loop reason discovery excludes them. Loxep's own heartbeat belongs on the `GatusPushCard`, not in an inventory of things Loxep watches.

### 3.8 Termix — `/infrastructure/estate/$connectionId`

**Sections.** (1) **Hosts** — `listHosts` (internally two calls: `/hosts` + `/status`), instance-wide, cross-referenced against linked hosting targets. (2) **Sessions** — `listSessions`, instance-wide. **Two adapter calls**, three HTTP requests, plus a login costing 2 tokens.

**Drill-ins.** None.

**Writes.** None, ever. `TERMIX_FORBIDDEN_MEMBER_VERBS` is asserted against the exported surface by a boundary test that is a security control, not a style check: this credential is full-power against a surface that includes terminal exec, stored SSH credentials, and Guacamole, and Termix has no read-only role.

**Permanently read-only here.** No command execution, no terminal embedding, no proxied session, no file manager, no credential/snippet/tunnel management, and no UI that implies any of them at any tier.

**Gated.** The instance-wide sessions section is **OWNER-REVIEW-CRITICAL** — see [8.6](#86-instance-wide-termix-sessions-name-humans). Wave 2 ships the hosts section; sessions wait on the grant.

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

### Wave 0 — the shared shell (blocks everything)

Extract from `loxep-pq2` once it lands: the `/<workspace>/estate/$connectionId` route pattern, the provider→sections registry, the shared section primitives (clock-stamped header, the four honesty states, the budget-aware expander, the cross-reference column), the `/infrastructure/estate` index, and the **Open estate** connection-row action. Converge pq2's route to the convention. **No new provider read of any kind.**

### Wave 1 — the two the owner named (highest control value)

| Rank | Provider | Why first |
| --- | --- | --- |
| 1 | **Cloudflare** | DNS records are the thing he most wants to tweak. Write policy already wired and UI-enforced. Adopt-into-intent has a shipped precedent (the drift panel's Adopt). The unique fact it adds — zones and records Loxep has no `managed_domains` row for — is invisible today. |
| 2 | **Purelymail** | Users and routing are the second-named pain, and the account-wide shape is invisible outside the per-domain panel. Ships **read-only**: the credential is an unscopable full admin token, `createUser` is billable and non-idempotent, `deleteUser` destroys mail ([8.1](#81-purelymail-writes)). |

### Wave 2 — the view-mostly fleet estates (zero write risk, cheap)

Ranked within the wave by how often the owner would look at it:

| Rank | Provider | Unique value over what exists |
| --- | --- | --- |
| 3 | **Dockhand** | Containers and stacks **instance-wide**; today only per linked host. Two calls per environment, expand-only. |
| 4 | **Gatus** | All endpoints plus per-endpoint uptime; today counts only, and the uptime read works even in OIDC posture. |
| 5 | **Tailscale** | The **whole** tailnet including linked devices; today only the unlinked remainder. One call. |
| 6 | **Beszel** | Every system on the hub with its verbatim status. Two calls. |
| 7 | **Termix** | Hosts instance-wide. Sessions gated on [8.6](#86-instance-wide-termix-sessions-name-humans). |

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

The stored credential is a **fully-scoped admin token for the whole account**, and Purelymail has **no token scoping at all** — one token carries every operation including `deleteDomain`. Standing policy is *treat as read-only; any real interaction must target only `loxep.com` and be non-destructive*. On top of that, `createUser` is **billable and not idempotent** (no upsert exists), and `deleteUser` takes the mail with it.

**Recommendation:** the Purelymail estate page ships read-only. Mailbox creation stays on the existing `/infrastructure/domains/$name` intent path, which is already reconciler-driven, delegation-gated, and ledgered. **Decision needed:** whether *any* mailbox or routing-rule write may originate from an estate page, and if so which verbs by name.

### 8.2 Cloudflare record editing

The stored token is **full-account read-only**; the owner has offered to rescope it to write for `loxep.com` plus one dormant domain on request. An *edit this record* affordance on the estate page would be a new raw write path, which P10 forbids independently of the token.

**Recommendation:** adopt-into-intent only; declared records are edited on the domain page and applied through the reconciler, which already has the gate, the ledger, and the drift model. **Decision needed:** none for wave 1 — recorded so the rescope is not requested for a capability this design does not want.

### 8.3 Dockhand `applyHost` is write-capable and ungated

`packages/infrastructure/src/container-hosts.ts` contains **zero** `assertWritePolicy` call sites, unlike its Cloudflare and Purelymail siblings. Its guards today are the reconciler's `check`/`apply` dry-run split and an admin-only `declareIntent`. The write itself is narrow (it creates a row in Dockhand's own database; nothing executes on the target machine, which is the owner's 2026-08-13 carve-out) — but the asymmetry is undocumented and was found by this audit.

**Recommendation:** join the write-policy model per [1.2](#12-the-write-policy-model-and-what-joining-it-costs) before any Dockhand write affordance is mounted anywhere, estate page or not. Wave 2's Dockhand page is read-only regardless. **Decision needed:** join, or record why dry-run plus admin-only is sufficient for this verb specifically.

### 8.4 Invoice Ninja writes are ungated too

`pushDraftInvoice` guards only on a `resource_links` idempotency check; `createClient`/`createInvoice` reach the provider with no policy gate, and `invoiceninja` is absent from `WRITE_POLICY_ENFORCED_PROVIDERS`. Every write path in this package is source-verified but **never live-verified** — no write credential has existed in this environment.

**Recommendation:** the Invoice Ninja estate page mounts no write affordance in wave 3. Joining the write-policy model is a prerequisite for any future one. **Decision needed:** whether the existing push flow should retroactively join the model.

### 8.5 Pangolin's first live write has still never happened

`loxep-acj.9` is open: no Pangolin write verb of any tier has executed against the real instance, and the standing policy holds `prod-primary` at `read_only`. An estate page that renders Apply and Retire next to real resources makes an accidental first write materially easier.

**Recommendation:** every Pangolin write affordance renders policy-blocked with the `unblockHint` visible until `loxep-acj.9` closes — which is what the current tier already produces, so this is a rule that costs nothing to hold and something to break.

### 8.6 Instance-wide Termix sessions name humans

`TermixSessionFact.sharedByUsername` names a person. The owner approved **per-host** session rows on a trust basis (2026-08-15: *"the more info the better… this tool is meant to be used by people that trust one another"*). An **instance-wide** list of who is logged into what is a materially broader surveillance surface than the approval covered, and `loxep-wvm` §3.3(a) already flagged the general shape.

**Recommendation:** wave 2 ships the Termix hosts section only. **Decision needed:** an explicit grant for the instance-wide sessions section, or a permanent no.

### 8.7 The write-policy setting's description is now stale

`providerWritePolicySetting`'s description names *"Pangolin, Cloudflare, Purelymail as of milestone 3"*. If Dockhand or Invoice Ninja join per 8.3/8.4, that string and `WRITE_POLICY_ENFORCED_PROVIDERS` must be updated together — the audit found they are the only two places the provider set is written down, and they are hand-synchronized.

## 9. Decomposition into child beads

Filed under `loxep-47o`, dependency-ordered. Every child cites this page's rule numbers and is cold-executable from them.

1. **`loxep-47o.1` — Wave 0: the estate shell.** The `/<workspace>/estate/$connectionId` route pattern (P1, P2), the provider→sections registry, the shared section primitives implementing P3–P9 and P13–P15, the `/infrastructure/estate` index (N2), the **Open estate** connection-row action (N1), and the pq2 route convergence. Depends on `loxep-pq2`. No new provider read.
2. **`loxep-47o.2` — Wave 1a: Cloudflare estate.** [3.1](#31-cloudflare--infrastructureestateconnectionid). Zones + per-zone records drill-in, cross-referenced against `managed_domains`/`dns_records`, adopt-into-intent mounting the drift panel's existing Adopt server function. Depends on `.1`.
3. **`loxep-47o.3` — Wave 1b: Purelymail estate (read-only).** [3.2](#32-purelymail--infrastructureestateconnectionid). Domains + account-wide mailboxes + routing rules, account facts lazy in the header. No write affordance — [8.1](#81-purelymail-writes). Depends on `.1`.
4. **`loxep-47o.4` — Wave 2a: Dockhand estate (read-only).** [3.4](#34-dockhand--infrastructureestateconnectionid). Environments overview, containers/stacks expand-only, adopt-as-hosting-target mounting the existing overview-card server function. Depends on `.1`.
5. **`loxep-47o.5` — Wave 2b: Gatus estate.** [3.7](#37-gatus--infrastructureestateconnectionid). Posture + health + endpoints, per-endpoint uptime drill-in, mandatory quarantine of `gatusPushQuarantinedKeys()`. Depends on `.1`.
6. **`loxep-47o.6` — Wave 2c: Tailscale estate.** [3.6](#36-tailscale--infrastructureestateconnectionid). Whole tailnet in one call, mounting the candidates panel's link/declare/ignore per row. Depends on `.1`.
7. **`loxep-47o.7` — Wave 2d: Beszel + Termix estates.** [3.5](#35-beszel--infrastructureestateconnectionid) and [3.8](#38-termix--infrastructureestateconnectionid). Two small read-only pages; Termix hosts only, sessions gated on [8.6](#86-instance-wide-termix-sessions-name-humans). Depends on `.1`.
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

---
title: Weave Audit (2026-08)
---

This is a whole-system audit of how Loxep's shipped pieces interact, taken at the close of the August 2026 build waves, under the owner's standing mandate: *"consider everything that gets built (or already was) and how they interact and if providing those wires in our gui is worthwhile."* It is findings, not code — every claim below was verified against the working tree at audit time, with file paths so the next wave can start from evidence rather than re-discovery.

Method: the flipping loop (`/market` → `/inventory` → `/commerce` → `/finance`) was walked as an operator would walk it; every `/settings`-connectable service was traced from pasted credential to visible consequence; the dashboard's four bands were compared against the domains that shipped after them; and the notification pipeline was traced from event class to delivered message. Companion docs: [Roadmap](../roadmap/), [Workspaces & Navigation](../workspaces/), [Flipping Lifecycle Design](../../architecture/flipping-lifecycle-design/), [Fleet Observability Design](../../architecture/fleet-observability-design/).

## The one-paragraph verdict

The domain layer is far ahead of its own wiring. Two seams got dedicated bidirectional panels and work well (`/market` ↔ `/inventory` provenance, `/inventory` ↔ `/commerce` listings). Almost everything else that fails, fails the same two ways: **a server function returns the ids that would close the loop and the client throws them away in a toast**, or **a shipped, tested service has zero runtime callers**. The largest single instance of the second failure is the accounting posting engine — the flipping loop's entire money leg — followed by all five fleet read adapters. Neither gap is visible from inside the GUI, which is precisely why this audit exists.

## Findings, ranked

### 1. The ledger has no pump — the loop's money leg is absent

**Owner value: the product's core promise, "every dollar of it is attributable," silently fails at its final step; everything upstream of it works.**

`createPostingEngine` / `evaluateFacts` (`packages/accounting/src/posting-engine.ts`) has **zero callers outside its own tests**. `@loxep/app` does not depend on `@loxep/accounting`, no worker task posts facts, and no web action does either. The COGS rules are fully written and shipped (`posting-rules-template.ts` — `cogs_on_depletion`: DR cogs / CR inventory at the frozen basis) and nothing invokes them. Consequences, all confirmed live:

- "Record sale" on a manual listing (`/commerce/listings/$id`) writes real `orders` + `order_lines` and composes real reserve + deplete — then posts **nothing**. The sale is invisible on `/finance/overview`, in the trial balance, and in the dashboard's Financial band.
- Recorded expenses never reach `posted` — `apps/web/src/server/expense-functions.ts:60` says so in its own comment: *"only a (nonexistent) posting engine sets it."* The engine exists; the comment is honest about the wiring, wrong about the world.
- The Phase 5 design's promised *"visible backlog"* of facts that cannot post has no surface — nothing computes it, nothing renders it.
- There is no journal-entry surface anywhere (`journalEntries` appears in `apps/web` only inside two raw SQL strings in `dashboard-functions.ts`), and the trial balance (`book-trial-balance.tsx`) has no drill-down — so even after the pump is wired, posted entries would be visible only as aggregates.

Minimal wiring: an `accounting.post-facts` worker task (add `@loxep/accounting` to `@loxep/app`) sweeping unposted facts through `evaluateFacts`, plus a posting-backlog panel on `/finance/overview`. Tracked as **loxep-a-series bead (P1)** — see the bead list at the end.

**Status addendum (2026-08-13, loxep-6fm):** the `accounting.post-facts` worker task shipped (`packages/app/src/accounting-posting.ts`, registered in `registry.ts`, PROVISIONAL 5-minute cadence — the design names no trigger mechanics; see `financial-schema-design.md`'s new "Milestone 5 — the pump" section). `@loxep/app` now depends on `@loxep/accounting`; `expense-functions.ts:60`'s comment is corrected to reflect that the engine exists and runs, while explaining why `expenses.status` still never reaches `posted` by design. A real archived-book gap in `posting-engine.ts` was found and fixed in the process (an entity routed to a disabled book previously threw instead of backlogging). **Still open:** the posting-backlog panel on `/finance/overview` and the trial-balance drill-down (the rest of this finding's minimal wiring and its STRETCH item) are not part of this pass.

### 2. Four toasts discard the ids that close the flipping loop

**Owner value: the cheapest fix in this audit — four `onSuccess` handlers — closes most of the loop's navigational gap.**

Each of these server functions returns the created record's id, and each client handler drops it for a bare string:

| Action | Handler | What is discarded |
| --- | --- | --- |
| "I bought this" on a market item | `features/market/components/buy-this-dialog.tsx:86` — `toast.success('Recorded — check /inventory/stock')` | `acquisitionId`, `inventoryItemId`, both codes |
| "List this item" | `features/commerce/components/manual-listing-form.tsx:101` | the listing `id` (only `listingCode` is shown, as text) |
| "Record sale" | `features/commerce/components/record-sale-form.tsx:58` | `orderId`, `orderLineId`, and the `oversell` flag survives only as a transient toast |
| "Confirm as expense" | `features/documents/components/document-review-panel.tsx:105` | every id in `expenseIds` |

The pattern that works is already in the codebase twice: `PartOutDialog` navigates to the created record, and `WeBoughtOnePanel` renders the reverse link. These four should do one or the other.

### 3. Expenses confirmed from an uploaded receipt land in "Missing receipts"

**Owner value: a functional bug that makes the evidence-tracking report accuse exactly the expenses that have evidence.**

`confirmLinesAsExpense` (`apps/web/src/server/documents-functions.ts:488`) creates the expense and stamps the candidate — but writes **no `media_links` row** attaching the receipt image to the expense. `ReceiptsService.missingReceipts` (`packages/accounting/src/receipts.ts:190`) is precisely a `not exists` over `media_links`, so every expense confirmed from a photographed receipt immediately appears in the "Missing receipts" card on `/finance/overview` while its image sits one table away on the `documents` row. Related, same seam: nothing renders `CandidateDto.targetKind/targetId` (the confirmed-expense link is in the row data, unrendered), nothing links an expense back to its source document, and the document review panel is `useState`-driven rather than a route — no URL, and browser Back exits the review.

### 4. Fleet credentials do nothing visible — and the connectable/adapter split is inverted

**Owner value: every credential the owner pastes today buys a permanently-`unknown` health row; the five shipped adapters (verified against real upstreams) deliver nothing.**

No fleet adapter factory (`createTailscaleAdapter`, `createTermixAdapter`, `createGatusAdapter`, `createBeszelAdapter`, `createDockhandAdapter`) is ever constructed in production code. The current state, per provider:

| Provider | Connectable in `/settings`? | Adapter consumed at runtime? | What a pasted credential does |
| --- | --- | --- | --- |
| Tailscale | yes | no | connection row; health `unknown (never_succeeded)` forever — nothing ever writes `last_success_at` |
| Termix | yes | no | same |
| Gatus (read) | yes | no | same (the *outbound push* is separate, configured on `/settings/application`, and works) |
| Beszel | **no** — no catalog entry, no form | no | cannot be pasted at all |
| Dockhand | **no** | type-level only (`packages/app/src/fleet.ts`) | cannot be pasted; `planContainerHostOperations` has no non-test caller |

This is the exact inverse of the [fleet design's](../../architecture/fleet-observability-design/) surface table, which promised catalog cards for tier-3 tools and Gatus/Beszel accounts. The health sweep's `connection` probe is generic and network-free, `/infrastructure` reads `integration_health` nowhere, and the fleet detail page (`routes/infrastructure/fleet/$name.tsx`) shows companion links and minted tokens but **zero reachability/status/age evidence** from any adapter.

**Is the fleet-evidence wire worth a GUI panel? Yes — narrowly.** The minimal day-one wiring that makes each credential *do* something:

1. Provider-specific health probes in the sweep that call each adapter's cheapest read (`probe()` / `health()` / `probeConfig()`) — this alone turns the permanent `unknown` into a real, aging status on `/settings/overview` and the dashboard ops band.
2. Beszel/Dockhand catalog entries + guided forms (the adapters, bundles, and credential purposes all exist; `fleet.ts` names the constants).
3. A fleet-detail evidence panel showing each linked tool's latest status, **provenance, and age** — the design's own rule: a status with no visible age is over-trusted.

**On `hosting_target` ↔ adapter identity:** the join holds for exactly one provider. Dockhand's `DockhandHostFact.name` is non-nullable and `hosting_targets.name` is unique — `planContainerHostOperations` already joins on it. Tailscale (`name`/`hostname`/`addresses`), Termix (`name`/`ip`, field names UNVERIFIED), Beszel (`name`/`host`, UNVERIFIED), and Gatus (whose `key` names a *monitor*, not a host) do **not** carry a reliably joinable host identity. The right answer is the design's own: a link-mediated join through `external_resources`/`resource_links` (the planned vocabulary — `beszel/system`, `gatus/endpoint`, `tailscale/device`, `termix/host` against `hosting_target`) with the operator making the match once in the GUI. Do not build fuzzy name matching.

**Status (2026-08-13, `loxep-rf4`): CLOSED for the minimal wiring this finding asked for.** All three numbered items shipped: a fleet-aware `connection` health-subject registry (`createFleetHealthSubjectRegistry`, `packages/app/src/fleet-health.ts`) dispatches each of the five fleet providers to its own credential-proving adapter probe every `health.sweep` cycle and is now the sole writer of `connections.last_success_at`/`last_error_at` for providers with no poll executor — the permanent `unknown (never_succeeded)` row this finding described no longer happens. Beszel and Dockhand gained catalog entries and guided login forms, closing the inverted half of the table above. Migration `0021` also shipped the `external_resources` idempotency fix this finding's identity discussion assumed as a prerequisite. **What did not ship, and remains exactly this finding's item 3:** the fleet-detail evidence panel and the `resource_links`-mediated per-resource identity join (one row per Beszel system / Dockhand host / Gatus endpoint / Tailscale device / Termix host) — that is design-complete (`loxep-y64`/`loxep-hb7`/`loxep-1au`/`loxep-50t`/`loxep-wvm`) but unbuilt, and Dockhand's host-registration write leg is unbuilt with it. Connection-level health is real; per-resource fleet observability is still a later slice.

### 5. Notifications are schema-bound to market events — every new event class is un-notifiable

**Owner value: the owner's stated day-one loop for each domain ("tell me when something needs me") cannot be configured for anything shipped since Phase 2.**

`notification_deliveries.market_event_id` is `NOT NULL` with an FK to `market_events` (`packages/db/src/schema/notifications.ts:167`), so a delivery row structurally cannot exist for anything else. The gap table, condensed — detection exists, notification does not, for every one of these:

| Event class | Where the state change lands | Notifiable? |
| --- | --- | --- |
| Purchase ingested (draft acquisition) | `acquisitions.status = 'draft'` | no |
| Document awaiting confirmation | `documents.status` | no |
| Manual sale recorded / listing sold | `orders` row | no |
| DNS drift found / disappeared | `dns_drift_findings` — `recordRun` computes new/`disappeared` transitions **inside one transaction and discards them** | no |
| Integration health degraded | transition now **detectable** (`integration_health.previous_status`/`status_changed_at`, migration `0020`) — still not notifiable, nothing consumes the transition yet | no |
| Mail reconciler failure, monitor backoff, connection/token errors | `reconcile_runs`, `monitor_targets`, `connections.last_error_*` | no |

Etsy and Reverb are the counter-example: both poll executors call the same `enqueueDeliveriesForEvent` bridge and are fully covered. Two small adjacent facts: `new_listing` has no case in `render.ts` (falls to the generic ISO-timestamp fallback — the one discovery event an operator most wants enriched), and an opportunity rule's name/score never reaches the message. This finding needs a small design decision (nullable `market_event_id` + subject columns, or a general `app_events` table) before code — and the health-transition half needed the sweep to compare before overwriting, which was cheap now and impossible to backfill later.

**Status (2026-08-15, loxep-oii — CLOSED):** both halves shipped. The cheap, non-backfillable half landed first: `integration_health` gained nullable `previous_status`/`status_changed_at` (migration `0020`), and `upsertHealth` records them exactly when the incoming status differs from the stored one. The rest landed with [ADR-0023](../../decisions/0023-notifiable-events-and-delivery-subjects/) and migration `0022` — a subject-neutral `notification_events` ledger that `market_events` feeds into, with `notification_deliveries.market_event_id` replaced by `notification_event_id` (existing market deliveries preserved by backfill) and `notification_rules` gaining a `NOT NULL event_class` beside the renamed `event_type`. Wired classes: `market` (unchanged bridge), `health` (transitions out of `runHealthSweep`, Loxep's own integration subjects only — fleet subjects stay excluded by registry, so the fleet design's "no fleet probe writes a `notification_deliveries` row" rule now holds by construction), `purchase` (`ingestEbayPurchase`), `document` (`confirmLinesAsExpense`), and `sale` (both `recordManualSale` copies). `render.ts` gained the missing `new_listing` case and now surfaces the attributing opportunity rule's name and score. The product-shell bell is back on product surfaces, reading the real ledger through the same pure renderer as the outbound push — data source replaced, `mockNotifications` left inside `/starter` exactly as `loxep-67w` required. **Closed 2026-08-15 (`loxep-50t` slice C):** the `infrastructure` class is wired too. `@loxep/infrastructure`'s `drift.ts` (`recordRun`) emits `drift_found`/`drift_disappeared` per NEW/self-resolved finding (never per re-observation), and `sync.ts` emits `reconcile_run_failed` from the one `finish` helper both its failure paths funnel through — both default their enqueue seam so every existing composition root gets real routing+delivery with no `@loxep/app` change. Nothing in this class's subject set (`managed_domain`, `reconcile_run`, `hosting_target`) is a fleet probe subject, so the fleet design's "no fleet probe writes a `notification_deliveries` row" rule is unaffected — DNS drift and reconcile runs are Loxep's own domain facts, not a companion tool's opinion.

### 6. The dashboard predates six of the domains it should summarize

**Owner value: the product home answers "how is my operation doing" for the operation as of 58 commits ago.**

`dashboard-functions.ts` has exactly two commits: creation, and the integration-health read. Absent: draft acquisitions awaiting intake (there is even a purpose-built partial index on `documents.status` the dashboard never uses), documents awaiting confirmation, channel listings / a listed-sold funnel (manual sales appear in the Money band *by accident*, unlabeled, because they write real `orders` rows), DNS drift, fleet/hosting targets, and reconcile runs. Two honesty bugs inside the ops band:

- The monitor-fleet tile counts `ebay_purchases` and `infrastructure_domain_reconcile` targets as market monitors (`ORDER_SYNC_TARGET_TYPES` excludes only `woo_orders`/`ebay_orders`), so a stuck DNS reconcile renders as a market-monitor error.
- The `integration_health` read filters to `subject_type = 'connection'` and counts only `failing` — `degraded` and `unknown` are silently discarded.

### 7. Orders have aggregates but no rows

**Owner value: order ingestion is connectable in `/settings` and its output is invisible — a dead-end wire on the loop's most important fact.**

There is no `/commerce/orders` route and no nav entry. Woo/eBay order sync writes `orders`, `order_lines`, fees, refunds, and fulfillments that surface *only* as Money-band aggregates; a manually recorded sale's order exists only as an unlinked row inside one listing's Sales panel. `order_lines.marketplace_item_id` and `channel_listings.marketplace_item_id` (listing/line → market provenance) are in the schema and rendered nowhere.

### 8. Smaller weave gaps, one list

Each is real, none is urgent alone; together they are the texture of the loop's friction:

- `InventoryMovementDto` drops every provenance FK the table carries (`order_line_id`, `acquisition_id`, `inventory_allocation_id`, …) — a `depletion_sale` movement is a dead end in the GUI.
- Expense → acquisition is one-way: `ExpenseDetail` renders the `acquisitionCostId` FK as **prose in an Alert** (naming the column in a `<code>` tag) instead of a link; and no GUI can *create* the link — `addAcquisitionCost` has zero callers, so the acquisition "Linked expenses" card is populatable only by SQL.
- Imported acquisitions: the `Imported` badge is not a link to the connection, `fetchAcquisitions` has no `connectionId` filter, and enabling purchase sync in `/settings` never says where purchases land. The retained `provider_objects` purchase provenance (`ebay.purchase`) is unreachable from any screen.
- `/inventory` and `/commerce` overview cards are non-clickable dead counts while `/market`'s and the dashboard's link out — inconsistent within one loop.
- The document review panel offers "Acquisition cost" / "Inventory intake" dispositions that `CONFIRMABLE_DISPOSITIONS` cannot confirm — a visible dead-end control (known M4 gap; the control should say so or not be offered).
- Acquisition detail's empty state points at "the intake review queue" while the actual "Add item to this lot" button is in the same page's header.
- Catalog table renders `sku` as plain text even though it *is* an inventory item code by construction (the SKU join convention itself is fine — PROVISIONAL per the design — but the GUI should exploit it).

### 9. Documentation truth drift

**Owner value: the docs are the product spec; two now state the opposite of what shipped.**

- `flipping-lifecycle-design.md:19` still says "M6 — listings — remains DESIGN ONLY" while the same file's line 1023 records M6 as shipped (migration 0019). Internal contradiction.
- `roadmap.md:283` still says "a manual listing cannot yet record its sale" — it can, since loxep-dgf.6.
- The fleet design's surface table promises the inverse of the shipped connectable/adapter split (finding 4).

### 10. Over-built or duplicated — simplify rather than extend

- **The product shell's notification bell is starter mock data.** `features/notifications/utils/store.ts` seeds "Sarah Connor has joined the Engineering workspace" into a zustand store rendered by the real header (`components/layout/header.tsx:29`) with action routes into `/starter/*`. In a product that has a real notification pipeline, a fake bell in the shell is actively misleading. Hide it from product surfaces until it reads something real. *(Status: CLOSED 2026-08-14 as `loxep-67w`. The bell is hidden on every product surface through the existing `getWorkspaceForPath` workspace signal — only the `starter` id shows it, so a new workspace is hidden by default. Hidden rather than deleted, because the feature is preserved donor code and mock data inside `/starter` is honest there. It returns when `loxep-oii` lands a real feed, and re-enabling must replace the data source rather than restore `mockNotifications`. **Returned 2026-08-15 with `loxep-oii`:** the product shell now renders a `NotificationBell` over the real `notification_events` ledger, rendered by the same pure renderer as the outbound ntfy message; the donor `NotificationCenter` and `mockNotifications` are untouched and still show only inside `/starter`.)*
- Two receipt-upload paths that never meet (`api.expenses.receipt.ts` → `media_links` vs `api.documents.upload.ts` → `documents`): keep both entry points, but finding 3's fix should make the documents path *end* in the same `media_links` attachment the direct path uses.
- `recordManualSale`, `formatListingCode`, `findOrCreateCatalogItemBySku`, and `hasEbayUserConsent` each exist twice (web-layer re-declarations for missing dependency edges, acknowledged in comments). Fine as a deliberate pattern; worth collapsing when the dependency edges get added anyway (e.g. when finding 1 adds `@loxep/accounting` to the worker).
- Two near-identical "Sourced from /market" cards (`acquisition-detail.tsx`, `item-detail.tsx`) that differ only because one server path forgets to resolve the item title (`marketplaceItemTitle` hardcoded `null` at `inventory-functions.ts:1172`).
- Health has three partial homes (settings report, dashboard ops band, and `/infrastructure` which reads none of it). One canonical full table (settings), one rollup (dashboard), and `/infrastructure` reading the same rows for its fleet subjects — not a fourth model.

## Recommended next wave

Ordered by owner value per unit of effort:

1. **Wire the posting engine** — `accounting.post-facts` worker task + on-write posting from the web actions that create facts, a posting-backlog panel on `/finance/overview`, and (stretch) trial-balance drill-down to journal lines.
2. **Close the four toast seams** and fix the receipt-attachment bug (findings 2 and 3) — the cheapest visible-quality win in the audit.
3. **Fleet minimal wiring** — *(shipped 2026-08-13 as `loxep-rf4`, see finding 4's status note: adapter-backed health probes for all five fleet connections, plus Beszel/Dockhand catalog entries.)* Still open: the fleet-detail evidence panel with status/provenance/age over a `resource_links`-mediated identity join.
4. **Dashboard refresh** — intake-drafts and documents-review tiles, a listed/sold read, drift/fleet in the ops band, and the two ops-band honesty fixes. *(shipped 2026-08-14 as `loxep-9m2`. Both honesty bugs are closed: the market-monitor fleet is now derived by owning-domain membership through a `satisfies Record<MonitorTargetType, …>` map — so `ebay_purchases` and `infrastructure_domain_reconcile` stop being counted as monitors, and a new target type breaks the typecheck rather than being silently miscounted — and all four health statuses are counted distinctly instead of only `failing`. The bands gained the listing funnel, the manual-sale label, infrastructure counts, fleet-signal chips, and the two upstream-of-ledger backlogs.)*
5. **Notification generalization** — the small schema/design decision that unblocks every non-market event class, plus health-transition detection in the sweep (cheap now, impossible to backfill).
6. **An orders surface** in `/commerce`.
7. **Docs truth pass** for the three drifted statements.

## Not worth wiring

Flagged so the next wave does not build them by default:

- **Termix active-sessions GUI panel** — correction: this line overstated the case when it was first written. Two of Termix's three reads (`GET /host/db/host`, `GET /status`) are genuinely UNVERIFIED — no schema anywhere in the spec. The third, `GET /open-tabs/active-sessions`, is fully specified in the generated `openapi.json` (`Termix-SSH/Docs`, regenerated 2026-08-06); the "UNVERIFIED" label never applied to it. The practical conclusion still stands, for a different and better reason: a generated spec is not a live instance, and this same doc repo has already proven drift-prone — its per-operation `.mdx` pages still show the path as `/ssh/db/host` while the current `openapi.json` has it at `/host/db/host` (see [Fleet Observability Design](../../architecture/fleet-observability-design/#tailscale-and-termix-in-detail--amended-2026-08-13)). The deep link is the right surface until a live probe confirms the shape, not because the shape is undocumented.
- **Netdata / Cockpit / Uptime-Kuma adapters** — the design's tier verdicts stand; link-and-probe only.
- **Gatus `suites` routes** — not until the `endpoints` reads prove insufficient.
- **Iframe embedding of any fleet tool** — upstream blocks or disclaims it in every case examined.
- **Fuzzy host-name matching** between adapters and `hosting_targets` — the link-mediated join is strictly better and already designed.
- **A per-severity/per-provider notification-rules matrix** — extend the existing two-column rule model (event class × subject), not a rules engine.
- **A documents browser workspace** — attachments belong in owning workflows ([Workspaces](../workspaces/#documents-and-media) already says so); finding 3's links deliver the value.
- **Metric series anywhere in `/infrastructure`** — the latest-observed-status rule is the phase's falsifiable boundary; keep it.
- **`marketEventId` surfaced on acquisition links** — the item-level provenance link carries the value; the event id adds a hop nobody asked for.

## Beads

Filed from this audit (unfiled findings only): `loxep-6fm` posting-engine wiring (P1), `loxep-0l5` toast-seam closure (P2), `loxep-4mg` receipt-attachment bug (P2), `loxep-rf4` fleet credential wiring (P2), `loxep-9m2` dashboard refresh (P2), `loxep-oii` notification generalization (P2), `loxep-i51` orders surface (P3), `loxep-zxj` docs truth pass (P3), `loxep-1zg` small-seam rollup (P3), `loxep-67w` shell notification bell (P4). Refined in place: `loxep-ovj.3` (companion-links panel scope, post-lmy.3), `loxep-ovj.5` (adapter half shipped; catalog/probe half remains), `loxep-ovj.6` (narrowed to genuinely link-only tools; Dockhand's connect path moved to `loxep-rf4`).

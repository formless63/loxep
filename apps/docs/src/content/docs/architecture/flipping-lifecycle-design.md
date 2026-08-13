---
title: Flipping Lifecycle Design (Phase 9)
---

This document is the design for Loxep's **core operator loop** — the path a reseller actually walks: money goes out, goods come in, goods get described, goods get listed, goods sell, and every dollar of it is attributable. It stands in the same relationship to that loop that [Commerce Schema Design](../commerce-schema-design/) stands in to Phase 3 and [Inventory & Acquisition Schema Design](../inventory-schema-design/) stands in to Phase 4.

It differs from those documents in one important way, and the difference sets the whole shape of the work.

**Implementation status: M1 of this design is implemented.** The `/finance` workspace (`apps/web/src/config/workspaces.ts`, `apps/web/src/config/navigation/finance.ts`, `apps/web/src/routes/finance*`, `apps/web/src/features/finance/`) now exists: an expenses list and detail, one-screen quick entry (writing `status: 'recorded'` in one action, with `draft` reachable via "Save as draft"), void-and-re-record (never edit-in-place), receipt upload/gallery over `media_links`, and the missing-receipt/unallocated-expense reports on `/finance/overview` — all over `@loxep/accounting`'s `createExpensesService`/`createReceiptsService`/`createExpenseReports`, which shipped complete with zero callers before this milestone. **No migration was required**, exactly as [M1](#milestones) predicted.

**M2 is UI-complete but its writes are blocked, and that is worth stating plainly.** The `/inventory` workspace (`apps/web/src/config/navigation/inventory.ts`, `apps/web/src/routes/inventory*`, `apps/web/src/features/inventory/`) now exists: a filterable stock list and item detail (state, location, cost basis, movements timeline, live `availableToSell`), locations, an acquisitions list and lot detail (cost components, landed cost by currency with `nonCapitalizedAmount` shown separately, a basis picker), a movements ledger, and the `/market` handoff — "I bought this" on `/market/items/$itemId`, prefilled from the watched item, plus a "we bought one" panel showing the reverse link. Every READ on these surfaces (`apps/web/src/server/inventory-functions.ts`) is a genuine, working query straight against `@loxep/db`'s shipped `inventory_items`/`acquisitions`/`acquisition_costs`/`inventory_movements`/`inventory_locations`/`acquisition_opportunity_links` tables — no business logic duplicated, only flat/joined selects (the one grouped aggregate mirrors `@loxep/inventory/acquisitions.ts`'s own `landedCost` query verbatim). But `apps/web/package.json` does not list `@loxep/inventory` as a dependency, unlike `@loxep/accounting` for M1, so every WRITE that needs the package's business logic — item creation (code generation, movement recording), acquisition creation (reference codes, attribution), cost allocation (the largest-remainder engine), and the "I bought this" three-call transaction (acquisition → item → `sourced_from` link) — is validated for real and then throws a descriptive error naming the exact one-line fix, rather than either duplicating that logic in `apps/web` or silently no-opping. `acquisition_opportunity_links` needed no migration: it shipped with Phase 4, exactly as the design below predicted, and the read side of the `/market` handoff (the reverse "we bought one" wire) works today because it needs only that shipped table, not the package.

**M3 is implemented.** Migration `0015_inventory_enrichment.sql` ships exactly the section 3 schema and nothing else: `inventory_items` gains its six nullable/defaulted columns (`description`, `sale_mode` + `CHECK` + `unit` default, `package_weight_grams`, `package_{length,width,height}_mm` + the `package_weight_check`/`package_dimensions_check` `CHECK`s), and `inventory_item_specifics` is new (`unique(inventory_item_id, name, value)`, `index(name, value)`, the `source` `CHECK`). No DDL for images — `media_links` (migration 0004) already covers `resource_type = 'inventory_item'`; `INVENTORY_ITEM_MEDIA_RESOURCE_TYPE`/`INVENTORY_ITEM_MEDIA_PURPOSES` (`packages/db/src/schema/inventory.ts`) are application text, not schema. `@loxep/inventory` gains `ItemsService.update()` (the descriptive fields), `.setSaleMode()` (the declaration, structurally refusing `'parted_out'` as an input), and `.partOut()` (the one new verb: N children with `origin_item_id`, basis divided by `distributeByWeights`, the parent depleted through the movement writer with `movement_kind: 'consumption'` and marked `parted_out`) in `items.ts`; a new `specifics.ts` (`SpecificsService.set/list/remove`, the single writer of `value_numeric` alongside `value`); and a new `media.ts` (`InventoryMediaService.attach/list/detach/reorder`, writing `media_links` directly — see that module's doc for why it does not route through `@loxep/storage`'s `MediaService`, given `@loxep/inventory` takes no dependency on `@loxep/storage`). The web layer adds the item-image upload/serve pair (`routes/api.inventory.image.ts`, `routes/api.media.inventory.$mediaId.ts`, `server/inventory-media.ts`) mirroring the avatar/receipt precedent with its own `metadata.purpose === 'item_image'` gate and a registered `inventory.media_limits` setting (size cap + MIME allowlist) rather than a hardcoded constant, plus the item-detail enrichment panel, specifics editor, and photo gallery (`features/inventory/components/{item-enrichment-panel,dimensions-fields,specifics-editor,image-gallery,part-out-dialog}.tsx`).

**M4 is implemented for its manual-assisted scope (loxep-dgf.4); OQ3 was resolved manual-assisted-only, per this document's own recommendation.** Migration `0017_documents.sql` ships exactly the section 2b schema: `documents` and `document_line_candidates`, with the `documents_source_kind_media_object_check` kind/reference `CHECK` and `document_line_candidates`'s stamp-not-FK `target_kind`/`target_id` pair, unchanged from the design below. The new `@loxep/documents` package ships the `ReceiptParser` interface, the pluggable `createParserRegistry`, the one registered backend (`manualParser` — zero automatic lines, by design), CSV parsing/column-mapping/fingerprinting (`csv.ts`), and `createDocumentsService`/`createCandidatesService` (line CRUD, disposition, `stampConfirmed`) — 64 tests against real PostgreSQL, including the never-auto-commit proof written first, per this document's "before implementing" instruction. **`@loxep/documents` depends on neither `@loxep/accounting` nor `@loxep/inventory`, exactly as [Package ownership](#package-ownership) requires**, which has one real consequence at the web layer: `apps/web/package.json` does not declare `@loxep/documents` either (a package.json edit was outside this milestone's write fence), so `apps/web/src/server/documents-functions.ts`/`documents-media.ts` RE-IMPLEMENT the same `documents`/`document_line_candidates` operations directly over `@loxep/db` — the same "no dependency edge, re-declare the small surface" choice `order-sync-functions.ts` already documents for `@loxep/commerce`. `confirmLinesAsExpense` is the one function that writes a domain table, and it does so by constructing `@loxep/accounting`'s `createExpensesService` bound to its OWN transaction (apps/web already depends on `@loxep/accounting`) — the domain write and the candidate stamp commit or roll back together, with `session.user.id` as the required actor. The `/finance/import` route (`apps/web/src/routes/finance/import.tsx`, `apps/web/src/features/documents/`) covers CSV upload → operator column mapping (best-guess pre-filled) → dry-run preview with a duplicate-fingerprint WARNING → staged review → confirm; a receipt/invoice photo uploads through `routes/api.documents.upload.ts` and is transcribed by hand (no OCR ships) on the same review panel. **Two pieces are explicitly NOT shipped, flagged rather than silently skipped:** confirming a candidate into `acquisition_cost`/`inventory_intake` (the disposition is offered and stages correctly; the confirm ACTION needs an acquisition-lot picker this milestone does not build — `CONFIRMABLE_DISPOSITIONS`/`CONFIRMABLE_AS_EXPENSE` name the gap in both the client and server code); and the design's suggested `routes/inventory/intake.tsx` path for the review queue, which collides with M3's already-shipped "Intake review" nav entry (a redirect to `/inventory/stock?status=intake`) — the review queue lives at `/finance/import` instead, and `Workspaces`' "Intake review lives in `/inventory`" sentence describes that unrelated, already-shipped stock-status filter, not this milestone's candidate queue.

**M5 is implemented mapper-and-service-only, live-unverified (loxep-dgf.5)** — see [2a's own implementation-status subsection](#implementation-status-loxep-dgf5) for the full account: the `WonList` mapper and `createPurchaseIngestionService` ship and are fixture-tested, but no `@loxep/app` poll executor and no `acquisitions_connection_external_ref_uq` migration exist yet, both flagged there rather than silently skipped. `@loxep/documents`' candidate queue postdated M5's landing, so an ingested purchase's reviewable unit today is the `draft` acquisition itself, not a per-line candidate — nothing about M4 requires M5 to change.

`M6` — listings — remains DESIGN ONLY: no migration, Drizzle schema, service, route, or component beyond M1's through M5's is authorized by this page. Every column type, constraint, and provider call named below for M6 must still be re-verified against current PostgreSQL/Drizzle/provider behavior immediately before implementation, per the [dependency policy](../../development/dependency-policy/).

## The finding that reframes this phase

Phases 3, 4, 5, and 6 shipped **headless**.

```text
phase  domain schema   domain services   worker wiring   product UI
-----  -------------   ---------------   -------------   ----------
3      shipped         shipped           shipped         none
4      shipped         shipped           NONE            none
5      shipped         shipped           partial         none
6      partial         partial           none            none
```

`apps/web/src/config/workspaces.ts` lists four workspaces: `dashboard`, `market`, `settings`, `starter`. There is no `/inventory`, no `/commerce`, no `/finance`. `packages/inventory` — nine tables, eleven service modules, 125 tests against real PostgreSQL — has **zero runtime consumers**: no package depends on it, no `@loxep/app` task routes to it, no route calls it. `packages/commerce`'s `createCatalogService` has no caller outside its own test file, so `channel_listings` is fully constrained and never written. `packages/accounting`'s `createExpensesService` and `createReceiptsService` have no caller either.

So this phase is **not mostly schema**. It is roughly:

```text
~70%   the first product surfaces over domain services that already exist and are tested
~20%   additive schema: enrichment columns, two listing ALTERs, one new domain's two tables
~10%   one new provider ingestion path
```

That proportion is the single most useful thing to know before planning the work, and it is why the first milestone below is genuinely implementable in one session: it writes no migration at all.

It also means this design is unusually cheap to get wrong and cheap to correct. Service signatures in an unwired package can change freely; only migrations are expensive. Where this document proposes a migration, it argues for it specifically.

## Scope

Four asks, designed as one lifecycle:

1. **Expense capture always** — every dollar that leaves, captured, whatever its shape: quick entry, file import, and the seam that fires when the money was spent on goods rather than on the business.
2. **Acquisition import** — purchases arriving from a connector (eBay buy side) and purchases arriving as a photographed receipt, both landing as acquisitions and inventory intake through one human-confirmed review path.
3. **Inventory enrichment** — images, how-it's-sold, dimensions and weight, description, and typed product specifics on the stock row, so that a physical thing carries everything a listing needs.
4. **Listings** — offline/local listings (Facebook Marketplace, Craigslist, in person) as first-class `channel_listings`, and the declared bridge to Loxep-managed listing authoring.

Plus the owner's explicit fifth mandate, [The weave](#the-weave), which is not a fifth feature but the map of how the other four meet.

The domains involved are **Costs and Expenses**, **Inventory and Acquisition**, **Catalog and Listings**, **Documents**, and **Integrations**, which remain distinct ownership boundaries per [Domain Boundaries](../domain-boundaries/) even though they land in one phase and meet in three workspaces. Workspace UX is not domain ownership.

This is the first phase to give the **Documents** domain a table. It has been defined in [Domain Boundaries](../domain-boundaries/#documents) since the foundation and has never been implemented.

## What this design does not create

```text
manual ORDERS (a sale with no connection)      flagged, not built — see OQ7, OWNER-REVIEW-CRITICAL
COGS posting from inventory depletion          SHIPPED SINCE, in Phase 5's milestone 4 — the
                                               acquisition_cost / inventory_movement readers
                                               exist; see the acquisition-seam gap below
bank/OFX/QFX statement import                  Phase 5 — bank_transactions is a settlement fact,
                                               not an expense; see the import decision below
vendors, purchase orders, AP, vendor bills     still an explicit Phase 4 non-goal; acquisitions
                                               keep a denormalized vendor_name
OCR or LLM parser BACKENDS                     interface only; manual-assisted is the only backend
per-provider listing PUBLISH flows             each integration's own later milestone
a Loxep-owned category/aspect taxonomy         fetched from the channel at authoring time, never
                                               mirrored — see the specifics design
carrier integration / label purchase           unchanged non-goal; shipments still record what an
                                               operator entered
inventory valuation / revaluation              Phase 5, unchanged. Cost basis is not valuation
consignment settlement and consignor accounts  Phase 6 — a consignor is a counterparty
a documents browser/search workspace           attachments appear in owning workflows; a browser
                                               earns its place from usage, per Workspaces
per-entity or per-item ACLs                    still none (ADR-0017); membership stays
                                               installation-wide
dashboard composition changes                  deliberate; see the weave's dashboard answer
```

Two of these deserve emphasis because they are the most likely to be smuggled in.

- **Money spent on goods is not an expense.** It is an `acquisition_costs` row that becomes cost basis and reaches the ledger as COGS at depletion. Recording it as both would report the same dollar twice — once as an expense at purchase and once as cost of goods at sale. The whole of [The acquisition seam](#the-acquisition-seam-when-an-expense-is-really-a-purchase) exists to make that rule operable rather than merely stated.
- **A parse is never a fact.** No parser output may become an `expenses`, `acquisitions`, or `inventory_items` row without a human confirming it. This is structural, not a convention: the confirm functions require an actor user id and a parse job has none.

## Conventions inherited

Nothing below invents a convention. From the [Foundational Data Model](../foundational-data-model/), the [Implementation Contract](../../development/implementation-contract/), [Frontend Standards](../../development/frontend-standards/), and the three phase designs this one extends:

- UUID primary keys with `defaultRandom()`; provider identifiers stay text and never become Loxep keys;
- instants are `timestamptz` with semantic names; money is `numeric(20,6)` plus an ISO currency code; quantities are `numeric(20,6)`;
- state columns are `text` with application-owned TypeScript unions; `CHECK` only for genuinely closed Loxep-owned sets;
- no `payload` or free-form attribute `jsonb` on any domain table. Raw provider JSON stays at the provenance boundary;
- user references follow ADR-0020: nullable FK to the Better Auth user id, `ON DELETE SET NULL`;
- human-scannable codes for things people label — `ACQ-2026-0184`, `ITM-8F2K4`, `EXP-2026-0231` already exist, generated from the shared Crockford-minus-ambiguous alphabet with `withCodeRetry` over the unique violation. This design mints two more and reuses that machinery rather than inventing a third scheme;
- idempotency by deterministic natural key plus a unique constraint, never a timestamp or a random value;
- attachments are `media_links` rows keyed `(media_object_id, resource_type, resource_id, purpose)` per migration 0004. **No design in Loxep has ever needed an attachment table, and this one does not either**;
- physical measurements use the units `shipments` already established: `numeric(20,6)` grams and millimetres. Provider unit systems convert at the adapter boundary;
- no FX anywhere. Every money figure groups by currency and is never summed across currencies;
- provider SDK shapes stop at the integration boundary (ADR-0009);
- tables are TanStack Table through `DataTable` + `useDataTable`; forms are `useAppForm`; colors are semantic tokens.

None of the tables below is a Timescale hypertable. Nothing here is a temporal observation stream.

---

## 1. Expense capture always

### What is already shipped, and what is missing

`expenses` and `expense_allocations` shipped in migration 0006 with a complete service in `@loxep/accounting`, and receipts shipped as `media_links` rows with `resource_type = 'expense'` and `purpose ∈ {receipt, invoice, supporting_document}` — no receipts table, exactly as [the Phase 5 design](../financial-schema-design/#expenses-and-receipts) argued. The lifecycle is `draft → recorded → posted | void`, `draft` is the only mutable state, there is no `reopen`, and a recorded expense is corrected by voiding it and recording the corrected fact. The posting engine already consumes `expense` as a source fact, so a recorded expense reaches the ledger and the dashboard's Financial band automatically.

What is missing is everything a person touches:

```text
missing                                          consequence today
-----------------------------------------------  ------------------------------------------
any route, page, or server function              an expense cannot be created by a human
any upload path for a receipt image              MediaService.upload exists; nothing calls it
                                                 with an expense in mind
any import                                       a year of card activity must be retyped
the acquisition seam                             nothing tells an operator that this
                                                 particular spend belongs to a lot
```

**No schema change is required for expense capture.** That is the reason this is the first milestone.

### Quick entry is the dominant path, and it must be one screen

The design target is a reseller standing at a thrift-store counter with a phone. Everything else is a rounding error on that.

```text
Quick expense
  amount        required          the only field that cannot be defaulted
  date          today             editable
  category      last used         open set (no CHECK) — the operator's own vocabulary
  payee         free text         denormalized, matching acquisitions.vendor_name
  payment       last used         card | cash | bank_transfer | marketplace_balance |
                                  direct_debit | other
  currency      installation      one setting, rarely touched
  photo         optional          camera capture -> media object -> receipt link
  [ Save ]                        writes status = 'recorded' in one action
```

`create()` already accepts `status: 'recorded'`, so the fast path is one call and one round trip. `draft` remains available for the deliberate "I will finish this later" case, and it is the only state the full editor can change.

Two rules the surface must carry, both derived from shipped behavior rather than invented here:

- **Recorded is a lock.** The UI must not offer an edit affordance on a recorded expense; it offers *void and re-record*, with the required reason. Presenting an edit that the service will refuse is worse than presenting no edit.
- **Attribution is a snapshot with three rungs** — `manual`, `installation_default`, `unattributed` — resolved once at creation. The entity picker's empty selection means `unattributed` deliberately, which is not the same as omitting the field, and the surface must not collapse the two.

### Import: CSV yes, OFX no

This is a decision the ask specifically demanded be made honestly, so here is the reasoning rather than the conclusion.

**OFX/QFX is a bank statement format, and a bank transaction is not an expense.** It is a settlement fact — money that left an account — and one bank line frequently corresponds to zero, one, or several expenses (a card that settles three purchases in one batch; a purchase that appears days later; a purchase that never appears because it was cash). Phase 5 already designed `bank_statement_imports`, `bank_transactions`, and a reconciliation model for exactly this, and did not build them. Importing OFX into `expenses` would:

1. conflate a settlement with a spend, which is the specific confusion the operational-facts-before-accounting principle exists to prevent;
2. pre-empt the designed reconciliation model with an incompatible one, so Phase 5's bank work would arrive needing a data migration;
3. produce duplicates the moment the operator also enters the cash and marketplace-balance spends that never appear on a bank feed — which for a reseller is most of them.

So: **OFX and bank feeds stay Phase 5, unbuilt, and this design does not touch them.**

**CSV is a different object and it maps cleanly.** A CSV of "money I spent" — a card export the operator has already massaged, a spreadsheet they already keep, a marketplace activity export — is expense-shaped: one row, one date, one amount, one description. It maps column-for-column onto `expenses`. That is a real import and it belongs here.

The CSV importer needs three things beyond parsing:

- **operator-supplied column mapping**, because no two exports agree. The mapping is per-import, offered with a best guess from header names, and is not stored as installation configuration until a second import proves the same shape recurs;
- **a dry-run preview**, because the first thing anyone does with an importer is import the wrong file;
- **idempotency**, because re-importing the same file is normal.

The idempotency answer is the shipped house pattern, not a new one. `orders` faced the same question and answered *detect, do not constrain*: an adapter-computed key, a non-unique detection index, and an explicit duplicate marker. Applied here: each staged row carries a `row_fingerprint` computed from its source values, the importer **warns** when a fingerprint has already been committed, and the operator decides. A unique constraint would reject the legitimate case of buying coffee for the same amount at the same shop twice in one day.

### The staging table is shared with the parser, and that is the design's best idea

A CSV import and a parsed receipt are the same shape:

```text
a stored file  ->  candidate rows  ->  a human confirms  ->  domain records
```

The only differences are that a parsed receipt's candidates carry a confidence and a source region while a CSV's do not, and that a receipt may confirm into an *acquisition* while a CSV confirms into *expenses*. Neither difference justifies two mechanisms.

So both producers write to one pair of tables owned by the **Documents** domain, described in [2b](#2b-receipt-and-invoice-parsing). Documents owns the candidates and their state; it never writes an expense, an acquisition, or an inventory item. Each consuming domain owns its own confirm function. That division is exactly what [Domain Boundaries](../domain-boundaries/#documents) already says: *"Documents may own OCR text, structured extraction, matching status, document type, and business relationships while referencing one or more shared media objects."*

This is not a premature generic abstraction under cross-domain rule 6, and the test is explicit: the rule permits an abstraction when *concrete workflows show the abstraction is real*. There are two concrete workflows here, the owner asked for both in one directive, and the boundary is one the documentation already defined and named.

### The acquisition seam: when an expense is really a purchase

This is the sharpest question in ask 1, and the rule follows from the ledger being downstream of reality.

```text
operator records "money spent"
       |
       +-- was it for goods to resell?
            |
            no  -->  expenses row.
            |        (May still be ALLOCATED to an acquisition for attribution --
            |         expense_allocations.acquisition_id -- which is business
            |         context, not cost basis. Gas to drive to the auction is
            |         a real cost of that lot AND an expense, when the operator
            |         chooses not to capitalize it.)
            |
            yes -->  an acquisition (new or existing) plus an acquisition_costs
                     row. NOT an expenses row.
```

**The money that bought goods belongs to the lot.** It becomes `acquisition_costs`, gets allocated to `inventory_items.landed_cost_amount`, freezes at first depletion, and reaches the ledger as COGS. If the same money were also an `expenses` row it would be deducted twice, once at purchase and once at sale — and worse, the per-item contribution figure that Phase 4 calls the phase's headline deliverable would be computed against a basis the business had already expensed.

Phase 5 already established the symmetric rule in the other direction: non-capitalized `acquisition_costs` rows are **not copied** into `expenses`; a posting rule with `match_capitalize = false` posts them where they sit. This design states the inbound half of the same rule and gives it a UI: the quick-entry surface asks one question — *was this for goods?* — and routes accordingly. Answering yes opens acquisition intake with the amount and payee carried across.

**The reverse direction — an expense already recorded that turns out to be a purchase — is a void-and-re-record**, because `recorded` is a lock and this design does not loosen it. The corrected fact is the acquisition and its cost row.

That leaves one shipped column with no consistent meaning, and it is a real contradiction rather than a gap: **`expenses.acquisition_cost_id` is a real foreign key to `acquisition_costs.id` with no writer anywhere, and Phase 5's own no-copy rule forbids the reading it was apparently built for.** See [OQ2](#open-questions).

### Where a receipt attaches when the spend was a purchase

An acquisition already has a documented media home — Phase 4's relationship overview reserves `media_links` with `resource_type ∈ {acquisition, inventory_item, shipment}` for exactly this, and **nothing has ever written those values**. A photographed auction invoice attaches to the acquisition with `purpose = 'invoice'`; a thrift receipt covering four items attaches to the acquisition and, when the operator wants it, to each item as `purpose = 'supporting_document'`. `media_links` was deliberately keyed to allow one object across many resources, and migration 0004's own commentary names this case: *"a receipt photo covers a lot AND each item unpacked from it"*.

---

## 2. Acquisition import

### 2a. Connector-sourced purchases: the eBay buy side

#### What a user token can actually enumerate — verified, not assumed

Every claim in this subsection was verified against `ebay-api@10.0.0` as installed and against Loxep's own adapter and its recorded live findings. Where something is not verifiable in this repository it is marked so.

```text
surface                              can it enumerate MY purchases?
-----------------------------------  ----------------------------------------------------
Trading  GetMyeBayBuying (WonList)   YES. The buyer's won/purchased items. This is the
                                     source.
Trading  GetItemsAwaitingFeedback    Partially — purchases pending feedback only. Narrow,
                                     but see the sandbox note; it WORKS in sandbox.
Trading  GetBidderList               Bids, not purchases. Works in sandbox.
Trading  GetOrders / GetItemTrans-   NO. Trading's order and transaction calls are
         actions / GetSellerTrans-   SELLER-side: orders on your account as seller,
         actions                     transactions on items you listed.
REST     buy.order                   NO. Guest checkout only. Its single retrieval,
                                     getGuestPurchaseOrder(purchaseOrderId), fetches ONE
                                     order created through that guest session by id.
                                     There is no list operation.
REST     buy.marketplaceInsights     NO. One method, search() — sold-item search across
                                     the whole marketplace. Not "my purchases".
REST     postOrder.{return,case,     NO. Enumerates DISPUTES about purchases, not the
         inquiry,cancellation}       purchases. Would also need a new adapter seam.
REST     sell.*                      NO, by definition. Seller-side.
```

Three consequences, and they are all favourable:

1. **No new OAuth scope and no re-consent.** The traditional Trading APIs do not use OAuth scopes at all — the user token is presented in the `X-EBAY-API-IAF-TOKEN` header and authorizes on the app-plus-user identity. `oauth.ts` records this explicitly, and the shipped watchlist poller proves it: `GetMyeBayBuying` runs today on a `watchlist`-tier token holding only `https://api.ebay.com/oauth/api_scope`. This is the opposite of the order-ingestion story, where the RESTful Sell Fulfillment read forced a whole new consent tier.
2. **No adapter change.** `EbayUserAdapter.tradingCall(callName, fields)` is a generic dispatcher over `client.trading[callName]`, and every one of the 139 Trading calls is a callable method on the client. The work is a mapper next to `watchlist.ts`, not a new adapter surface.
3. **It is the same call the watchlist already makes, with a different container.** `GetMyeBayBuying` takes `WatchList`, `BidList`, `WonList`, `LostList`, and `BuyingSummary`. Loxep asks for `WatchList` today. Asking for `WonList` is a request-shape change.

#### The sandbox limitation, stated plainly

**This cannot be verified in the eBay sandbox, and the reason is already documented and reproduced in this repository.** On 2026-08-12, under loxep-76k, sandbox `GetMyeBayBuying` (Version 1193, build `E1193_CORE_API_19146280_R1`) was found to return `Ack: Success` with **no container at all** — no `WatchList`, no `BuyingSummary`, no `BidList`, `WonList`, or `LostList` — even when the watch list was provably non-empty. Every argument shape, and compatibility levels 967 through 1451, behaved identically; the body is parsed (a bogus `DetailLevel` errors) but the container subtree is never deserialized server-side. `GetMyeBaySelling`, `GetBidderList`, and `GetItemsAwaitingFeedback` return their containers normally for the same token.

So the honest posture is identical to the watchlist vertical's: **build it, ship it behind a per-connection toggle, and mark the mapping unverified until a production account connects.** Two things make that tolerable rather than reckless:

- `GetItemsAwaitingFeedback` **does** return its container in sandbox and covers a subset of recent purchases. It is not a substitute source — its window is narrow and feedback-dependent — but it is enough to exercise the mapper, the provenance write, and the intake queue end to end against a real provider response in CI-adjacent testing. Recommended as the sandbox smoke path, explicitly not as a second ingestion source.
- Nothing downstream branches on being right. An unmapped field degrades to a candidate the operator corrects, because **no ingested purchase writes inventory without confirmation** (below).

Not verifiable here and needing external confirmation: whether `WonList` behaves correctly in production, and what lookback window and pagination ceiling eBay enforces on it.

#### Ingestion shape: provider facts, then acquisitions

The pipeline is the documented one, unchanged:

```text
GetMyeBayBuying { WonList: { Include: true, Pagination: {...} } }
        |
        v
provider_objects (object_type = 'ebay.purchase', payload + payload_hash)
source_events    (event_type  = 'ebay.purchase')
        |
        v  Loxep-owned EbayPurchaseFact (no provider type escapes the adapter)
        |
        v
acquisitions  +  acquisition_costs        status = 'draft'
        |
        v
        candidate intake lines  ->  human confirms  ->  inventory_items
```

Mapping, all onto shipped columns and shipped union members:

```text
acquisitions.source_kind          'online_marketplace'
acquisitions.connection_id        the eBay connection (the column exists and is nullable
                                  precisely for "the foreseeable path where a marketplace
                                  purchase is ingested from a connection rather than typed")
acquisitions.external_reference   the eBay order id
acquisitions.vendor_name          the seller's user id
acquisitions.title                the item title, or "N items from <seller>" for a
                                  multi-item order
acquisitions.acquired_at          the transaction created date
acquisitions.currency             the transaction currency
acquisitions.status               'draft' -- see below
acquisitions.entity_attribution_source
                                  'connection_default'
acquisition_costs  item price     cost_type 'goods',            cost_class 'goods'
acquisition_costs  shipping paid  cost_type 'inbound_freight',  cost_class 'ancillary'
acquisition_costs  tax            cost_type 'sales_tax',        cost_class 'ancillary'
```

**`connection_default` is the payoff of a decision Phase 4 already made.** That value is in the `entity_attribution_source` `CHECK` today, unused, and Phase 4's design says why in as many words: *"the ingested-purchase path (eBay purchase history becoming acquisitions) is a foreseeable near-term addition and widening a `CHECK` on a table that already has rows is a migration nobody should have to write for one string."* This design is that addition, and it needs no migration for it.

#### An ingested purchase does not become inventory

This is the rule that keeps the feature from being actively harmful.

A reseller's eBay purchase history contains goods for resale, shipping supplies, parts to repair other goods, a birthday present, and a replacement charger for their own laptop. Automatically minting an `inventory_items` row per purchase line would fill the stock ledger with things that are not stock, and every one of them would carry a cost basis and appear in on-hand-at-cost.

So an ingested purchase creates the acquisition and its costs in `status = 'draft'` and stops. Its lines become **intake candidates** in the same review queue the receipt parser feeds, where the operator marks each one *stock*, *supplies*, *not mine*, or *personal*. Only *stock* writes an `inventory_items` row. *Supplies* is the one case that legitimately becomes an expense rather than a lot — and it is the reason the expense/acquisition seam has to work in both directions.

#### Idempotency needs one index, and it is the only Phase 4 table this design touches with DDL

`acquisitions` has exactly one unique constraint: `unique(reference_code)`, on a code Loxep mints. There is no way for a re-poll to recognize a purchase it already ingested.

```text
add:  unique index acquisitions_connection_external_ref_uq
        on acquisitions (connection_id, external_reference)
        where connection_id is not null and external_reference is not null
```

Partial, so the hundreds of hand-entered acquisitions with neither column are unaffected; unique rather than merely detected, because unlike the cross-connection order duplicate this key is not adapter-guessed — it is the connection Loxep chose and the id eBay assigned, and both are always available. This adds no column to a Phase 4 table, which is the constraint Phase 4 set for itself.

#### Scheduling

`ebay_purchases` registers against the shared scheduling model exactly as `ebay_orders` and `woo_orders` do, following all three rules [Domain Boundaries](../domain-boundaries/#scheduling-is-shared-foundation-infrastructure) states: the target type and its config Zod schema join `@loxep/market`'s two lists (structurally re-declared, never imported, so the scheduler takes no dependency on the domain registering against it); the cursor lives under a namespaced `config.purchaseSync` key that nothing else reads or writes; and the executor lives in `@loxep/app`, routing `ebay_purchases` to a new sync service in `@loxep/inventory`.

Cadence should be measured in hours, not the 60-second monitor baseline. Purchase history is not a price feed.

#### Implementation status (loxep-dgf.5)

Shipped, live-unverified, mapper-and-service-only:

- **Mapper** — `packages/integrations/ebay/src/purchases.ts` maps `GetMyeBayBuying`'s `WonList` container into the Loxep-owned `EbayPurchaseFact`/`EbayPurchaseLineFact` shapes described above, including the checkout-grouping rule (`groupWonListEntries`, one fact per `Order.OrderID`, or a synthetic `txn:<TransactionID>` key for a standalone purchase). Its container shape is **design-derived, not live-verified** — the same sandbox defect `watchlist.ts` documents (`Ack: Success`, no container at all) applies to `WonList` too, so this ships fixture-tested only, exactly as the watchlist vertical did, pending a production account.
- **Ingestion service** — `packages/inventory/src/purchase-sync.ts` (`createPurchaseIngestionService`, `createEbayPurchaseSync`) writes a `provider_objects` row per purchase (`object_type = 'ebay.purchase'`), then a `draft` `acquisitions` row plus `acquisition_costs` rows (goods/inbound_freight/sales_tax) exactly per the mapping table above, and stops — no `inventory_items` are ever minted by this path. `@loxep/documents`' M4 intake-candidate queue (loxep-dgf.4) had not shipped when this landed, so the reviewable unit today is the `draft` acquisition itself, not a per-line candidate; nothing here needs to change when M4 lands.
- **Scheduling registration** — `ebay_purchases` and its `purchaseSync`-namespaced config schema (nullable watermark, per the `ebay_orders` null-watermark lesson) are registered together in `@loxep/market`'s `MONITOR_TARGET_TYPES`/`monitorTargetConfigSchemas`.
- **UI** — the existing `/inventory/acquisitions` list and detail views already generalize over `sourceKind`/`status` (`online_marketplace`/`draft` need no new labels), so a connector-ingested lot is filterable today. What this change adds is an "Imported" badge wherever `connectionId` is set, and a fix to the detail view's `externalReference` renderer, which previously always rendered that field as a clickable URL — wrong for an opaque eBay order id.

**Two pieces are explicitly NOT shipped, both flagged rather than silently skipped:**

1. **No `@loxep/app` poll executor.** The design calls for an executor in `@loxep/app` routing `ebay_purchases` to `@loxep/inventory`'s sync service, mirroring `ebay_orders`' `commerce-ebay.ts` exactly. `@loxep/app`'s `package.json` does not declare `@loxep/inventory` as a dependency (unlike `@loxep/commerce`, which it already depends on), so the executor cannot be wired without a `package.json` edit and a `bun install` relink — both outside a mapper/service change's write fence. Nothing is broken by the gap: `ensurePurchaseSyncTarget`/`syncConnection` work today via direct invocation; what does not yet work is SCHEDULED polling, because no route claims an `ebay_purchases` target, and no settings UI creates one yet either. Follow-up: add the dependency line, add `packages/app/src/inventory-ebay.ts` (structural mirror of `commerce-ebay.ts`), add the routing table entry, add a per-connection enable/disable surface (mirroring `apps/web/src/server/order-sync-functions.ts`'s `enableOrderSync`/`disableOrderSync`).
2. **No `acquisitions_connection_external_ref_uq` migration.** The idempotency check in `ingestEbayPurchase` is an application-level look-then-insert (`select … where connection_id = … and external_reference = …` before the insert), not the partial unique index this section specifies. That is safe against sequential re-polls but not against two genuinely concurrent syncs of the same connection. Follow-up: the one-index migration described above.

### 2b. Receipt and invoice parsing

#### The parser interface

This is the load-bearing design decision of ask 2, because it is the one that decides whether Loxep stays a self-hosted product that works with no egress and no extra binaries.

```text
interface ReceiptParser {
  id:      string                      // 'manual' | 'ocr_tesseract' | 'llm_vision' | ...
  label:   string
  parse(input: {
    mediaObjectId: string              // an already-stored media object; the parser
                                       // receives a Loxep media id, never a path or a URL
    documentKind:  'receipt' | 'invoice' | 'packing_slip' | 'statement'
    hints?: { currency?: string; expectedTotal?: string }
  }): Promise<ParseResult>
}

interface ParseResult {
  parserId:   string
  parsedAt:   Date
  currency:   string | null
  documentTotal: string | null
  lines: {
    description:   string | null
    quantity:      string | null
    unitAmount:    string | null
    lineAmount:    string | null
    confidence:    number              // 0..1, per LINE
    fieldConfidence?: Record<string, number>
    sourceRegion?: { page: number; x: number; y: number; w: number; h: number }
  }[]
  warnings: string[]
}
```

Three properties are non-negotiable and every one of them is checkable:

- **The output is candidates, never records.** `ParseResult` contains no Loxep ids for expenses, acquisitions, or items, and the parser has no database handle. It cannot write a domain row because it is not given the means to.
- **Confidence is per line and per field, and it is always present.** A manual transcription reports `1.0` because a human typed it. Uniform shape means the review UI does not branch on backend.
- **Source regions are optional and are for the human.** They drive the side-by-side highlight; nothing downstream depends on them, so a backend that cannot produce them is a first-class backend.

#### Backends: the options, and the recommendation

```text
backend         accuracy   deps added            egress   cost      ships when
--------------  ---------  --------------------  -------  --------  --------------
manual          perfect    none                  none     none      NOW
ocr_tesseract   moderate   a native binary or    none     none      later, if asked
                           wasm build in the
                           container image
llm_vision      high       none in the image;    YES      per-call  later, opt-in
                           an encrypted API
                           credential + a
                           configured provider
```

**Recommendation: manual-assisted first, and it is the only backend that ships in this phase.** Four reasons, in order of weight:

1. **The review UI is required regardless of backend**, because nothing auto-commits. Building it first delivers the entire operator value — a side-by-side transcription surface where the operator reads the receipt on the left and lines appear on the right is dramatically faster than the alternative, which today is retyping into nothing at all — and it makes every later backend a pure accelerator over a path that already works.
2. **A self-hosted product must work with no egress and no extra binaries.** An `ocr_tesseract` backend adds weight to the one Loxep image for every deployment, including the ones that will never parse a receipt. An `llm_vision` backend sends photographs of the operator's financial documents to a third party, which is a decision only the owner of the installation can make, and which must therefore be off by default and configured in-app.
3. **Adding a backend later changes no table, no confirm path, and no UI.** That is the reversibility test this documentation applies everywhere, and it passes cleanly.
4. **Accuracy on real receipts is worse than intuition suggests.** A crumpled thermal receipt from an estate sale is not a clean invoice PDF, and a backend that is right 70% of the time produces a review queue the operator must read line by line anyway — which is the manual path with extra steps and a false sense of completeness.

When a backend is added, it is a **configured provider under `/settings`**, following the existing pattern exactly: the backend selection is a database-backed application setting, an LLM credential is an encrypted `application_secrets` record reached through the credential service, never a Compose environment variable, and the provider adapter lives under `packages/integrations/` with the same error taxonomy and rate-budget shapes every other adapter uses.

This is [OQ3](#open-questions) and is flagged **OWNER-REVIEW-CRITICAL** — not because it is hard to reverse, but because it is a policy question about what a self-hosted Loxep is allowed to send off the box, and the answer belongs to the owner rather than to an implementer.

#### The Documents tables

Two tables, in a new `@loxep/documents` package (see [Package ownership](#package-ownership)).

```text
documents
id                    uuid primary key
document_kind         text not null
source_kind           text not null
media_object_id       uuid null references media_objects(id)
original_filename     text null
economic_entity_id    uuid null references economic_entities(id)
status                text not null
parser_id             text null
parsed_at             timestamptz null
currency              char(3) null
document_total        numeric(20,6) null
document_date         date null
counterparty_name     text null
line_count            integer not null default 0
confirmed_count       integer not null default 0
confirmed_at          timestamptz null
confirmed_by_user_id  text null references user(id) on delete set null
note                  text null
created_by_user_id    text null references user(id) on delete set null
created_at            timestamptz not null
updated_at            timestamptz not null
check(document_kind in ('receipt','invoice','packing_slip','statement','csv_import'))
check(source_kind in ('upload','csv','connector'))
check(status in ('pending','parsing','review','partially_confirmed','confirmed',
                 'discarded','failed'))
check((source_kind = 'upload') = (media_object_id is not null))

document_line_candidates
id                     uuid primary key
document_id            uuid not null references documents(id) on delete cascade
line_number            integer not null
row_fingerprint        text null
description            text null
quantity               numeric(20,6) null
unit_amount            numeric(20,6) null
line_amount            numeric(20,6) null
currency               char(3) null
line_date              date null
confidence             numeric(4,3) null
source_region          text null
disposition            text not null
target_kind            text null
target_id              uuid null
confirmed_at           timestamptz null
confirmed_by_user_id   text null references user(id) on delete set null
note                   text null
created_at             timestamptz not null
updated_at             timestamptz not null
unique(document_id, line_number)
check(disposition in ('pending','expense','acquisition_cost','inventory_intake',
                      'supplies','personal','not_mine','duplicate','discarded'))
check(target_kind is null or target_kind in ('expense','acquisition','acquisition_cost',
                                             'inventory_item'))
check((target_id is not null) = (target_kind is not null))
check(confidence is null or (confidence >= 0 and confidence <= 1))
```

Notes on the shape, because several columns are answers to questions:

- **`target_kind` + `target_id` is a stamp, not a foreign key.** It records which domain record a confirmation produced, across four different tables, and it deliberately does not constrain. This is the same treatment `journal_entry_source_links` and `media_links.resource_id` already get, for the same reason and with the same acknowledged cost: an orphan-detection report is owed alongside it. A real FK is impossible without four nullable columns and a `num_nonnulls` check, which buys integrity on a row whose entire purpose is to be an audit crumb.
- **`disposition` is the whole review workflow, and its members are the operator's actual vocabulary.** `supplies` and `personal` are not decorations: they are the two most common lines on a reseller's eBay purchase history that must never become stock, and collapsing them into `discarded` would destroy the only signal that says how much of the spend was operational overhead.
- **`source_region` is `text`, holding a small serialized rectangle, and it is presentation.** It is the one place a `jsonb` bag would be tempting; it is refused for the documented reason, and the serialized form is the parser's to define because nothing but the review UI reads it.
- **`row_fingerprint` is nullable and only a CSV import populates it.** The duplicate warning is a query against previously confirmed fingerprints, never a constraint — detect, do not constrain, for the third time in this documentation.
- **`documents.media_object_id` is nullable because a CSV import is not a document you look at.** The `CHECK` ties the null to `source_kind = 'upload'` so the two states cannot be half-recorded, which is the kind/reference consistency pattern this documentation has now used five times.
- **No `parsed_text` column.** OCR text is a Documents-domain asset the boundary doc names, and it will earn a column when a backend produces one. Adding it before then would ship an always-null column and a claim that Loxep does something it does not.
- **The status counters (`line_count`, `confirmed_count`) are caches** with one writer, maintained in the same transaction as the confirm, exactly as `inventory_items.quantity_on_hand` is. They exist because the review queue lists documents and would otherwise aggregate candidates per row.

#### Confirmation is owned by the consuming domain

`@loxep/documents` exposes the queue and the candidates. It exposes **no** function that writes an expense, an acquisition, or an item.

```text
@loxep/documents      createDocument, attachMedia, recordParseResult,
                      setDisposition, listQueue, get, discard
                      -- and stampConfirmed(candidateId, targetKind, targetId),
                         which writes only its own columns

@loxep/accounting     confirmCandidatesAsExpense(documentId, candidateIds, input, actorUserId)
@loxep/inventory      confirmCandidatesAsAcquisition(documentId, candidateIds, input, actorUserId)
                      confirmCandidatesAsIntake(acquisitionId, candidateIds, input, actorUserId)
```

Each confirm function requires a non-null `actorUserId` and runs the domain write plus the `stampConfirmed` call in one transaction. That signature is the structural enforcement of "never auto-commit": a Graphile Worker task has no session and therefore no actor, so the parse job physically cannot call it.

#### Implementation status (loxep-dgf.4)

Shipped: migration `0017_documents.sql` (`documents`, `document_line_candidates`, unchanged from the schema above); the new `@loxep/documents` package (`parser.ts`'s `ReceiptParser`/`createParserRegistry`, `manual-parser.ts`'s `manualParser` plus the exact-decimal-string `normalizeMoneyString`/`normalizeDateString`, `csv.ts`'s parsing/column-mapping/fingerprinting, `documents.ts`'s `createDocumentsService`, `candidates.ts`'s `createCandidatesService` including `stampConfirmed`) — 64 tests against real PostgreSQL, with the never-auto-commit proof (`test/never-auto-commit.test.ts`) written first and the confirmation-idempotency cases (same candidate confirmed twice; a document discarded only when nothing is confirmed) this document's "before implementing" section asked for; `apps/web`'s `/finance/import` (CSV upload → mapping → dry-run preview with a duplicate-fingerprint warning → staged review → confirm) and receipt upload (`routes/api.documents.upload.ts`, transcribed by hand on the same review panel, no OCR).

Two divergences from the sketch above, both load-bearing and both explained where they happen: `@loxep/documents`'s exported function is named `createDocumentsService`/`createCandidatesService` (factories), not the bare `createDocument`/`attachMedia`/… the sketch lists as if they were top-level exports — `attachMedia` is `createFromUpload`'s alias on `DocumentsService`, matching the sketch's naming intent exactly, just through a service object rather than loose functions, the same shape every other `@loxep/*` package uses. And `document_line_candidates` has no `payee` column (this document's own DDL never gave it one), so a CSV row's payee is folded into `description` ("Payee — description") by both `@loxep/documents/documents.ts`'s `stageCsvRows` and its `apps/web` mirror, rather than silently dropped.

**Three pieces are explicitly NOT shipped, flagged rather than silently skipped, matching the honesty this document asks for elsewhere:**

1. **No `confirmCandidatesAsExpense`/`confirmCandidatesAsAcquisition`/`confirmCandidatesAsIntake` inside `@loxep/accounting`/`@loxep/inventory`.** This milestone's write fence excluded both packages. `apps/web/src/server/documents-functions.ts`'s `confirmLinesAsExpense` achieves the identical structural guarantee (non-null actor, one transaction, `createExpensesService({ db: tx })` bound to that transaction, `stampConfirmed`'s shape re-implemented inline) at the web layer instead. Follow-up: once `@loxep/accounting`/`@loxep/inventory` are back in scope, move this logic into `confirmCandidatesAsExpense` proper and have `apps/web` call it — no behavior change, less duplication.
2. **`apps/web/package.json` does not declare `@loxep/documents`.** The same class of gap M2 had for `@loxep/inventory` before that dependency line was added. `documents-functions.ts`/`documents-media.ts` re-implement the package's `documents`/`document_line_candidates` operations directly over `@loxep/db`, deliberately kept IDENTICAL to `@loxep/documents/src/documents.ts`'s/`candidates.ts`'s own SQL so the eventual dependency add is a deletion, not a rewrite.
3. **No confirm action for `acquisition_cost`/`inventory_intake` dispositions.** The schema, the disposition vocabulary, and the review UI's disposition picker all support the full eight-member set from day one — an operator CAN mark a line "Cost of a lot" or "Stock (inventory)" — but confirming one into a real `acquisition_costs`/`inventory_items` row needs an acquisition-lot picker (create new vs. attach to an existing draft lot) this milestone does not build. `apps/web/src/features/documents/constants.ts`'s `CONFIRMABLE_DISPOSITIONS` and `documents-functions.ts`'s `CONFIRMABLE_AS_EXPENSE` name the gap in code, not just here.

Not yet done, and worth naming rather than leaving implicit: no `application_settings` key for parser-backend selection (only one backend exists, so nothing to select yet) and no `documents.media_limits` registered setting (the document-upload size/MIME cap is a hardcoded constant, matching `receipt-media.ts`'s pre-M3 precedent rather than `inventory-media.ts`'s registered-setting one) — both are `@loxep/domain/settings-defaults.ts` additions outside this milestone's write fence.

---

## 3. Inventory enrichment

### What the stock row carries today, and what it must carry

`inventory_items` shipped exactly as designed: identity, attribution, location, lineage, condition and grading, quantities, cost basis, and five semantic timestamps. It carries **no description, no dimensions, no weight, no images, no product specifics, and no notion of how the thing will be sold.** `label` is the only free text on the row, and `condition_notes` the only other prose.

The one place weight and dimensions exist anywhere in Loxep is `shipments` — on the package, not on the item. Phase 4 recorded the consequence as a limitation in its own open question 7: shipping cost is allocated across lines by `line_total` rather than by weight *"because Phase 4 does not capture per-item weight reliably"*.

Everything in this section feeds listing authoring. That is the test each field must pass, and the mapping table in [4b](#4b-the-bridge-to-loxep-managed-listing-authoring) is where it is applied.

### This design alters `inventory_items`, deliberately

Phase 4 set itself the rule *"no existing table gains a column"* and held it. This design breaks that rule for one table, and the justification has to be explicit rather than assumed.

Phase 4's rule was scoped to Phase 4 — it exists so that a phase does not reach sideways into tables another phase owns while that phase is still settling. Its stated forward test is different and is the one that applies here: *"Every arrow into a future phase is a reference added later, not a rewrite of these tables."* Adding six nullable descriptive columns rewrites nothing. Every existing row remains valid, every existing query remains correct, every existing constraint is unchanged, and every existing test passes untouched.

The alternative considered and rejected was a 1:1 `inventory_item_details` side table. It was rejected because a 1:1 table whose parent is always joined is a table only in the sense that it has a name: every read of an item for listing, shipping, or display would join it, the two rows would need transactional co-maintenance, and the boundary it appears to draw is not a real ownership boundary — dimensions and weight are Inventory facts about a physical thing, and Inventory already speaks grams and millimetres on `shipments`.

```text
alter table inventory_items add column
description             text null
sale_mode               text not null default 'unit'
package_weight_grams    numeric(20,6) null
package_length_mm       numeric(20,6) null
package_width_mm        numeric(20,6) null
package_height_mm       numeric(20,6) null
check(sale_mode in ('unit','lot','set','parts_donor','parted_out','bundle_component'))
check(package_weight_grams is null or package_weight_grams > 0)
check(num_nonnulls(package_length_mm, package_width_mm, package_height_mm) in (0, 3))
```

### `sale_mode`: how it's sold

Phase 4's existing treatment of this question is real but partial. A row carrying `quantity = 100` **is** a lot of identical units, and that is deliberate — the design calls the item row a cost layer. Splitting one item into several is expressible through `origin_item_id` and a paired transfer, with basis divided pro rata. `condition_code = 'for_parts'` exists. `movement_kind = 'consumption'` exists.

What does not exist is the **declaration** — the operator saying what this thing is going to be before doing it — and that declaration is what listing authoring, pricing, and the parted-out reporting all need. There is no service that splits an item into differently-labelled children; `moveToLocation` splits by quantity for a partial move, which is not the same operation.

```text
unit               one physical thing, sold as one thing. The default and the
                   dominant case.
lot                sold together as one listing, several physical things. A box of
                   forty Hot Wheels listed once.
set                a matched group whose value depends on completeness. A set of six
                   chairs; parting it destroys most of the value.
parts_donor        acquired to harvest from, never to sell whole.
parted_out         a unit that HAS been broken into children. Written by the part-out
                   operation, not chosen at intake.
bundle_component   held to be combined with others into a listing later.
```

`parted_out` is the one member the operator does not pick; it is set by the operation, and its presence on a row is what makes "which of my lots did I actually part out, and did it beat listing them whole" answerable at all. `text` with a `CHECK` because the set is genuinely closed and entirely Loxep-owned — no provider invents a sale mode — which is the same argument Phase 4 used for `condition_code`.

**The part-out operation itself is an `ItemsService.partOut(...)`**, and it is the one genuinely new inventory service verb this design adds: it creates N child rows with `origin_item_id` set, divides the parent's basis across them by a supplied basis (the same `distributeByWeights` largest-remainder function the lot cost engine already uses), depletes the parent through the movement writer, and sets the parent's `sale_mode = 'parted_out'`. Everything it needs already exists; nothing about it is new machinery.

### Images

**No new table, and no new column.** `media_links` with `resource_type = 'inventory_item'` — a value Phase 4's own relationship overview reserved and nothing has ever written.

```text
purpose = 'gallery'             ordered by sort_order; sort_order = 0 is the primary
purpose = 'condition_evidence'  the flaw photos that keep a return from becoming a case
purpose = 'supporting_document' the manual, the receipt, the certificate
```

**Primary is `sort_order = 0`, not a `primary` purpose value.** The Phase 3 design sketched *"one primary image plus ordered gallery images per resource, expressed through `purpose` and `sort_order`"*, which reads as though primary might be a purpose. It should not be, and migration 0004's key is why: `purpose` is IN the unique key and `sort_order` deliberately is not, so a `primary` purpose would let one photo be both primary and gallery as two rows for one fact, and making a different photo primary would become a purpose rewrite instead of a reorder. Reordering is a `sort_order` update; that is what the column is for. Drag-to-reorder is exactly the "media ordering" use the Implementation Contract names when it permits retaining DnD Kit.

The upload path mirrors `handleAvatarUpload` structurally and diverges from it in three deliberate places:

```text
same as avatar     a FormData POST to a file route, not a createServerFn, because the
                   payload is binary -- the codebase's stated rule for uploads
                   a dynamic import of @/server/* so @loxep/storage stays out of the
                   client bundle
                   session-gated; 409 with a pointer to /settings/storage when no
                   backend is registered
                   MediaService.upload with metadata.purpose stamped

DIFFERENT          the serving route is NEW. /api/media/avatar/:mediaId hard-gates on
                   metadata.purpose === 'avatar' specifically so it cannot become a
                   generic "fetch any media by id" endpoint. That gate is correct and
                   must not be loosened; inventory images get their own route with
                   their own gate.

DIFFERENT          the size cap is a SETTING, not a constant. MAX_AVATAR_BYTES is 2 MB,
                   which is right for an avatar and wrong for the twelve-photo gallery
                   of a camera body. A registered application setting under an
                   inventory.* prefix, with the MIME allowlist beside it.

DIFFERENT          many objects per resource, so the client uploads N files and the
                   surface owns ordering. The avatar path replaces one object.
```

### Dimensions and weight

`package_weight_grams` and `package_{length,width,height}_mm`, in the units `shipments` already uses, converted to the provider's system at the adapter boundary.

**They are named `package_*` on purpose.** An operator weighing an item for a listing weighs the packed parcel on a shipping scale — that is the number a channel asks for, the number a rate quote needs, and the number they will actually have. A bare item weight is a different measurement they will not take, and offering both fields would guarantee that half the rows carry one and half the other with nothing to say which. `shipments` continues to record what the actual outbound package weighed, which is a different fact about a different object and legitimately differs.

The `num_nonnulls(...) in (0, 3)` check refuses a half-entered box. Two of three dimensions is not partial information; it is an error that produces a wrong rate quote silently.

### Description

`inventory_items.description text null` — plain text or Markdown, the internal authoring source of truth.

It is **not** listing HTML. eBay descriptions are HTML, Facebook Marketplace's are plain, and a Woo product description is a different field again; rendering to a channel's format is the adapter's job at publish time. A per-listing override belongs on `channel_listings`, which today has `listing_title` and no description column — an additive column for the write-side milestone, named here so nobody puts channel HTML on the stock row.

### Product specifics: typed key/values, and why not category templates

The ask named the alternatives explicitly, so both get argued.

**Category templates** would mean Loxep owning a taxonomy: which aspect names apply to "Film Cameras", which values are allowed, per marketplace. Rejected, decisively:

- eBay publishes that metadata itself and it is fetchable at authoring time — `sell.metadata.getItemAspectsForCategory` exists in the installed client. A mirrored copy goes stale silently, and an operator listing against a stale required-aspect set gets their listing rejected by eBay for a reason Loxep caused.
- Category taxonomies are the textbook case of [Principle 8](../principles/) — *"Marketplace search semantics often do not"* share a useful cross-provider concept. eBay aspects, Woo attributes, and Facebook Marketplace's fixed fields are three different systems, and a universal template model would hide that behind a leaky interface.
- [Principle 18](../principles/) says integrate before rebuilding. The template belongs to the adapter, fetched when the operator is authoring for that channel and that category.

**Typed values** are cheaper than they look and worth having, but only halfway:

```text
inventory_item_specifics
id                  uuid primary key
inventory_item_id   uuid not null references inventory_items(id) on delete cascade
name                text not null
value               text not null
value_numeric       numeric(20,6) null
unit                text null
sort_order          integer not null default 0
source              text not null default 'manual'
created_at          timestamptz not null
updated_at          timestamptz not null
unique(inventory_item_id, name, value)
check(source in ('manual','parsed','channel_suggested','catalog_default'))
index(name, value)
```

- **Multi-value falls out of the key.** eBay aspects are `name -> string[]`; a two-value aspect is two rows sharing a name, ordered by `sort_order`. A `text[]` column was considered and rejected: it would make "every item where Brand = Nikon" a containment query against an unindexed array where the relational form is a plain index lookup, and it edges toward the free-form attribute bag every design in this documentation refuses.
- **`value` is the truth and `value_numeric` is a shadow.** It is populated only when the value parses cleanly as a number, and nothing is derived from it — it exists so "shutter count under 5,000" is a range scan instead of a cast in a `WHERE` clause. The verbatim string survives because "9.8" and "PSA 9.8" and "9.8 (qualified)" are three different claims, which is the same argument that kept `grade_label` alongside `grade_numeric` on the item row.
- **`source` distinguishes what a human asserted from what a machine proposed.** A `channel_suggested` aspect that eBay's metadata filled in is not the same fact as one the operator typed, and when an aspect turns out to be wrong the difference is the first thing anyone wants to know.
- **Specifics attach to the ITEM, not to the catalog item.** `inventory_items.catalog_item_id` is nullable and usually unresolved — Phase 4 argued at length that requiring a SKU at intake pushes operators into creating junk SKUs. Attaching specifics to the physical unit means an unidentified brass lamp can accumulate "Material: Brass", "Height: 14 in" before anyone decides what it is. A `catalog_item_specifics` sibling is purely additive if SKU-level defaults ever become real, and `source = 'catalog_default'` is in the `CHECK` now for exactly that path — the same pre-widening Phase 4 did for `connection_default`.

---

## 4. Listings

### 4a. Offline and local listings as first-class channel listings

#### The wall

```text
channel_listings.connection_id       uuid NOT NULL references connections(id)
channel_listings.external_listing_id text NOT NULL
unique nulls not distinct (connection_id, provider, external_listing_id,
                           external_variation_id)
```

A Facebook Marketplace listing has no Loxep connection and no external listing id Loxep can read. There is no manual-channel concept anywhere in the codebase or the documentation. `packages/domain/src/connections.ts` lists `channel_listings` among the tables that **block connection deletion**, so today the codebase treats a channel listing as permanently connection-bound.

#### Three options, argued

**Option 1 — a synthetic "manual" connection row.** Phase 3 itself named this when it declined to build manual orders: *"it needs either a synthetic connection or a nullable column."* Rejected. A connection with no credential, no health, no sync, and no provider is not a connection; it would appear in `/settings/connections`, in the operations-health band, and in every connection diagnostic as a permanently-unknown row that no amount of care will ever make green. [Domain Boundaries](../domain-boundaries/) defines the connection concept as *"external connections/accounts and credentials"*, and this has none of the three. A lie in the operations surface is a bad price for avoiding one `ALTER`.

**Option 2 — a separate `manual_listings` table.** Rejected. Two tables meaning one thing: every cross-channel report becomes a union, `order_lines.channel_listing_id` can point at only one of them, and the ask was explicitly for offline listings to be **first-class**, which a parallel table is the definition of not being.

**Option 3 — relax `channel_listings` so a listing may have no connection.** Recommended.

#### The recommended shape

```text
alter table channel_listings
  alter column connection_id       drop not null
  alter column external_listing_id drop not null
  add column listing_code text not null              -- backfilled, then unique

add constraint channel_listings_listing_code_uq unique (listing_code)

drop constraint channel_listings_connection_listing_variation_uq
create unique index channel_listings_connection_listing_variation_uq
  on channel_listings (connection_id, provider, external_listing_id,
                       external_variation_id)
  nulls not distinct
  where external_listing_id is not null

add constraint channel_listings_manual_connection_check
  check ((provider = 'manual') = (connection_id is null))
```

Four changes, each earning its place:

- **`listing_code` is the Loxep-owned scannable identifier** — `LST-2026-0042`, minted by the domain service from the shared code machinery, the fourth use of a pattern `acquisitions`, `inventory_items`, and `expenses` already established. It is what a manual listing is identified by, and it is what a *draft* listing is identified by before a channel has assigned anything. Backfilling existing rows in the migration is trivial; there are almost none.
- **`external_listing_id` becomes nullable and the provider key becomes partial.** This is the change that makes both manual listings and Loxep-authored drafts expressible without ever rewriting a natural key. Without it, a draft would have to hold a placeholder id that gets overwritten at publish — key churn on the row's own identity, which is the thing keys exist not to do. With it, publish is a plain `UPDATE` of a nullable column into its final value and the unique index simply starts covering the row.
- **`connection_id` becomes nullable, tied by `CHECK` to `provider = 'manual'`** so the two states cannot be half-recorded. This is the kind/reference consistency pattern for the sixth time in this documentation, and it means the connection-deletion guard in `packages/domain` stays correct without modification: a manual listing was never counted by it.
- **`nulls not distinct` is preserved on the partial index** because the original reason still holds — a non-variant listing's null `external_variation_id` must not make every re-sync insert a duplicate.

A manual listing is then, honestly and completely:

```text
provider              'manual'
connection_id         null
channel               'facebook_marketplace' | 'craigslist' | 'offerup' | 'in_person' |
                      'local_pickup' | 'consignment_shop' | 'other'
external_listing_id   null (or the FBMP item id, if the operator pastes one)
listing_code          'LST-2026-0042'
listing_url           the operator's own paste, when there is one
status                draft | active | ended | sold_out          (unchanged union)
price, currency, quantity_available, listed_at, ended_at         (unchanged)
```

`channel` carries the surface. It stays `text` with a TypeScript union and no `CHECK`, matching how `provider` and `channel` already behave, because the list of places a person can sell a thing locally is open and will grow.

#### The gap this leaves, stated rather than papered over

**A manual listing cannot yet record its own sale**, because `orders.connection_id` is `NOT NULL` and Phase 3 explicitly declined to create the manual-order path. Marking a manually-listed item sold today can write a `depletion_sale` movement with a null `order_line_id` — the column is nullable and the movement writer permits it — but that produces cost with no proceeds, and every profitability read model would report the item as pure loss.

This is [OQ7](#open-questions) and it is **OWNER-REVIEW-CRITICAL**, because `orders` is the most load-bearing table in the installation and the choice between a nullable `connection_id` and a synthetic connection is not reversible after rows exist. The loop is genuinely incomplete without it, and it is deliberately not decided here.

### 4b. The bridge to Loxep-managed listing authoring

Phase 3 was read-only against providers by design. This design **declares** the write side and scopes its first half without designing publish.

#### What is in scope now: the draft, and the mapping

A **draft listing** is a `channel_listings` row with `status = 'draft'`, a minted `listing_code`, and a null `external_listing_id` — authored entirely inside Loxep, publishable later, and identical in shape to a manual listing that never gets published. That is a strong signal the shape is right: manual selling and pre-publish authoring are the same object at different points in its life.

The inventory-to-draft mapping is the proof that section 3's fields are the right fields. Every enrichment column has a destination, and every destination has a source:

```text
draft listing field      <- source                              added by
-----------------------  ------------------------------------   ------------------
listing_title            inventory_items.label, or the catalog   existing
                           item name where one is resolved
description              inventory_items.description             THIS DESIGN (3)
price                    inventory_items.estimated_value_amount  existing
                           (the operator's target resale price,
                            which is NOT a valuation)
currency                 inventory_items.currency                existing
quantity_available       available-to-sell for the item          existing service
condition                inventory_items.condition_code          existing
                           mapped by the adapter to the
                           channel's own vocabulary
grading                  grading_authority / grade_label /       existing
                           grade_numeric / certificate_number
images                   media_links(inventory_item, gallery)    THIS DESIGN (3)
                           in sort_order
item specifics/aspects   inventory_item_specifics                THIS DESIGN (3)
package weight & dims    package_weight_grams, package_*_mm      THIS DESIGN (3)
sale shape               sale_mode                               THIS DESIGN (3)
                           unit -> one listing; lot/set -> one
                           listing for the group; parted_out ->
                           one listing per child
catalog item             inventory_items.catalog_item_id,        see below
                           resolved or minted at listing time
```

The mapping is a **pure function** in the domain, separately testable, taking an item plus a target channel and returning a draft. It writes nothing. That keeps "what would this listing look like" answerable in a preview without creating a row, which is what an authoring surface actually needs.

#### The catalog-item requirement, and the cheap answer

`channel_listings.catalog_item_id` is `NOT NULL` and this design does **not** relax it. Listing a one-of-a-kind item therefore requires a catalog item, which is the "junk SKU" pressure Phase 4 warned about.

The resolution is that Phase 4's warning was about **intake**, and this is **listing**, and the difference is decisive: at intake you have a brass lamp and no idea what it is, and at listing you necessarily know what it is, because you are about to write a title and a price for it. Requiring identity at the moment identity exists is not a burden.

**Recommendation: mint a `catalog_items` row at listing time when the item has none**, `kind = 'simple'`, `sku = inventory_items.item_code`. Both codes are unique installation-wide, so the SKU is guaranteed unique and traceable back to the physical unit, and `unique(sku)` needs no widening. Zero migration, and the whole chain closes with tables that already exist:

```text
inventory_item -> catalog_item -> channel_listing -> order_line
                                                       |
                        inventory_allocation <---------+  reserves THAT unit
                                |
                        depletion_sale movement on fulfillment
```

The named exit, if per-unit listings become the dominant case rather than the incidental one, is `channel_listings.inventory_item_id uuid null` plus relaxing `catalog_item_id` — additive, and it changes what a channel listing *is*, which is why it is [OQ5](#open-questions) rather than a decision taken here.

#### What is explicitly out: publish

Per-provider publish flows belong to each integration's own later milestone, and this design names only the surfaces so nobody has to rediscover them:

```text
eBay      sell.inventory.createOrReplaceInventoryItem -> createOffer -> publishOffer
          (the modern path; PackageWeightAndSize and product.aspects are exactly the
           shapes section 3 was built to fill), or Trading AddFixedPriceItem.
          Both are present in ebay-api@10.0.0. A write scope will be needed, which
          means a THIRD consent tier -- the existing tier machinery already handles it.
Woo       the REST products endpoint. The adapter is read-only today.
Medusa    the Admin products endpoint. The adapter is read-only today.
manual    there is nothing to publish. The listing IS the record.
```

Each of those is a milestone in its own integration, gated on the same live-verification discipline every adapter in this repository has been held to.

---

## The weave

The owner's fifth ask, and the reason the other four are one document.

### The loop

```text
                        /market  observation
                             |
                             |  "I bought this"      acquisition_opportunity_links
                             v                        (score + target price SNAPSHOT)
   money out  ------->  ACQUISITION  <-------  eBay purchase sync (ebay_purchases)
       |                     |          <-------  receipt -> documents -> candidates
       |                     |
       |                     v  intake (human-confirmed, per line)
       |               INVENTORY ITEM
       |                     |
       |                     |  enrich: images, specifics, dims, description, sale_mode
       |                     v
       |               DRAFT LISTING  ------>  channel publish     (later milestone)
       |                     |          ------>  manual/offline     (this design)
       |                     v
       |                  ORDER  (connector today; manual = OQ7)
       |                     |
       |                     v  allocation -> depletion_sale -> basis freeze
       |               REALIZED CONTRIBUTION  ---> back to /market: "the thing I
       |                                            watched, bought, and sold"
       v
   EXPENSES  --> posting rules --> journal --> /dashboard Financial band
   (non-goods spend only)

   ACQUISITION COSTS --> cost basis --> COGS --> journal  (BUILT SINCE; see below)
```

### Handoff by handoff

**`/market` to inventory — "I bought the thing I was watching."** Every piece exists and nothing calls it. `acquisition_opportunity_links` shipped with `link_kind ∈ {sourced_from, evaluated_against, comparable}`, snapshotted `score_at_link` and `target_price_amount`, an unenforced `opportunity_rule_id` stamp, and an idempotent `link()`. The missing piece is one action on `/market/items/:id` and `/market/opportunities`: **"I bought this"** opens acquisition intake pre-filled from the marketplace item — title into `label`, the last observed price into the goods cost, the seller into `vendor_name`, the listing URL into `external_reference` — and writes the link with `link_kind = 'sourced_from'` and the score frozen. The score must be *snapshotted at the moment of the decision*, never joined at read time, or editing an opportunity rule next month silently rewrites how good last month's decision looked.

The return trip closes the roadmap's Phase 4 line about connecting opportunities to realized outcomes: an observed item shows whether we ever bought one and what it realized, by joining `listForMarketEvent` to `itemRealizedContribution`. Note honestly that `link()` is idempotent **only when a `market_event_id` is supplied** — there is no partial unique covering `marketplace_item_id` alone, so a link keyed on `(acquisition, marketplace_item)` can be inserted repeatedly. The surface should always pass the event where one exists.

**Acquisition to inventory.** Intake, and it is one surface serving three producers — hand entry, an ingested eBay purchase, and a parsed receipt. All three land in the same candidate queue with the same dispositions. That is the payoff of unifying the staging table: the operator learns one review screen.

**Inventory to listings.** The mapping function in [4b](#4b-the-bridge-to-loxep-managed-listing-authoring), plus one thing nobody writes today: `inventory_items.listed_at` exists and no code sets it. Creating a listing for an item sets it; that column is what "how long has this been sitting listed" is computed from, and the aging read model already exists to consume it.

**Listings to orders to depletion.** Already built end to end for connector channels, and untouched by this design. `depleteOnFulfillment` never raises on a missing allocation — the unmatched-depletion backlog is the correct behavior and the common case early on, not a failure.

**Expenses to accounting.** Already wired at the back end. A recorded expense is read by the posting engine's `expense` source-fact reader, matched by a posting rule, posted to the journal, and appears in the dashboard's Financial band. **Only the front end is missing.** The first milestone therefore lights up an entire existing pipeline by shipping a form.

**Acquisitions to accounting — the hole this design named, CLOSED SINCE by Phase 5's milestone 4.**

```text
expense              -> source fact 'expense'           -> READER EXISTS -> posts
acquisition_cost     -> source fact 'acquisition_cost'  -> READER EXISTS -> posts
inventory_movement   -> source fact 'inventory_movement'-> READER EXISTS -> posts
shipment             -> source fact 'shipment'          -> READER MISSING
```

When this design was written, `posting_rules.source_fact_type` already admitted `acquisition_cost`, `inventory_movement`, and `shipment` while `packages/accounting/src/source-facts.ts` threw for all three. **The first two now have readers** ([Phase 5, milestone 4](../financial-schema-design/#milestone-4--cogs-posting-and-the-acquisition-seam)): a capitalized `acquisition_cost` debits `inventory` and credits the same owner-funded side an expense uses, and a `depletion_sale` movement debits `cogs` and credits `inventory` at the item's frozen basis — the shape this design assumed and could not rely on. `shipment` still has none.

The consequence this design had to state — that a literal reading of "expense capture always" was false for the largest category of a reseller's spend, because **money spent on goods did not reach the ledger at all** — no longer holds. It becomes cost basis, it now appears on the balance sheet as an inventory asset from the moment the cost is recorded, and it reaches the income statement as COGS when the item depletes. Two qualifications survive and matter:

- **The seam this design defined is what keeps the dollar single.** A `receipt` movement posts NOTHING, deliberately, because the capitalized acquisition cost already debited inventory; posting both would count one purchase twice. That is [the acquisition seam](#the-acquisition-seam-when-an-expense-is-really-a-purchase) enforced in arithmetic rather than in prose, and it is asserted by a test.
- **Inventory valuation is still not built.** A `disposal`, `shrinkage`, `adjustment_out`, or `consumption` movement posts nothing and enters the backlog with its reason, because the value of a write-off is a valuation judgement Phase 5 declined to form. Stock genuinely lost therefore remains on the balance sheet until that milestone exists, and a surface showing "inventory at cost" should still not be described as an audited figure.

**The dashboard's Money band gains nothing, deliberately.** The ask named it, so here is the answer rather than a deferral. The Money band reads `orders` and `order_fees`; the Financial band reads the ledger. Expenses reach the dashboard through the **Financial** band automatically, the moment the first one is recorded and posted. Acquisitions reach neither, for the reason above. Adding a spend tile to the Money band would be the first time that band read anything other than orders, would need its own currency and period policy, and — decisively — **would show an incomplete number**, because the largest component of a reseller's spend is exactly the component that does not post. The right time to revisit was named as "when COGS posting lands", and it has: acquisitions now reach the **Financial** band through the ledger like everything else, which is the reason to revisit the Money band's composition rather than to add a second incomplete spend total to it. Until someone does, `/inventory/overview` owns sourcing spend and `/finance/overview` owns expense spend, each labelled for what it is.

### Where the surfaces live

[Workspaces & Navigation](../../product/workspaces/) already reserves the route roots. This design follows them and adds no new ones.

```text
NEW  /finance      expenses list + detail, quick entry, receipts, the CSV import,
                   the missing-receipt and unallocated-expense reports.
                   (Named /finance and not /expenses because the workspace doc's map
                    already composes billing, expenses, payments, banking, accounting,
                    and tax there. Expenses are its first tenant, not its definition.)

NEW  /inventory    stock list + item detail (enrichment lives here), locations,
                   acquisitions list + lot detail with cost allocation, the intake
                   review queue, movements history, and the sourcing/aging/open-lot
                   read models that already exist and nothing renders.

NEW  /commerce     channel listings incl. manual, the draft-listing authoring surface,
                   catalog items. Orders move here from nowhere -- they have no
                   surface today either.

     /market       GAINS: the "I bought this" action; a "we bought one" panel on an
                   observed item showing the acquisition and its realized contribution.

     /settings     GAINS: the ebay_purchases sync toggle per connection (beside the
                   existing order-sync toggle); inventory media limits and MIME
                   allowlist as registered application settings; the document parser
                   backend selection, once a backend exists.

     /dashboard    GAINS NOTHING. See above.
```

Three new workspace roots is less work than it sounds, because the shell is data-driven: an entry in `src/config/workspaces.ts`, a `src/config/navigation/<id>.ts` nav group, and a guarded layout route each. The `add-workspace-surface` project skill encodes that path.

`/commerce` is the last of the three to arrive, and that ordering is deliberate: listings depend on enrichment, which depends on the inventory workspace existing.

### Cross-checked against Domain Boundaries

Every claim above, tested against the ownership document rather than assumed:

```text
claim                                        boundary check
-------------------------------------------  ---------------------------------------------
expenses surface in /finance                 OK. Costs and Expenses is a domain; /finance
                                             is a workspace. Rule 9: UI placement does not
                                             transfer ownership. The package stays
                                             @loxep/accounting.
listings surface in /commerce                OK. Catalog and Listings is the owning domain;
                                             the workspace composes it with Commerce, which
                                             the boundary doc explicitly permits.
documents own extraction, not the records    OK, and this is the doc's own wording. The
                                             confirm functions live in the consuming
                                             domains.
media owns the file; the domain owns the     OK. "Media knows how that file is identified,
meaning                                      stored, verified, and retrieved."
ebay_purchases registered against the        OK, and all three registration rules are
shared scheduler                             followed explicitly.
enrichment columns on inventory_items        OK. Inventory owns "inventory items/stock
                                             units". Weight and dimensions are physical
                                             facts about a unit.
package_* dims on the item, package weight   OK. Customer-paid shipping is Commerce; actual
on the shipment                              carrier cost is Shipping. Neither is the
                                             item's own measurement.
manual listings carry no economic entity     OK -- they carry the one channel_listings
beyond what the table already has            already has. No new attribution invented.
```

Two tensions surfaced rather than resolved, recorded in [Contradictions](#contradictions-and-tensions-found-in-existing-documentation) below.

### What stays out, to keep the build focused

Restated in one place because the owner asked for it: manual orders, COGS posting, bank and OFX import, vendors and purchase orders and AP, OCR and LLM parser backends, per-provider publish, a Loxep-owned aspect taxonomy, carrier integration and label purchase, consignment settlement, inventory valuation, a documents browser workspace, counterparties as acquisition vendors, and any change to the dashboard's composition.

Each of those has a named owner elsewhere or a named trigger for revisiting. None is deferred vaguely.

---

## Package ownership

Applying [Phase 6's proposed general rule](../services-billing-schema-design/#open-questions) — T1 exclusive tables, T2 an acyclic inbound edge or its own integration/worker surface, T3 survives a UI reorganization; C1 no split that needs a shared types package, C2 exactly one owning package per table.

```text
concern                        package                     T1   T2   T3   verdict
-----------------------------  --------------------------  ---  ---  ---  --------
documents + candidates         @loxep/documents (NEW)      yes  yes  yes  SPLIT
                               T2: accounting and inventory both depend on it to read
                               the queue; it depends on neither, because confirmation
                               is inverted. It also owns the parser-backend surface.
expense surfaces               @loxep/accounting           --   --   --   no change
inventory enrichment,          @loxep/inventory            --   --   --   no change
part-out, intake confirm,
ebay_purchases sync service
specifics table                @loxep/inventory            --   --   --   C2: one owner
listings, drafts, mapping      @loxep/commerce             --   --   --   no change
                               (Catalog still fails T2 on its own -- nothing depends on
                                catalog without commerce -- so it stays a module, which
                                is exactly what the rule reproduced for Phase 3.)
eBay WonList mapper            packages/integrations/ebay  --   --   --   no change
```

One new package. The rule's naming discipline holds: `@loxep/documents` after the domain, never `@loxep/parsing` after the mechanism.

`@loxep/documents` must take no dependency on `@loxep/accounting` or `@loxep/inventory` — the inversion is the whole point, and a cycle here would be C1's signal to merge, which would be wrong.

---

## Migration plan sketch

Ordering. All migrations run through `loxep migrate` under the existing advisory lock (ADR-0018).

```text
M1  (no migration)   expense surfaces only

M2  (no migration)   inventory + acquisition read/write surfaces over shipped services

M3  inventory enrichment
    1. alter inventory_items: description, sale_mode + CHECK, package_weight_grams,
       package_{length,width,height}_mm + CHECKs
    2. create inventory_item_specifics (+ unique, + index(name, value))
    3. no data migration; every existing row is valid under the defaults

M4  documents
    4. create documents          (media_objects, economic_entities, user)
    5. create document_line_candidates (documents, user)
    6. indexes: documents(status, created_at desc) partial where status <> 'confirmed';
       document_line_candidates(document_id, line_number) is the unique;
       document_line_candidates(row_fingerprint) partial where not null

M5  eBay purchases
    7. create unique index acquisitions_connection_external_ref_uq
         (partial; see 2a). NO column added to any Phase 4 table.

M6  listings
    8. alter channel_listings: add listing_code text (nullable first)
    9. backfill listing_code for existing rows
   10. alter channel_listings: listing_code set not null; add unique
   11. alter channel_listings: connection_id drop not null;
                               external_listing_id drop not null
   12. drop the old unique constraint; create the partial unique index
       (nulls not distinct, where external_listing_id is not null)
   13. add channel_listings_manual_connection_check
```

Steps 8–10 are the three-step nullable-backfill-notnull dance and must stay three steps; there is no safe single-statement form. Steps 11–13 must be one migration, because between dropping the `NOT NULL` and adding the `CHECK` there is a window in which a connection-less non-manual row is insertable.

Hand-written SQL is likely required for the partial unique index with `NULLS NOT DISTINCT` (step 12) and possibly for `num_nonnulls` in the dimension check. **Verify current Drizzle Kit capability at implementation time and drop to hand-written SQL rather than weakening any constraint** — the same instruction, and the same reason, as the three prior phase designs.

### Which existing tables gain columns

Unlike the three prior designs, this one does not claim "none". It claims *two, both additively, both argued*:

```text
inventory_items    6 columns, all nullable or defaulted. Argued in section 3.
channel_listings   1 column (listing_code) + 2 NOT NULL relaxations. Argued in 4a.
expenses           NONE. The expense work needs no schema at all.
acquisitions       NONE. One partial unique index, no column.
orders             NONE, emphatically. The manual-order question is OQ7 and is not
                   answered here.
marketplace_items / market_events
                   NONE, emphatically. Unchanged from Phase 4: our decisions must not
                   contaminate entity-neutral public-fact tables. The link points
                   inward.
media_objects / media_links
                   NONE. New resource_type and purpose values are text in application
                   code, not DDL -- the fourth phase to reach this conclusion.
economic_entities  NONE. ADR-0017 holds.
Better Auth        NONE. ADR-0020.
application_settings
                   New keys only, under inventory.* and documents.* prefixes: the media
                   size cap, the MIME allowlist, the default parser backend, the default
                   sale mode. No DDL.
```

---

## Open questions

Each is a genuinely unresolved decision with a recommendation, not a placeholder. **None is implemented.** Three are marked **OWNER-REVIEW-CRITICAL**: they are unrecoverable, or nearly so, after data exists.

1. **Is `/finance` the right home for expenses, or should expenses live in `/inventory` beside acquisitions?** The workspace map says Finance; the operator's mental model may say "where I record money", which for a reseller is next to the lot they just bought. *Recommendation: follow the workspace map and put expenses in `/finance`, with a quick-entry action available from the shell's command palette and from acquisition detail so the operator never has to navigate to record a spend.* Route roots are the expensive thing to change; an entry point is not.

2. **What does `expenses.acquisition_cost_id` mean?** It shipped as a real foreign key with no writer, and Phase 5's own no-copy rule forbids the reading it was presumably built for — a `capitalize = false` acquisition cost posts where it sits and is never copied into `expenses`. Three readings: (a) it is the supersession pointer, set on a **voided** expense that was re-recorded as a capitalized cost; (b) it is the copy the no-copy rule forbids; (c) it is dead weight and should be dropped. *Recommendation: (a), documented, and written by the void-and-promote path this design defines.* It gives the column a real writer, it makes the promotion auditable, and it contradicts nothing. (b) must be refused explicitly or the double-count returns. Dropping it is the fallback if the owner finds (a) a stretch of the column's name.

3. **Which receipt-parser backend does a self-hosted Loxep ship with?** **OWNER-REVIEW-CRITICAL.** Not because it is hard to reverse — it is the most reversible decision in this document — but because "may Loxep send photographs of the operator's financial documents to a third party" is a policy question that belongs to the owner. The options and their full costs are in [2b](#2b-receipt-and-invoice-parsing). *Recommendation: manual-assisted only in this phase; the interface defined so a backend is a registered provider; an LLM backend later as an explicitly configured, off-by-default provider with an encrypted credential; local OCR only if a real operator asks for it, because it costs image weight for every deployment including those that will never parse a receipt.*

4. **Does `sale_mode` belong on the item or on the listing?** A lot of forty Hot Wheels is a physical fact about how the stock is held *and* a decision about how it is offered, and those can differ — the same box could be listed whole this month and parted out next. *Recommendation: on the item, as designed.* It is what the operator decided about the goods, it drives basis distribution when a part-out happens, and it survives a listing ending. A per-listing override is additive on `channel_listings` if the two genuinely diverge in practice, and the concrete revisit trigger is the first operator who lists one item two ways at once.

5. **Should `channel_listings` reference an inventory item directly?** **OWNER-REVIEW-CRITICAL.** This design says no and mints a catalog item at listing time instead ([4b](#4b-the-bridge-to-loxep-managed-listing-authoring)). *Recommendation: mint the catalog item; zero migration; the chain closes with existing tables.* But it decides what a channel listing IS — a publication of a SKU, or a publication of a unit — and for one-of-a-kind resale the second reading is arguably truer. Getting this wrong is not fatal (adding `inventory_item_id` later is additive) but it will have produced a catalog item per listed unit by then, and those rows do not un-create themselves.

6. **Typed specifics: is `value_numeric` worth a column?** *Recommendation: yes, as a shadow of `value`, populated only on a clean parse, with nothing derived from it.* The alternative is a cast in every range query, which is both slower and unindexable. The risk is that it drifts from `value` if anything ever writes one without the other; the mitigation is that exactly one service writes specifics, which is the same single-writer argument that makes `quantity_on_hand` safe.

7. **How does a manual/offline listing record its sale?** **OWNER-REVIEW-CRITICAL.** `orders.connection_id` is `NOT NULL` and Phase 3 declined to create the manual path, naming both options: a synthetic connection, or a nullable column with `unique nulls not distinct`. *Recommendation: the nullable column, mirroring exactly what this design does to `channel_listings` — `connection_id` nullable, `provider = 'manual'`, `source_account_key = 'manual:<installation>'`, the existing unique widened to `NULLS NOT DISTINCT`, and a `CHECK` tying the two states together.* The symmetry is the argument: the same wall, the same shape, the same answer, applied twice. But `orders` carries every financial figure in the installation and this design deliberately does not touch it, so the decision is the owner's. **Until it is made, the manual-listing loop ends at "listed" and cannot report a realized outcome**, and any milestone that ships manual listings must say so on the surface rather than showing a zero.

8. **Should a CSV import row's fingerprint ever become a constraint?** *Recommendation: no — warn, never block,* consistent with `orders`' detect-don't-constrain answer. Two identical coffees on one day are a real thing that happens. Revisit only if operators report duplicate expenses in practice, which is a concrete trigger rather than a vague later.

9. **Where does an ingested purchase's shipping cost go when the operator marks the line `supplies`?** The acquisition holds `inbound_freight` for the whole order; if two of five lines become stock and three become supplies, the freight belongs partly to each. *Recommendation: leave the freight on the acquisition and allocate it only across the lines that became stock, with the remainder recorded as `capitalize = false` on the same acquisition.* It keeps the evidence together, it uses a mechanism that already exists, and it refuses to invent a freight-splitting policy nobody asked for. Flagged because it is the kind of thing that silently overstates basis if done the naive way.

10. **Does `documents` need a `parsed_text` column before a backend exists?** *Recommendation: no.* Adding it now ships an always-null column and an implicit claim that Loxep extracts text. It is additive when a backend that produces text arrives.

---

## Contradictions and tensions found in existing documentation

Recorded for a human to resolve; this document does not attempt to fix them.

1. **`expenses.acquisition_cost_id` exists and Phase 5's own rule forbids its apparent purpose.** *(**Partly answered since**: Phase 5's milestone 4 gave the column its first READER, on reading (a). The `acquisition_cost` source-fact reader links the expense that names a cost as a `journal_entry_source_links` row with role `evidence`, so a promotion is visible from the ledger side. Nothing yet WRITES it — the void-and-promote path this design defines is still the writer that has to exist — so the contradiction is narrowed rather than closed. The original text follows.)* [Phase 5](../financial-schema-design/#expenses-and-receipts) states that non-capitalized acquisition costs *"are not copied into `expenses`"* and posts them where they sit — and the same design's `expenses` sketch carries a foreign key to `acquisition_costs`, which migration 0006 made real. Nothing writes it. Either the column has the supersession meaning this design proposes (OQ2), or it is a leftover from the copy the design rejected. This is the clearest live contradiction between two shipped decisions in the documentation.

2. **Documents is a defined domain with no phase, no tables, and no owner.** [Domain Boundaries](../domain-boundaries/#documents) has specified it since the foundation — receipts, bills, POs, contracts, OCR text, structured extraction, matching status — and no roadmap phase claims it. [Master Domain Map](../../product/master-domain-map/) section 12 lists OCR and structured extraction under DESIGN-FOR. This design gives it two tables and a package because ask 2b requires them; the roadmap should say where the rest of the domain lives, or say that Documents is deliberately incremental. *(**Resolved since**: M4, loxep-dgf.4, gave Documents its first owner — `@loxep/documents`, migration 0017. `parsed_text`/OCR extraction and the rest of Domain Boundaries' Documents list stay unclaimed, and remain deliberately incremental rather than scheduled — no roadmap phase claims them yet.)*

3. **"Product costs/sale prices" under Commerce in the domain map, versus enrichment on the stock row.** Phase 3 already recorded this tension for cost basis and took the narrow reading. This design adds a second half to it: description, images, and specifics are catalog-shaped attributes that this design places on `inventory_items` because the catalog item is usually unresolved. The domain map bullet should distinguish "SKU-level product attributes (Catalog)" from "unit-level physical attributes (Inventory)", or an implementer reading it will build the specifics table against `catalog_items` and find it unusable at intake.

4. **Phase 4's "no existing table gains a column" reads as a permanent rule and was scoped to Phase 4.** Its forward-looking test — every arrow into a future phase is a reference added later, not a rewrite — is the one that governs later phases, and the two are easy to conflate. Phase 4's wording should distinguish "Phase 4 alters nothing" from "nothing may ever alter these tables", because this design alters `inventory_items` and believes it is within the rule.

5. **`channel_listings` is fully designed, fully constrained, and completely unused.** `createCatalogService` has no caller outside its own test; the eBay and Woo order syncs never write a listing; `order_lines.channel_listing_id` is populated by nothing. The Phase 3 design's careful `channel_listings`-versus-`marketplace_items` argument has therefore never met a real row. The two `NOT NULL`s this design relaxes are exactly the kind of thing that is trivially cheap now and expensive after the first thousand ingested listings — which is an argument for deciding OQ5 and OQ7 sooner rather than later, not for deciding them here.

6. **Phase 4's design counts nine commerce tables where ten shipped.** A miscount in [Commerce Schema Design](../commerce-schema-design/)'s scope bullet — the list itself omits nothing and the "what shipped" block says ten. Harmless, and worth correcting while someone is editing the file.

7. **The roadmap's "Later directions" already names "document/OCR workflows" and "direct listing synchronization"**, both of which this phase begins. Either those entries move into this phase's section, or the section says which half of each it delivers. The bullet as written invites an implementer to conclude that neither is scheduled.

---

## Before implementing this design

1. **Decide OQ3, OQ5, and OQ7 with a human before the milestone that depends on each.** OQ3 gates the parser milestone's shape; OQ5 gates the listing milestone's schema; OQ7 gates whether the manual-listing milestone can honestly claim to close the loop. None of the three is discoverable by an implementer.
2. **Read the applied migrations, not this document, before writing any foreign key or column.** Migrations 0003, 0005, and 0006 are the authority for column names; three prior designs have diverged from their own drafts in ways that changed downstream reads.
3. **Verify current Drizzle Kit support** for a partial unique index with `NULLS NOT DISTINCT`, `num_nonnulls` checks, and the three-step nullable-backfill-notnull sequence; fall back to hand-written SQL rather than weakening any constraint.
4. **Re-verify the eBay `GetMyeBayBuying` `WonList` request and response shape against eBay's current published documentation** before fixing the mapper, and treat the mapping as unverified until a production account has run it. The sandbox cannot confirm it; that is recorded, reproduced, and dated in `watchlist.ts`.
5. **Write the confirmation idempotency tests before the confirm code**: the same document confirmed twice, a partially confirmed document re-opened, a candidate confirmed into an acquisition that was subsequently cancelled, and a CSV re-imported in full. All against real PostgreSQL.
6. **Write the never-auto-commit test first** — a parse result must be provably unable to reach `expenses`, `acquisitions`, or `inventory_items` without an actor user id. It is the invariant everything in section 2b assumes.
7. **`@loxep/inventory` has no runtime consumers today.** The first milestone that wires it must also register it in `apps/web/src/server/admin.ts`'s memoized service registry, and must check whether the package pulls `@loxep/jobs` transitively — if it does, the import needs the `@vite-ignore` dynamic-import treatment `@loxep/storage/migration` already gets.
8. **`packages/db/src/schema/inventory.ts` declares no Drizzle `relations()`**, so relational `with:` joins are unavailable for every inventory table. Read models must be explicit joins, which is what the shipped `profitability.ts` already does.
9. **Do not loosen the avatar serving route's `metadata.purpose` gate** to serve inventory images. It exists so the endpoint cannot become a generic media fetcher, and that is correct. Inventory images get their own route and their own gate.
10. **Keep provider SDK types at the integration boundary** (ADR-0009). Nothing in `@loxep/inventory`, `@loxep/documents`, or `@loxep/commerce` may be typed from `ebay-api`, and the `EbayPurchaseFact` shape crosses as a Loxep-owned structural type exactly as `EbayOrderFactLike` already does.
11. **Update this document, the roadmap, Workspaces, and Domain Boundaries when implementation reality diverges**, rather than letting the documentation drift.

## Milestones

Staged so each is independently shippable and the first needs no migration. Dependencies are real, not procedural.

```text
M1  Expense capture                   no migration. /finance workspace, expenses list +
                                      detail, quick entry, receipt upload + gallery,
                                      missing-receipt and unallocated reports. Lights up
                                      the already-wired posting pipeline.

M2  Inventory workspace               no migration, none needed. IMPLEMENTED, including
                                      writes: apps/web/package.json gained the
                                      @loxep/inventory dependency line this milestone's
                                      status paragraph once called "not yet done" --
                                      inventory-functions.ts now calls the real
                                      createAcquisitionsService/createItemsService.
                                      Stock list, item detail, locations, acquisitions +
                                      lot detail + a cost allocation UI, movements, and
                                      the /market handoff -- all reading and writing real
                                      data via @loxep/inventory.

M3  Enrichment                        migration. Depends on M2. Description, sale_mode,
                                      package dims/weight, specifics, images, part-out.

M4  Documents and intake review       migration. Depends on M2 (a confirm target must
                                      exist). IMPLEMENTED for its manual-assisted scope:
                                      documents + candidates, the manual-assisted parser,
                                      CSV expense import at /finance/import, and
                                      confirmLinesAsExpense (apps/web-layer, since
                                      @loxep/accounting/@loxep/inventory confirm
                                      functions were outside this milestone's write
                                      fence -- see 2b's implementation-status note).
                                      acquisition_cost/inventory_intake confirm actions
                                      are NOT shipped (need an acquisition-lot picker).

M5  eBay purchase ingestion           migration (one index). Depends on M4 (candidates
                                      land in its queue). WonList mapper, ebay_purchases
                                      target type, the sync service, the connection
                                      toggle.

M6  Listings                          migration. Depends on M3 (the mapping needs the
                                      enrichment fields). /commerce workspace, manual
                                      channel listings, the inventory-to-draft mapping,
                                      draft authoring. Gated on OQ5 and OQ7.
```

The `/market` handoff ("I bought this") rides on M2, because that is the first milestone in which there is an acquisition intake surface to hand off to.

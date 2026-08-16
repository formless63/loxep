---
title: Expense Entry and Document Intelligence Design
---

This document designs the second generation of expense capture: a dedicated entry page with a multi-file drag-and-drop attachment pane, counterparties as expense payees, receipt line items as a first-class record, and the self-hosted OCR question answered with a survey rather than a shrug. It is the direct successor to [Flipping Lifecycle Design (Phase 9)](../flipping-lifecycle-design/) sections [1](../flipping-lifecycle-design/#1-expense-capture-always) and [2b](../flipping-lifecycle-design/#2b-receipt-and-invoice-parsing), which shipped the surfaces this page rebuilds, and it inherits every rule those sections set.

**Status: DRAFT. Design work only.** No migration, Drizzle schema, package, or service code is authorized by this page. Upstream OCR facts were verified against primary sources on **2026-08-15** and must be **re-verified immediately before implementation** per the [dependency policy](../../development/dependency-policy/) — this is the fastest-moving software category in any Loxep survey to date.

**Status update: `M2` (the entry page) is IMPLEMENTED (loxep-cd3.2).** `/finance/expenses/new` is the real two-pane page, `/finance/expenses/quick` carries the redirect moved verbatim, `<DocumentPreview>` is shared by the evidence pane and `document-review-panel.tsx`, `documents.media_limits` is a registered setting consumed by both upload routes, and the serving-URL mapper (`servingUrlFor`, `@/server/media-serving-url.ts`) fixed the trap this page called out. See [its own milestone note](#milestones) below for what shipped and what did not (`expense_lines`/OCR/the acquisition confirm path stay M3 and later). This sentence and the "DRAFT" one above are left in place per this document's own convention of recording status updates next to the original text rather than rewriting it.

**Status update: `M3` (expense lines + one confirm function) is IMPLEMENTED (loxep-cd3.3).** Migration 0025 shipped `expense_lines` exactly as section 4 specifies, including the partial unique index on `document_line_candidate_id`. `apps/web/src/server/documents-functions.ts`'s `confirmLinesAsExpense` moved DOWN into `@loxep/accounting` as `confirmCandidatesAsExpense` (`packages/accounting/src/confirm.ts`), taught to accept an existing `expenseId` as well as creating one — `/finance/import`'s document review and `/finance/expenses/new`'s save action call the SAME function, and the documents-review confirm now writes ONE expense with N `expense_lines` rows (one per confirmed candidate) instead of N separate expenses, closing the duplicated write path this section's "reconciling the two flows" subsection describes. A new `@loxep/accounting/lines.ts` (`ExpenseLinesService`) owns `setLines`/`addLine`/`removeLine`/`listLines`/`lineSummary`, enforcing the over-transcription guard (`sum(|line_amount|) <= |expenses.amount|`) as a service rule exactly as specified. `/finance/expenses/new` gained an optional in-form line-items array (`form.Field mode='array'`, the part-out-dialog precedent) and expense detail renders lines with their own add/remove (the specifics-editor precedent, since the expense already exists there). **One deliberate deviation from the package-ownership table below:** `packages/accounting/package.json` still does NOT depend on `@loxep/documents` (out of this pass's write fence, same as `apps/web/package.json`'s own still-open gap) — `confirm.ts` reads/writes `documents`/`document_line_candidates` directly through `@loxep/db`'s schema (a dependency this package already has), reproducing `stampConfirmed`/`recomputeDocumentCounters`/the `document_confirmed` notification inline rather than calling `@loxep/documents`'s services; its module doc names the exact functions to replace once that edge is authorized. The drag-to-field UI that would populate flow 2's `candidateIds` does not exist yet (M5), so `createExpenseWithEvidence` does not currently call `confirmCandidatesAsExpense` — the function is built and tested (`packages/accounting/test/confirm.test.ts`) for M5 to wire up.

**Status update: `M4` (OCR tier A) is IMPLEMENTED (loxep-cd3.4).** `packages/documents/package.json` gained its one authorized third-party addition, `tesseract.js@7.0.0` (Apache-2.0, matching the survey's pinned/re-verified version exactly), plus a vendored `assets/tessdata/eng.traineddata.gz` (~2.95 MB, the same `4.0.0_best_int` LSTM-only asset tesseract.js's own CDN fallback would otherwise fetch) so `langPath` resolves offline with no egress. `tesseract-parser.ts`'s `ocr_tesseract` `ReceiptParser` implements every operational binding this milestone's issue called LAW: a module-level singleton worker created once and reused (tested by asserting the worker factory is called exactly once across repeated `parse()` calls); ONE `recognize()` call requesting `text`+`tsv`+`hocr` together (tier B's coordinates are therefore already being produced by every M4 run, unread until M5); Sauvola thresholding (`thresholding_method=2`) applied per the design's own "try this before building a preprocessing pipeline" ordering; `OMP_THREAD_LIMIT` documented as a no-op for WASM rather than cargo-culted. `pdf-text-layer.ts` wraps `pdftotext - -` (argv array, stdin/stdout, never a shell string) for the existing-text-layer path, degrading to an honest `available: false` where poppler-utils is not installed — true everywhere as of this pass, since no Docker change was in its write fence. A gated measurement script (`scripts/measure-ocr-accuracy.ts`, not wired into `bun test`) reports word count/confidence/CER against real receipts the owner supplies, per the milestone's own "measure first, be prepared to stop" instruction — it has not yet been run against real paper (still outstanding; not gating).

**The storage/search half (migration 0026), completed this pass.** `documents.parsed_text text null` plus `parsed_text_tsv tsvector generated always as to_tsvector('simple', coalesce(parsed_text,'')) stored`, plus a GIN index, landed exactly as this section's own DDL sketch specifies (`packages/db/migrations/0026_document_parsed_text_search.sql`) — drizzle-kit@0.31.10/drizzle-orm@0.45.2 emit the `GENERATED ALWAYS AS (...) STORED` DDL correctly from a `customType` `tsvector` column whose `.generatedAlwaysAs()` callback references the table's own `parsedText` column via closure (the column object does not exist until the enclosing `pgTable()` call returns, so the callback captures the exported table binding rather than a column reference passed in directly), so no hand-written fallback (the 0019 precedent) was needed. `documents.ts`'s `recordParseResult` now writes `parsed_text` in the same `update documents ...` statement that already sets `parser_id`/`parsed_at`. A `documents.extract-text` Graphile Worker task (`packages/app/src/documents-extraction.ts`, wrapping `runDocumentTextExtraction`) is registered in `registry.ts` and enqueued transactionally — in the SAME transaction that inserts the `documents` row — from `apps/web/src/server/documents-media.ts`'s `handleDocumentUpload`, reached through the existing `getFleetModule()` dynamic-import seam (no `apps/web` → `@loxep/app` static dependency). **The `@loxep/storage` gap closed in the same session, as a same-day follow-up.** `@loxep/app`'s `package.json` now declares `@loxep/storage` as a dependency, and `documents-extraction.ts`'s `createDefaultParserRegistry` builds a real `MediaService` the same way `apps/web/src/server/admin.ts`'s `getMediaService()` does (`createStorageBackendsService({ db, keyring })` then `createMediaService({ db, backends })`), so `registry.ts`'s composition now runs `ocr_tesseract` for real — an uploaded receipt image is actually OCR'd once an operator sets `documents.parser_id = "ocr_tesseract"`. A registry gap remains possible only in principle (a caller-supplied override, or a storage-layer failure resolving one specific media object/backend); both still degrade to a recorded `documents.status = 'failed'` plus a note rather than a crash or a silent no-op — see `documents-extraction.ts`'s own module doc. Proven end to end against real PostgreSQL and a real tesseract.js run: `packages/app/test/documents-extraction.test.ts` uploads `@loxep/documents`' own synthetic-receipt PNG fixture through a real `MediaService`, runs the task through the unmodified default registry, and asserts the recognized text lands in `parsed_text` and is found via `parsed_text_tsv`. The search surfaces (`/finance/import`'s `q` filter on the document queue, `/finance/expenses`' "search receipt text" `q` filter joining `media_links`/`media_objects`/`documents`, and the expense-detail `ts_headline` snippet gated on arriving from a search) all ship using `websearch_to_tsquery('simple', ...)`, matching `parsed_text_tsv`'s own config. The snippet is rendered WITHOUT `dangerouslySetInnerHTML` — `ts_headline` is asked for non-HTML match markers (the ASCII SOH/STX control characters) and the client splits on them and renders a real `<b>` element itself, since `parsed_text` is untrusted OCR output from an operator-uploaded document. Round-trip proven against real PostgreSQL: `packages/documents/test/documents.test.ts` (`recordParseResult` → `parsed_text` → `parsed_text_tsv @@ websearch_to_tsquery` finds a synthetic receipt's brand/model text) and `packages/app/test/documents-extraction.test.ts` (the same, through the real worker task); a live end-to-end check against the built app additionally confirmed the transactional enqueue and the real `documents.extract-text` task run on a genuine upload.

**Status update: `M5` (OCR tier B — highlight overlay and drag-to-field) is IMPLEMENTED (loxep-cd3.5).** `document_line_candidates.source_region` is populated for the first time (`@loxep/documents`' `tsv-lines.ts` groups tesseract's `tsv` word rows into per-line boxes from the SAME `recognize()` call M4 already made; `source-region.ts` fixes the serialization format the "contradictions" section below flagged as unfixed). `<DocumentPreview>` gained an image-only `overlay` mode (percentage-of-natural-size boxes, no letterboxing, no pixel math), draggable via `@dnd-kit/core` (the sanctioned library; no hand-rolled `dataTransfer` handling), with an always-present "Detected lines" list as the keyboard/click floor. `/finance/expenses/new` wires drop targets for every header/line field (pure UI, stamps nothing) plus a separate "from a receipt" drop zone that pins a candidate-linked line; `createExpenseWithEvidence` now calls `confirmCandidatesAsExpense` for real (M3's own "no caller yet" is resolved), bumping a dropped candidate's `disposition`/`line_amount` and stamping it in the SAME transaction as the expense — never before, never outside it. `pdfjs-dist` was NOT added (a new `apps/web` dependency this pass's write fence does not authorize), so the PDF preview stays M2's iframe with no overlay — a recorded gap, not a silent one, and inert today since no backend produces PDF-line boxes either. See [its own milestone note](#milestones) for the full account, including the amount-extraction-on-drop rule and the e2e coverage against a real OCR run.

**Status update: `M1` (trading partners as payees) is IMPLEMENTED (loxep-cd3.1).** Migrations 0023 (`counterparty_contacts.given_name`/`family_name`) and 0024 (`expenses.payee_counterparty_id`, FK `expenses_payee_counterparty_fk`, partial index) shipped. `@loxep/accounting`'s `ExpensesService.create`/`update` accept `payeeCounterpartyId` and always snapshot the resolved `display_name` into `payee_name` in the same write; a new `ExpensesService.linkPayee` deliberately bypasses the draft-only lock for the "link this payee" action, matching `reattributeDefaults`' own narrow-bypass precedent. The Invoice Ninja client push (`@loxep/integration-invoiceninja`) is widened to the full mapping table below, including two source-verified static id maps (`id-maps.ts`) and `mapCounterpartyContactForPush`'s given/family-name-with-fallback rule; `private_notes` stays opt-in per push (`pushDraftInvoice`'s `includePrivateNotes`, default `false`). The picker (`PayeeComboboxField`, `apps/web/src/features/finance/components/payee-combobox-field.tsx`) is mounted on the quick-entry dialog and wired to "link this payee" on expense detail — **not yet mounted on `/finance/expenses/new`**, which M2 shipped with the payee field "plain text pending M1's picker" per its own milestone note above; wiring the now-available picker into that page is the natural next step. One honest gap: `@loxep/counterparties` (the real domain service — `create`/`contacts.addContact`/`roles.grant`/`listByEntityRole`) is still not an `apps/web` dependency, so the picker's search and inline-create server functions (`@/server/trading-partner-functions.ts`) talk to `@loxep/db` directly with a small amount of intentionally-duplicated logic (reference-code generation, a lightweight name fold) — see that file's own module doc for the full account and why wiring the real dependency in is follow-up work, not this bead's.

**This design is cross-cutting, not a phase.** Phase 9 is fully implemented; this is the pass that makes its expense surface usable by a human with four receipts and a phone, and it depends on no unshipped phase.

## What already exists, precisely

Naming it first, because roughly half of what the owner asked for is already in the database and merely unreachable from the UI.

```text
SHIPPED AND USED
expenses / expense_allocations       migration 0006, full @loxep/accounting service
media_links receipts                 resource_type='expense', purpose ∈ {receipt,
                                     invoice, supporting_document} — many per expense
                                     ALREADY, one object across many resources ALREADY
documents / document_line_candidates migration 0017, @loxep/documents, the parser
                                     registry, the manual parser, CSV staging
counterparties + contacts +          migration 0006 and 0011: parties, contacts,
channels + sites + entity roles      channels, addresses, per-entity roles with
                                     payment terms and billing site
Invoice Ninja adapter                @loxep/integration-invoiceninja: clients and
                                     invoices, on-demand draft push
react-dropzone 20.1.0                a complete multi-file FileUploader component
                                     with previews and progress, wired into
                                     useAppForm as FileUploadField — used by the
                                     donor product form and by NOTHING in /finance

SHIPPED AND UNREACHABLE
document_line_candidates.source_region   the per-line rectangle the drag-to-field
                                         pane needs. Nothing writes it and nothing
                                         reads it, because the only parser is manual.
dispositions acquisition_cost /          selectable in the review UI, confirmable
inventory_intake                         nowhere — no lot picker was built
counterparty roles vendor / payee        granted by nobody; no expense references a
                                         counterparty at all

NOT SHIPPED
any expense line item                    expense_allocations is a MONEY SPLIT, not a
                                         list of what was bought — see section 4
any OCR                                  documents has no parsed_text column, on
                                         purpose (Phase 9 OQ10)
any drag-and-drop in /finance            the receipt control is a hidden file input
                                         behind a button, single file, no preview
```

The load-bearing consequence: **this design adds four small migrations and one new table, and spends most of its length on rules rather than schema.** If an implementer finds themselves designing a party model, a media model, or a candidate-staging model, they have missed something that already exists.

## Conventions inherited

Unchanged and restated because every section below leans on them:

- **Money is `numeric(20,6)` in PostgreSQL and a decimal string in TypeScript.** Never a JS `number`, never `parseFloat`. `@loxep/accounting`'s `decimal.ts` is the arithmetic.
- **Domain states are text + TypeScript unions.** A Loxep-owned closed set earns a `CHECK`; an operator's open vocabulary (`expenses.category`) does not get one.
- **Recorded is a lock.** `draft` is the only mutable expense state; the correction path is void-and-re-record with a reason. No surface may offer an edit the service will refuse.
- **Attribution is a snapshot with three rungs** — `manual`, `installation_default`, `unattributed` — resolved once at creation. An empty entity picker means `unattributed` deliberately.
- **Detect, do not constrain.** Duplicate receipts and duplicate CSV rows warn; they never fail a write.
- **A parse is never a fact.** [Section 2b's](../flipping-lifecycle-design/#2b-receipt-and-invoice-parsing) three non-negotiables bind everything in sections 3, 4, and 5 of this page.

## The falsifiable marker

In the shape [Phase 8](../fleet-observability-design/) and the [companion survey](../knowledge-tasks-integration-design/) used, this design's single testable claim:

> **No machine ever creates a counterparty, an expense, an expense line, an acquisition, or an inventory item. Extraction produces candidates; a human with a session produces records.**

If a Graphile Worker task, an OCR job, an order sync, or an Invoice Ninja pull can insert a `counterparties` row or an `expenses` row, this design has been violated regardless of what any other section says. The enforcement mechanism is the one Phase 9 already built and proved: **a confirm function requires a non-null `actorUserId`, and a background job has no session.** Section 2 extends the same enforcement to party creation, which is the place it is most tempting to skip.

---

## 1. The expense entry page

### The route, and what happens to quick entry

```text
/finance/expenses/new     TODAY  a redirect-only route that lands on
                                 /finance/expenses?quickEntry=true
                          AFTER  the real full-entry page

/finance/expenses/quick   NEW    the redirect-only route, moved here verbatim.
                                 It exists for one narrow reason documented in
                                 config/navigation/finance.ts: the command
                                 palette lists nav items by plain `url: string`,
                                 and TanStack Router resolves that as a PATHNAME
                                 — it will not parse an embedded ?search. A tiny
                                 route issuing redirect({ to, search }) is the
                                 only way a search-param destination is
                                 Cmd+K-reachable.

/finance/expenses?quickEntry=true
                          TODAY  the one-screen QuickExpenseDialog
                          AFTER  unchanged, and it stays forever
```

The Finance nav group therefore carries **two** entries where it carries one today — `Quick expense` → `/finance/expenses/quick` and `New expense` → `/finance/expenses/new` — because both must be palette-reachable and neither is a mode of the other. Repointing the existing entry and deleting the redirect route would make the fast path unreachable from Cmd+K, which is the one place it is most used.

**Both survive, and the split is not a compromise.** [Phase 9 section 1](../flipping-lifecycle-design/#quick-entry-is-the-dominant-path-and-it-must-be-one-screen) fixed the design target as *"a reseller standing at a thrift-store counter with a phone. Everything else is a rounding error on that."* That target is not served by a two-pane page, and replacing the dialog with one would be a regression disguised as a feature. The page serves a different, equally real moment: the operator at a desk with an inbox of PDF invoices and a stack of receipts, composing one expense from evidence.

The rule that keeps them from diverging:

> **The dialog is capture. The page is composition. They write the same records through the same service, and the dialog never grows a second column.**

Concretely: the dialog keeps its eight fields, its single optional photo, and its one-round-trip `status: 'recorded'` save. It gains exactly one thing — a **"More options"** link that navigates to `/finance/expenses/new` carrying whatever has been typed as search params, so an operator who starts fast and discovers the receipt has fourteen lines is not retyping. The palette keeps a dedicated entry pointing at the dialog; the page does not inherit the dialog's shortcut.

### Layout

```text
+-------------------------------------------+-----------------------------------+
| ENTRY                          (form)     | EVIDENCE                  (pane)  |
|                                           |                                   |
|  Payee      [counterparty combobox    v]  |  +-----------------------------+  |
|             + New trading partner         |  |   drop files here, or       |  |
|  Date       [2026-08-15             ]     |  |   click to choose           |  |
|  Amount     [           1,248.40    ]     |  +-----------------------------+  |
|  Tax        [              98.40    ]     |                                   |
|  Category   [supplies             v ]     |  [thumb] receipt-1.jpg    ok      |
|  Payment    [card                 v ]     |  [thumb] invoice.pdf     ok  x    |
|  Currency   [USD]  Entity [Acme LLC v]    |  [thumb] packing.jpg  scanning    |
|  Notes      [                      ]      |                                   |
|                                           |  +-----------------------------+  |
|  LINES                            (4)     |  |                             |  |
|  1  Shelving unit    2 x 89.00  178.00    |  |      selected file          |  |
|  2  Packing tape    12 x  3.20   38.40    |  |      preview                |  |
|  3  Sales tax                    98.40    |  |                             |  |
|  + Add line                               |  |   (image: inline)           |  |
|                                           |  |   (pdf:   embedded viewer)  |  |
|  ALLOCATIONS                      (0)     |  +-----------------------------+  |
|  + Split this expense                     |                                   |
|                                           |  EXTRACTED LINES        (tier B)  |
|  [ Save as draft ]  [ Record expense ]    |  drag a line into LINES, or       |
|                                           |  into a field above               |
+-------------------------------------------+-----------------------------------+
```

Binding layout rules:

- **The evidence pane is the right column on desktop and the second section on mobile.** It is never a modal, never a separate route, and never a tab — the entire point of the owner's ask is that the receipt and the fields are visible at once. Below the `md` breakpoint the two stack, form first, because a phone operator is in the capture case anyway and should probably have used the dialog.
- **The form is `useAppForm`.** Not a raw `<Input>` plus `useState` anywhere, per [Frontend Standards](../../development/frontend-standards/#forms). Lines are a `form.AppField` array, not a parallel `useState` list.
- **The lines list and the allocations list are visibly different things and are never merged into one control.** Section 4 explains why; the UI must not imply otherwise by stacking them under one heading.
- **Semantic tokens only.** The dropzone's active state is `border-primary`/`bg-accent`, never a literal colour, and the whole pane must survive a theme switch — this is the surface most likely to be built with a `gray-200` dashed border out of habit.

### The dropzone reuses the component that already exists

`apps/web/src/components/file-uploader.tsx` is a complete react-dropzone (20.1.0, exact-pinned) implementation with controllable `File[]` value, `onUpload` progress, `URL.createObjectURL` previews with revoke-on-unmount, per-file removal, and `formatBytes`. It is used by exactly one thing today — the donor product form, via `FileUploadField`.

> **Rule: no new dropzone is written.** `FileUploader` is configured (`multiple`, `maxFiles`, `accept` including `application/pdf`, `maxSize` from a registered setting) and consumed. If it needs a change, the change lands in the shared component so the donor form and the expense page cannot drift.

The defaults it ships with (`maxFiles = 1`, `accept: {'image/*': []}`, `maxSize = 2 MB`) are wrong for this surface and are passed as props, not edited in place.

### Upload order of operations, which is the real design question here

An operator drops four files before typing anything. There is no expense yet, and `POST /api/expenses/receipt` requires an `expenseId`. Three options:

```text
(a) CREATE A DRAFT ON FIRST DROP        (b) UPLOAD AS DOCUMENTS         (c) HOLD IN THE BROWSER
    then upload against it                  then link on save               upload on save

    no route changes                    no route changes                no route changes
    an abandoned page leaves a          the pane IS the documents       no server round trip
      draft expense behind                pipeline; OCR can start         until the operator
    the expense exists before the         the moment bytes land           commits
      operator has decided anything     one media object, two           no preview of a PDF
    reference codes burned on            references, zero copies          without a local
      abandoned drafts                  needs one thin server            object URL
                                          function to link an           no OCR before save,
                                          existing media object           so tier B is dead
```

**Recommendation: (b).** Each dropped file posts to the existing `POST /api/documents/upload`, which already accepts a bare file plus a `documentKind`, writes a `media_objects` row with `metadata.purpose = 'document'`, and creates the `documents` row (`source_kind = 'upload'`, `status = 'pending'`). That is exactly the record OCR needs, and it means the expense page's attachment pane and `/finance/import` are **the same pipeline entered from two directions**, which is the property section 3 depends on.

On save, the expense is created and each uploaded media object is attached with `ReceiptsService.attach({ expenseId, mediaObjectId, purpose })` — which already exists, already absorbs `23505`, and already takes a media object id rather than a file. The only new server function is the thin wrapper that calls it for a list of ids inside the create transaction.

(a) is rejected because a reference code (`EXP-2026-0231`) is a human-visible identifier and burning a sequence on an abandoned page is the kind of small ugliness operators notice. (c) is rejected because it forecloses every tier of section 3.

### The serving-URL rule, which is a real trap

Media serving routes are single-purpose by deliberate design, and [Phase 9's rule 9](../flipping-lifecycle-design/#before-implementing-this-design) forbids loosening a gate so one endpoint can serve another purpose. Today:

```text
/api/media/receipt/:id      404s unless media_objects.metadata.purpose = 'receipt'
/api/media/document/:id     404s unless metadata.purpose = 'document'
/api/media/inventory/:id    404s unless metadata.purpose = 'item_image'
/api/media/avatar/:id       404s unless metadata.purpose = 'avatar'
```

Uploading through the documents route stamps `'document'`, but `receipt-media.ts` builds `servingUrl` as `'/api/media/receipt/' + id` unconditionally — so an expense whose receipt arrived through the new pane would render a broken image on the detail page.

> **Rule: the serving URL is derived from `media_objects.metadata.purpose`, not from the resource the link hangs on. No purpose gate is widened.**

One small mapper (`servingUrlFor(purpose, mediaObjectId)`) in the web layer, consumed by every DTO that returns a `servingUrl`. This is three lines and it is the difference between four honest single-purpose endpoints and one that has quietly become a generic media fetcher.

### Previews: what a no-external-CDN app can actually render

This deserves an honest answer rather than a wish.

```text
kind            tier-1 answer                          cost        verdict
--------------  -------------------------------------  ----------  ----------------------
image/png       <img src={servingUrl}>                 zero        ships now
image/jpeg      same, object-fit contain, max-h        zero        ships now
image/webp      same                                   zero        ships now
application/pdf <iframe src={servingUrl}> — the        zero        ships now, with a
                browser's own PDF viewer, same                     documented caveat
                origin, session-cookie gated
application/pdf server-rendered first-page thumbnail   poppler or  REJECTED for tier 1
                                                       mupdf in
                                                       the image
application/pdf pdfjs-dist canvas + text layer         ~4 MB npm   ONLY when tier B lands
```

The `<iframe>` answer is unglamorous and correct. Chrome, Firefox, and Safari all render `application/pdf` natively; the URL is same-origin and behind `requireSession`, so no CSP or credential problem arises; and it costs nothing in the image or the bundle. Its caveats must be stated on the surface rather than discovered: the operator gets the browser's chrome rather than Loxep's, and **you cannot draw a highlight box over a browser-native PDF viewer**, which is exactly why tier B needs `pdfjs-dist` and tier 1 does not.

A server-side thumbnail is refused on the argument [section 2b already made about OCR binaries](../flipping-lifecycle-design/#backends-the-options-and-the-recommendation): it adds weight to the one Loxep image for every deployment, including the ones that will never attach a PDF.

Also fixed here, because it is a live bug rather than a new feature: `apps/web/src/features/documents/components/document-review-panel.tsx` renders every document with a bare `<img src={mediaServingUrl}>`, and `application/pdf` is an accepted upload kind on that route. **The review panel and the expense pane must share one `<DocumentPreview mimeType servingUrl />` component**, so the PDF case is fixed once.

### Upload limits become a registered setting

`receipt-media.ts` and `documents-media.ts` both hardcode `10 * 1024 * 1024` and a four-member MIME allowlist, and both note in their own comments that they decline the registered-setting pattern `inventory-media.ts` uses. A page whose headline feature is dropping many files at once is the moment that stops being acceptable.

> Add `documents.media_limits` to `@loxep/domain/settings-defaults.ts`, mirroring `inventoryMediaLimitsSetting` exactly (`{ maxBytes, allowedMimeTypes }`, schemaVersion 1, same defaults). No migration — `application_settings` already exists. Both upload routes read it.

---

## 2. Trading partners: counterparties as payees

### The fit question, answered

The owner's note asked to verify that `@loxep/counterparties` is the right home. It is, and the verification is documentary rather than a judgement call: [Domain Boundaries](../domain-boundaries/#customers-and-counterparties) already assigns *"people/organizations; contacts; addresses/sites; customer preferences/terms; tax/exemption metadata belonging to the customer identity"* to that domain, and states *"Domains may reference customers/counterparties but should not duplicate party identity records."* A separate `trading_partners` table would be exactly that duplication.

"Trading partner" is therefore **vocabulary, not a table**: it is the operator-facing name for a counterparty holding a `vendor` or `payee` relationship row.

### What the record is missing for Invoice Ninja parity — much less than expected

The push adapter is the surprise here. `buildInvoiceNinjaClientPayload` in `packages/integrations/invoiceninja/src/clients.ts` sends **`{ name }`, plus `{ id_number }` when supplied — and nothing else.** The real caller in `apps/web/src/server/finance-billing-functions.ts` does not even pass `id_number`. The gap between Loxep and Invoice Ninja is therefore almost entirely **in the adapter, not in the schema**.

Mapping Invoice Ninja's client shape against what Loxep already stores. **The left column is the weakest evidence on this page and must be checked against a running instance before it is implemented** — Loxep's adapter only ever *reads* `id`, `name`, `display_name`, `number`, `id_number`, `vat_number`, `balance`, `paid_to_date`, `is_deleted`, `updated_at`, and `contacts[]`, so every other field name below comes from Invoice Ninja's published API rather than from code this repository exercises. `GET /api/v1/clients` against the operator's own instance is a stronger guarantee than any vendor document; use it, exactly as [the companion survey](../knowledge-tasks-integration-design/#before-implementing-this-design) says to.

| Invoice Ninja client field | Loxep source today | Gap |
| --- | --- | --- |
| `name` | `counterparties.display_name` | none — the only field pushed today |
| `id_number` | `counterparties.reference_code` (`CP-2026-0117`) | adapter only |
| `vat_number` | `counterparties.tax_identifier` (+ `tax_identifier_kind`) | adapter only |
| `website` | `contact_channels` where `channel_kind = 'website'` | adapter only |
| `phone` | `contact_channels` where `channel_kind ∈ {phone, mobile}`, `is_primary` | adapter only |
| `address1` / `address2` / `city` / `state` / `postal_code` | `counterparty_sites` where `site_kind = 'billing'`, or the role row's `billing_site_id` | adapter only |
| `country_id` (a **numeric Ninja id**) | `counterparty_sites.country` (ISO-3166 alpha-2) | adapter needs a static alpha-2 → Ninja id map |
| `settings.currency_id` (a **numeric Ninja id**) | `counterparties.default_currency` / role `default_currency` | adapter needs a static ISO-4217 → Ninja id map |
| `settings.payment_terms` | `counterparty_entity_roles.payment_terms_days` | adapter only |
| `contacts[].email` | `contact_channels` where `channel_kind = 'email'` on the contact | adapter only |
| `contacts[].is_primary` | `counterparty_contacts.is_primary` | adapter only |
| `contacts[].first_name` / `last_name` | **nothing** — contacts carry `display_name` only | **SCHEMA GAP** |
| `private_notes` | `counterparties.notes` | adapter only; see the rule below |

**One schema gap, two columns.** `counterparty_contacts` gains nullable `given_name` and `family_name`; `display_name` stays `NOT NULL` and stays authoritative for every Loxep surface, because a party's contact may legitimately be "Accounts Payable" rather than a person. The adapter sends the split names when present and falls back to putting `display_name` in `first_name` when absent, which is what every other integration does with a mononym.

Two rules that come with the mapping:

- **Loxep pushes; Invoice Ninja owns.** The existing linkage shape stays exactly as `finance-billing.ts` built it: an `external_resources` row (`provider='invoiceninja'`, `external_type='client'`) plus a `resource_links` row (`resource_type='counterparty'`, `purpose='billing_client'`). **No `counterparties.invoiceninja_client_id` column, ever** — that is the [Companion Services](../../product/companion-services/#generic-external-resources) rule and the reason `external_resources` exists.
- **`private_notes` is opt-in per push, not automatic.** `counterparties.notes` is where an operator writes "chases invoices, call before shipping". Syncing it to a third-party system by default is a small privacy surprise; the push offers it as a checkbox and defaults to off.

### What counterparties does NOT gain

```text
credit limit, discount %, price list         no consumer; invented pricing policy
default income/expense account               the expense category already resolves an
                                             account through the Phase 5 rule engine
tax_exempt boolean                           counterparty_entity_roles.tax_treatment
                                             already records it, and Loxep records
                                             rather than calculates
language / locale / timezone                 no consumer
a payment_terms_days on the PARTY            terms live on the relationship — Phase 6
                                             argued this and it is still right
counterparty_identifiers                     still design-only; matching evidence is a
                                             separate concern from this design
```

### The payee field

```text
expenses.payee_name              text, KEPT, and still written on every expense
expenses.payee_counterparty_id   uuid null references counterparties(id)   NEW
```

`expenses.payee_name`'s own column comment has promised this column since migration 0006 (*"Phase 6 adds a nullable `payee_counterparty_id` and backfills by matching; this column stays, because it is the matching evidence"*). This design writes it, and holds the promise about the text column exactly:

- **Both are written, always.** The picker resolves a counterparty and the service snapshots its `display_name` into `payee_name` at write time. A later rename of the party does not rewrite history, and an expense recorded before the party existed still reads correctly.
- **Free text alone stays valid.** The quick-entry dialog must not require a counterparty; a thrift-store receipt from a shop with no name is a real expense. `payee_counterparty_id` is nullable and normally null on the fast path.
- **No backfill job.** Matching `payee_name` to parties in bulk is a matching design, it needs `counterparty_identifiers`, and a mis-match is silent. An operator-driven "link this payee" action on expense detail is the honest version and is in scope; a sweep is not.
- **Reads resolve the survivor pointer.** Any join through `payee_counterparty_id` uses `resolvedIdExpression` from `@loxep/counterparties/merge.ts`, so a merged party's expenses report under the survivor without a data rewrite.

### The picker and inline create

```text
COMBOBOX (ComboboxField, per Frontend Standards)
  source     rolesService.listByEntityRole({ role: 'vendor' })  ∪  ({ role: 'payee' })
             ranked first, then counterpartiesService.listForPicker({ search })
  excluded   merged losers and status='archived'  (pickerPredicate — already shipped)
  empty      "No trading partner — record a name only" writes payee_name alone
  action     "+ New trading partner"  ->  inline dialog, never a route change
```

The inline dialog collects the minimum that makes a party useful and nothing more: `kind` (person/organization), `displayName`, optional `legalName`, and an optional primary email. On submit, one server function runs one transaction: `counterparties.create` → optionally `contacts.addContact` + `addChannel` → `roles.grant`.

**Which role does inline-create grant?** `payee`, with `economic_entity_id` set to the expense's entity (or `null` when the expense is unattributed). The argument is accuracy over ambition: the fact being recorded is *we paid them*, which is what `payee` means in Phase 6's set. `vendor` — *they supply us goods* — is one selector click away in the dialog and is the right choice when the operator knows it. See [open question 3](#open-questions) for why this is not obvious.

### Role taxonomy: the closed set is not widened

The owner named "suppliers/vendors/wholesale buyers". The shipped set is a `CHECK`-enforced eight: `customer, vendor, payer, payee, consignor, subcontractor, partner, other`.

```text
owner's word        maps to        why
------------------  -------------  ---------------------------------------------
supplier            vendor         same relationship, different regional word
vendor              vendor         exact
wholesale buyer     customer       a wholesale buyer IS a customer; "wholesale"
                                   is a SEGMENT of the relationship, not a
                                   different relationship
consignment source  consignor      already in the set
```

> **Recommendation: do not widen the `CHECK`.** Adding `wholesale_buyer` would split `customer` in two, and every billing and posting path that branches on `role = 'customer'` — including the Invoice Ninja push — would silently stop seeing half its parties. If segmentation earns its place later, it is an additive nullable `segment` column on `counterparty_entity_roles` with an open TypeScript union, which costs nothing and breaks nothing. Flagged as [open question 2](#open-questions) because the owner named the word explicitly and the recommendation contradicts it.

### The exclusion rule, and where the boundary physically lives

The owner's requirement is emphatic: marketplace buyers and sellers are **not** trading partners. The boundary already exists in the schema and this design's job is to name it so it cannot drift.

```text
                marketplace buyer                 trading partner
                --------------------------------  ------------------------------
where           orders.buyer_external_id          counterparties + roles
                orders.buyer_display_name
created by      an ingestion job, from provider   a HUMAN, in the application
                data
identity        channel-native, per connection    installation-wide, merged by a
                                                  human through a survivor pointer
contact detail  NONE. commerce.ts forbids it in   the whole point: contacts,
                so many words                     channels, sites, terms, tax id
full payload    provider_objects, retained and    n/a
                redacted per ADR-0021
```

`packages/db/src/schema/commerce.ts` states the rule already, and it is worth quoting because it is the exact line that must not erode:

> *"buyer identity is a channel-native reference only — `buyer_external_id` plus an optional display name. No email, phone, or address column exists or may be added before Phase 6 owns a counterparty model."*

Phase 6 now owns a counterparty model, so the clause's precondition has been met — and this design declines the door it opens:

> **Rule: no ingestion path may create a counterparty. `orders` gains no `counterparty_id` in this design. A marketplace buyer becomes a trading partner only when a human decides they are one and creates the record by hand.**

Three reasons, in order of weight. First, a marketplace order's buyer is a pseudonymous channel handle, and minting a party per handle would produce thousands of rows the operator never asked for and cannot merge. Second, party creation is the one place where the never-auto-commit invariant would be crossed by a *sync* rather than a *parse*, which is a class of write nobody would think to write a test against — so the test is owed (see [before implementing](#before-implementing-this-design)). Third, the reverse is cheap: an operator who wholesales to one eBay buyer regularly creates the party by hand once, and `counterparty_identifiers` is the designed-but-unbuilt table for tying the handle to it when someone needs that.

The falsifiable form: **if `grep` finds an `insert into counterparties` reachable from `packages/integrations/*` or from a Graphile Worker task, this rule has been broken.**

---

## 3. OCR: the survey

Every row below was verified against primary sources on **2026-08-15**. The screening rule, in the shape [the companion survey](../knowledge-tasks-integration-design/#the-two-rules-that-decide-almost-everything-below) used:

> **An OCR backend that cannot run CPU-only, in a named long-running container, under a permissive license, inside the host's remaining disk budget, is not a candidate — no matter how accurate it is.**

Three deployment constraints do the eliminating, and none of them is negotiable:

- **CPU only.** A self-hosted Loxep is a small box. A backend whose honest answer is "it needs a GPU" is out.
- **A named long-running service, or nothing.** [ADR-0018 as amended](../../decisions/0018-runtime-processes-migrations-health/) forbids one-shot containers outright: *"the Compose stack defines no migration service and no one-shot containers of any kind."* An OCR sidecar is therefore an HTTP service under an opt-in profile, exactly like the `rustfs` companion — never a container the app spawns per document.
- **Disk budget.** The stack already carries a TimescaleDB image and the Loxep image. An OCR backend that wants several gigabytes of model weights is spending the operator's whole remaining budget on receipts.

### The tier ladder

Reusing the vocabulary [Phase 8](../fleet-observability-design/#per-tool-verdicts) and [the companion survey](../knowledge-tasks-integration-design/#the-tier-ladder) established, because the point of a ladder is that each rung ships alone:

```text
tier 0   no extraction        today. A receipt is a picture. The operator types.
tier A   searchable text      OCR -> documents.parsed_text -> full-text search.
                              No boxes, no structure, no guesses. The cheap win.
tier B   boxes and drag       tier A plus per-line rectangles, so the pane can
                              highlight a line and the operator can drag it into
                              a field or into the line list.
tier C   structured autofill  the parser proposes a payee, a date, a total, and
                              line items into the form. NEVER auto-commits.
```

**The finding that reorders the ask: tier B is nearly free once tier A ships, provided tier A's backend is an OCR engine rather than a text pipeline.** Tesseract's `tsv` output is *one row per recognized word with its bounding box and confidence* — the geometry tier B needs is a byproduct of the extraction tier A wants, not a second capability. That inverts the intuition that highlighting is the expensive part.

### The survey

Verified 2026-08-15 against upstream repositories, package registries, and documentation. "Boxes" means word- or line-level coordinates in a machine-readable output a JavaScript client can consume.

**Provenance of every number below, stated because it decides how much weight each carries.** The Tesseract figures — ~0.46 CPU-s native versus ~0.42 CPU-s for tesseract.js v7, the ~98 MiB apt delta, the `OMP_THREAD_LIMIT` blowup to 21.6–29.6 s, the `--network none` offline proof — were **measured during this survey on one development host, against one 600×1400 receipt image, in resource-capped containers**. That is enough to settle *relative* questions (WASM versus native, one OpenMP thread versus many) and **not** enough to predict an operator's box. Everything else — PaddleOCR throughput, model and image sizes, licences, release dates — is **cited**, and vendor-supplied throughput is labelled where it appears. The one measurement that would settle the tier-A+ question — character error on a stack of the operator's own crumpled thermal receipts — **has not been taken**, and taking it is the first task of the milestone rather than a prerequisite of this design.

| Candidate | License | Current release | CPU-only? | Boxes? | Weight | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **tesseract.js** (v7) | Apache-2.0 | 7.x, active | **Yes** — WASM with SIMD/relaxed-SIMD LSTM-only cores | **Yes** — TSV/hOCR **byte-identical to native**, so one parser serves both | **~53 MB** (npm ~51 MB + ~2 MB gzipped `traineddata`) | **RECOMMENDED for tier A/B** — no container at all |
| **Tesseract** (native) | Apache-2.0 | **5.5.1**, 2025-05-25. **No 6.x is coming** — the milestone has been dormant since 2024 | **Yes** — a C++ CPU engine, and always was | **Yes** — `tsv` gives one row per word with bbox + confidence; also hOCR, ALTO, PAGE | **~98 MiB** measured apt delta on `node:22-trixie-slim`, of which ~75 MiB is transitive (Cairo/Pango/curl/Kerberos) and 10.3 MiB is `tesseract-ocr-osd` you will never use | viable, but the WASM build is smaller and equally fast |
| **OCRmyPDF** | core **MPL-2.0**; **its bundled `misc/webservice.py` is AGPL-3.0** | active, last upstream update **2026-08-05** | Yes | via Tesseract | `jbarlow83/ocrmypdf-alpine` is **311 MB** compressed (the plain `ocrmypdf` tag is 460 MB, Ubuntu-based) | **NOT on the critical path** — see below |
| **PaddleOCR / PP-OCRv5** | Apache-2.0 | PP-OCRv5 shipped with PaddleOCR 3.0 (2025-05); a **PP-OCRv6 announcement dates to 2026-06 and is vendor-sourced — verify before relying on it** | Yes — the **mobile** variant is explicitly built for CPU-only; ~0.07B params, vendor-reported >370 chars/s on a Xeon Gold 6271C | Yes — detection returns polygons per text region | **~1.5 GB** container for mobile models, 2–3 GB for server | **SECOND BACKEND**, if Tesseract's quality disappoints |
| **docTR** (Mindee) | Apache-2.0 | active; now in the PyTorch ecosystem, with an ONNX wrapper (OnnxTR) | Yes, with 8-bit quantized models | Yes | PyTorch in the image — the heaviest of the "viable" options | watch |
| **Surya** | **Code GPL; weights CC-BY-NC-SA-4.0**, waived only for organizations under **$5M revenue and $5M lifetime funding** | active | GPU-oriented | Yes | — | **DISQUALIFIED** |
| **EasyOCR** | Apache-2.0 | **inactive — no PyPI release in 12 months** | Yes, slowly | Yes | PyTorch | **DISQUALIFIED** |
| **Donut / LayoutLM-class / document VLMs** | varies; several in the family carry **non-commercial** weight licences | — | **No, not honestly** | n/a | gigabytes | **DISQUALIFIED for tier C** — see below |

**One package must be named so nobody reaches for it: `node-tesseract-ocr` is a live critical vulnerability, not merely abandoned.** [CVE-2026-26832 / GHSA-8j44-735h-w4w2](https://github.com/advisories/GHSA-8j44-735h-w4w2), published 2026-03-25, **CVSS 9.8** — OS command injection, because a file path is concatenated into `child_process.exec()`. Affected `<= 2.2.1`, **patched versions: none**; several scanners claim a fix in 2.2.2 and the npm registry shows **2.2.2 does not exist** (latest is 2.2.1, from 2021-05-11). It is the first result anyone searching "tesseract node" finds. If native Tesseract is ever wanted, the answer is roughly forty lines of `execFile` with an argv array — never this package, and never `exec` with an interpolated path, since the path in question is derived from an operator-uploaded filename.

Three verdicts deserve their reasoning rather than a row:

- **Surya is disqualified on licence, not quality.** Its weights are CC-BY-NC-SA-4.0 with a revenue-and-funding waiver, and its code is GPL with a dual-licence offer. Loxep is MIT and is *redistributed* — an operator downloading Loxep must not inherit a licence whose terms depend on their revenue. This is a harder disqualification than the BSL question [the companion survey](../knowledge-tasks-integration-design/#the-two-finalists-and-the-honest-trade-between-them) wrestled with, because that concerned a *recommended companion* the operator installs themselves; this would be a component of a documented default.
- **EasyOCR is disqualified on maintenance.** A stalled dependency in a security-relevant position (it parses attacker-influenced files) is not a saving.
- **Tier C is disqualified on hardware honesty.** The document-understanding model families are the only things that genuinely produce structure from an unseen layout, and every one of them wants a GPU or minutes of CPU per page plus gigabytes of weights. Recommending one would mean recommending that a reseller's small box grow a GPU to read a thrift-store receipt. Phase 9's [section 2b](../flipping-lifecycle-design/#backends-the-options-and-the-recommendation) reached a version of this conclusion by intuition — *"a backend that is right 70% of the time produces a review queue the operator must read line by line anyway"* — and the survey confirms the hardware half of it.

### The recommendation, tier by tier

```text
tier A   SHIP IT, IN-PROCESS, WITH NO NEW CONTAINER.
         tesseract.js v7 as a registered ReceiptParser, plus poppler's
         pdftotext (~7 MB) to lift an EXISTING PDF text layer instead of
         OCRing a digital invoice that already has one.
         Output: documents.parsed_text. Total disk cost ~60 MB.

tier B   SHIP IT SECOND, and it is nearly free. The SAME RUN that produces the
         text produces the boxes — `tesseract img out txt tsv hocr` costs the
         same as `txt` alone, because recognition dominates and the renderers
         are ~free. Never run twice to get text and boxes.
         document_line_candidates.source_region has been waiting since 0017.

tier A+  THE ACCURACY UPGRADE, and the only thing that justifies a container:
         a neural OCR sidecar (RapidOCR / PP-OCR class, Apache-2.0, ~1.5 GB).
         Tesseract's weakness on crumpled thermal receipts is an ENGINE
         limitation that no packaging choice fixes — a receipt-domain
         character-error penalty on the order of 25% is reported against
         clean-document baselines. Register it as a second backend, which is
         a SETTING, not a rewrite.

tier C   DO NOT SHIP A MODEL. Ship a deterministic heuristic instead: the
         largest amount near the word "total", a date matched by the existing
         normalizeDateString, the merchant line at the top of the receipt.
         It costs nothing, it runs in the same pass, it reports low confidence
         honestly, and it never auto-commits. When it is wrong the operator
         drags the right line, which is tier B working as designed.
```

**The correction that produced this shape, recorded because the intuition it overturns is widespread.** The received wisdom is that a WASM build of Tesseract is a browser toy and strictly worse than the native binary on a server. That was true of tesseract.js v2 and is **dead in v7**: measured head-to-head on one host against the same receipt, native `5.5.0 --psm 6 tsv` came in around **0.46 CPU-seconds per run** and tesseract.js **7.0.0 around 0.42** — on par, marginally faster, plausibly because it ships SIMD/relaxed-SIMD LSTM-only cores while a distribution binary is built generic. Its coordinate output is **byte-identical** to native TSV/hOCR, so one parser serves both and the choice is reversible at any time. Offline operation was verified under `--network none` with only `langPath` set; the CDN default that Loxep's no-egress rule forbids applies to language data alone and is one option away.

Two consequences follow, and the second is the important one:

- **Half the disk, and none of the apt attack surface.** ~53 MB of npm and vendored `traineddata`, against a measured ~98 MiB apt delta that drags in Cairo, Pango, curl, and Kerberos — a large CVE surface acquired to read receipts, plus 10.3 MiB of orientation-detection data that will never be used.
- **Tier A no longer requires the owner to accept a third container**, which was the whole substance of this design's hardest open question. A capability that ships as a dependency rather than a service is a categorically smaller commitment, and the container question narrows to *accuracy* — worth asking, but only after operators have used the free version on their own receipts.

**Paperless-ngx remains the reference deployment and its recent history is now evidence in both directions.** It routes image-only PDFs through OCRmyPDF's Tesseract wrapper and indexes the text into PostgreSQL — the same engine and the same text-in-Postgres posture section 5 proposes. But its v3 answer to *"Tesseract is not accurate enough"* was to add a **cloud** engine (Azure Document Intelligence, opt-in), while its llama-index/Ollama work is classification and retrieval over already-OCR'd text rather than OCR. The most-deployed self-hosted document manager reaching for a cloud API is the honest measure of how hard local receipt accuracy is — and since Loxep's constraints forbid that exit, the local neural sidecar is the upgrade path that remains.

**OCRmyPDF drops off the critical path, and this is a simplification rather than a slight.** Its output is a searchable PDF; Loxep wants text in a column. Two further facts confirm the call: its bundled `misc/webservice.py` is **AGPL-3.0** — unlike the MPL-2.0 core — is now a Streamlit human UI rather than the Flask service its own docs still describe, and is self-described as having *"no security, no authentication… single-threaded"*, so it was never the sanctioned service shape anyway. If a PDF-in/PDF-out path is ever wanted, the pattern is the in-process `ocrmypdf.ocr()` Python API behind a thin first-party sidecar (which is what Paperless-ngx does), never the bundled web service — and `pypdfium2` may be substituted for Ghostscript, which removes the last AGPL dependency from the chain.

### Deployment shape

```text
tier A    NO SERVICE. A dependency of the Loxep image plus vendored language
          data. Runs in the worker's own process space.
tier A+   ONE named long-running service under an opt-in Compose profile, on
          the rustfs precedent. Never a container the app spawns per document —
          ADR-0018 as amended forbids one-shot containers outright.
transport HTTP, in-cluster, for tier A+ only. The adapter posts bytes and
          receives JSON; it never shares a filesystem with the app.
selection an application_settings key (documents.parser_id). The manual parser
          stays registered and stays the default until an operator turns OCR on.
credentials NONE, at either tier. This is the whole point of a local backend,
          and it is why nothing here reopens Phase 9's OQ3 policy question
          about sending financial documents to a third party.
degradation an installation that never enables OCR behaves exactly as today.
          No feature disappears; parsed_text stays null and the search filter
          says so rather than returning a misleading empty result.
```

**Operational rules for the Tesseract path, each of which is worth more than a percentage point of accuracy.** These are the difference between a sub-second extraction and a job that looks hung:

```text
OMP_THREAD_LIMIT=1   THE most important knob, and a silent catastrophe if
                     missed. Unconstrained OpenMP under a CPU quota turned a
                     ~0.46 s run into 21.6-29.6 s on the measured host — a
                     known upstream issue (tesseract#3109). Loxep gets its
                     concurrency from Graphile Worker, not from OpenMP, so
                     pin it to one thread and let the job queue parallelize.

one worker, once     ~0.9-1.1 s of one-time init for the WASM worker. Create
                     it at process start and reuse it; creating one per
                     document triples the cost of a short receipt.

one pass, all formats
                     `txt tsv hocr` together cost what `txt` costs alone.
                     Recognition dominates; renderers are ~free. A second
                     invocation to "also get the boxes" is pure waste, and it
                     is the obvious mistake to make when tier B lands after
                     tier A.

x-height 20-30 px    Tesseract has a documented UPPER bound as well as a lower
                     one — LSTM accuracy degrades below ~10 px and ALSO above
                     ~30 px. Preprocessing must NORMALIZE x-height into the
                     band; naive upscaling makes results worse, which is the
                     opposite of what everyone assumes.

thresholding_method=2
                     Sauvola, added in 5.0.0. Try `-c thresholding_method=2`
                     BEFORE building a preprocessing pipeline: published
                     retail-bill work found heavy preprocessing bought a few
                     points of character error at roughly 40x the runtime.
```

```text
REJECTED: bundling the NATIVE Tesseract binary into the Loxep image

  Section 2b's weight argument still holds and the measurements sharpen it:
  ~98 MiB of apt delta, ~75 MiB of it transitive (Cairo, Pango, curl,
  Kerberos), against ~53 MB for the WASM build at equal speed and identical
  output. Note also that the base image decides the engine version —
  node:22-slim is bookworm and gives Tesseract 5.3.0, node:22-trixie-slim is
  the same size and gives 5.5.0 — which is a footgun for a "just apt-get
  install it" reflex.

REJECTED: OCRmyPDF's bundled web service as the sidecar

  AGPL-3.0 (the core is MPL-2.0), a Streamlit human UI rather than the Flask
  service its docs still describe, and self-described as having no security
  and no authentication. If a PDF-in/PDF-out service is ever wanted, wrap the
  in-process ocrmypdf.ocr() API in a first-party sidecar instead.

REJECTED: node-tesseract-ocr

  CVSS 9.8 command injection with no patched version. See the survey.

REJECTED: a cloud OCR/document-AI API

  Out of scope by construction. Phase 9's OQ3 already framed "may Loxep send
  photographs of the operator's financial documents to a third party" as an
  owner policy question, and this design deliberately does not reopen it. A
  local backend needs no answer to it. Recorded honestly: this is the exit
  Paperless-ngx took in v3, and Loxep is choosing not to have it.
```

---

## 4. Line items: one shape, three destinations

### The question, restated precisely

The owner asked what fields make all the pieces connect. The answer starts with a distinction the current schema does not draw, and everything else follows from it:

```text
WHAT WAS BOUGHT                          WHERE THE MONEY IS CHARGED
"2 x shelving unit @ 89.00 = 178.00"     "$40 of this bill belongs to the LLC,
"packing tape, 12 @ 3.20 = 38.40"         against that auction lot"
"sales tax 98.40"

a LINE                                    an ALLOCATION
comes off the receipt                     comes out of the operator's head
may have quantity and unit price          has an amount and one or more targets
may name no target at all                 must name at least one target
count is fixed by the document            count is chosen by the operator
```

`expense_allocations` is the second thing. Its own `CHECK` proves it — `num_nonnulls(economic_entity_id, acquisition_id, catalog_item_id, channel, ledger_account_id, dimension_value_id) >= 1` refuses a row that names no target, and its column comment explains that the targets are *"ORTHOGONAL dimensions of one split, not alternative kinds of it."* A receipt line for packing tape names no entity, no lot, no account and no channel; it is a fact about a purchase, not an attribution, and the shipped table is right to refuse it.

```text
REJECTED: widen expense_allocations with description/quantity/unit_amount

  It would require loosening the >= 1 target check — an invariant three
  separate phases converged on independently — so that a bare transcribed
  line could be stored. It would also require dropping `amount <> 0`, because
  a zero-priced line ("free with purchase") is a real receipt line and a
  zero-amount ALLOCATION attributes nothing. Two weakened constraints to
  avoid one small table is a bad trade, and the table that results means two
  different things depending on which columns are populated.
```

### `expense_lines`

```text
expense_lines
id                          uuid primary key
expense_id                  uuid not null references expenses(id) on delete cascade
line_number                 integer not null
description                 text null
quantity                    numeric(20,6) null
unit_amount                 numeric(20,6) null
line_amount                 numeric(20,6) not null
line_kind                   text not null default 'item'
document_line_candidate_id  uuid null references document_line_candidates(id)
                                 on delete set null
note                        text null
created_at                  timestamptz not null
updated_at                  timestamptz not null
unique(expense_id, line_number)
unique(document_line_candidate_id) where document_line_candidate_id is not null
check(line_number > 0)
check(line_kind in ('item','shipping','tax','fee','discount','other'))
```

Notes, because several columns are answers:

- **No currency column.** One expense, one currency — `expenses.currency` is authoritative and Phase 3's no-FX rule holds. A line in another currency is a different expense.
- **No date column.** `expenses.expense_date` is the date. A receipt whose lines span dates is a statement, and statements are a `document_kind` that confirms into several expenses.
- **No tax column, and this is deliberate.** A receipt's tax is a line (`line_kind = 'tax'`), which is how it appears on the paper. Adding a per-line `tax_amount` would create a second place tax can live and immediately raise "is `expenses.tax_amount` the sum of these or not". It is not; it is the operator's assertion about the whole expense, and the tax LINE is evidence for it.
- **No `acquisition_id`, no `catalog_item_id`, no `ledger_account_id`.** Those are allocation targets and they live on allocations. A line that wants an account is telling you the expense needs a split, and the surface should offer to create one — `sum(lines by kind)` is a good default proposal for `setAllocations`, and proposing is all it does.
- **`line_amount` may be zero and may be negative.** A coupon line is negative; a free line is zero. `expenses.amount` keeps its own `<> 0` check because a zero-total expense is not a fact.
- **`document_line_candidate_id` is a real foreign key with a partial unique index**, unlike `document_line_candidates.target_kind/target_id`, which is a stamp across four tables and cannot be one. The fine-grained link lives here precisely so that `CANDIDATE_TARGET_KINDS` does not have to be widened: the candidate still stamps `target_kind = 'expense'`, `target_id = <the expense>`, and the line-level provenance hangs off the new table where a real constraint is possible.

**The sum invariant is a service rule and a report, not a constraint** — for the fourth time in this documentation, and for the same reason: a draft expense is legitimately half-transcribed. `@loxep/accounting` refuses lines whose absolute sum EXCEEDS `expenses.amount`; under-transcription is a draft.

### The connective field table

This is the answer to the owner's sixth requirement. One line shape, carried end to end, with the same names at every hop:

| the fact | `ParseResult.lines[]` (parser, exists) | `document_line_candidates` (staging, exists) | `expense_lines` (NEW) | inventory destination (exists) |
| --- | --- | --- | --- | --- |
| what it is | `description` | `description` | `description` | `acquisition_costs.description` / `inventory_items.label` |
| how many | `quantity` | `quantity numeric(20,6)` | `quantity numeric(20,6)` | `inventory_items.quantity` |
| price each | `unitAmount` | `unit_amount numeric(20,6)` | `unit_amount numeric(20,6)` | — (costs are totals) |
| line total | `lineAmount` | `line_amount numeric(20,6)` | `line_amount numeric(20,6)` **not null** | `acquisition_costs.amount` |
| currency | `ParseResult.currency` | `currency char(3)` | — (from `expenses.currency`) | `acquisition_costs.currency` |
| when | — | `line_date date` | — (from `expenses.expense_date`) | `acquisition_costs.incurred_at` |
| who sold it | — | — (folded into `description`) | — (from `expenses.payee_*`) | `acquisition_costs.vendor_name` |
| how much to trust it | `confidence` (0..1, always present) | `confidence numeric(4,3)` | — (a saved line is asserted) | — |
| where on the page | `sourceRegion {page,x,y,w,h}` | `source_region text` | — | — |
| what kind of line | — | `disposition` (9 members) | `line_kind` (6 members) | `cost_class` + `capitalize` |
| what it became | — | `target_kind` + `target_id` (stamp) | ← `document_line_candidate_id` (FK) | — |
| the evidence file | `mediaObjectId` (input) | `documents.media_object_id` | `media_links(expense, receipt)` | `media_links(acquisition, invoice)` |

**The headline, in one sentence: the shape the parser already emits is the shape the staging table already stores, the shape the new expense line stores, and the shape an acquisition cost needs — so a receipt line can be routed to money-out or to inventory at confirm time without any field being re-derived, re-typed, or lost.**

Two honest gaps the table exposes, recorded rather than papered over:

1. **`document_line_candidates` has no payee column**, so the CSV importer folds it into `description` as `"Payee — description"` — a documented divergence from Phase 9's own sketch. With `expenses.payee_counterparty_id` arriving, that fold becomes lossier: a CSV row's payee could resolve to a party, and the description mangling prevents it. *Recommendation: leave it. Adding `document_line_candidates.payee_name` is additive and cheap, but it is a CSV-import concern, not an expense-entry one, and this design should not grow it.* Flagged as [open question 6](#open-questions).
2. **`ParseResultLine` has no date field**, so a statement's per-row date has nowhere to come from even though `document_line_candidates.line_date` exists to receive it. Only the CSV path populates `line_date` today. Any OCR backend for `document_kind = 'statement'` will hit this; receipts and invoices will not.

### How a line reaches inventory — and the rule that stops it

This is the requirement most likely to be implemented wrongly, because the obvious implementation is forbidden.

> **[Phase 9's acquisition seam](../flipping-lifecycle-design/#the-acquisition-seam-when-an-expense-is-really-a-purchase) is not loosened by this design. Money that bought goods for resale becomes an `acquisition` plus `acquisition_costs`, and NOT an `expenses` row. There is no such thing as an expense line that later "becomes stock".**

If an expense line could be promoted to inventory, the same dollar would be deducted once as an expense and again as COGS at sale, and every per-item contribution figure would be computed against a basis the business had already expensed. That is the specific failure the seam exists to prevent.

So the flow for a mixed receipt — three items to flip, plus packing tape, plus tax — is **one document, three records** (loxep-ytu split the acquisition side in two: money stays `confirmCandidatesAsAcquisition`'s, physical stock became its own function):

```text
                              receipt.jpg
                                   |
                             one media_object
                                   |
                             one documents row
                                   |
                        line candidates (5)
                    /              |                \
   disposition 'expense'  disposition            disposition
   or 'supplies'          'acquisition_cost'      'inventory_intake'
          |                       |                      |
confirmCandidatesAsExpense  confirmCandidatesAsAcquisition confirmCandidatesAsIntake
          |                       |                      |
 expenses + expense_lines   acquisitions + acquisition_costs   acquisitions + inventory_items
          |                       |                      |
media_links(expense,'receipt') media_links(acquisition,'invoice')  media_links(acquisition,'invoice')
          \                       |                      /
                    the SAME media object, up to three links
               — which media_links was built for, and
                 whose own comment names this exact case
```

**Status (M6, loxep-cd3.6): `confirmCandidatesAsAcquisition` is IMPLEMENTED**, closing the piece of Phase 9's M4 that was blocked on an acquisition-lot picker — see the milestone list below for the shape. **Status (loxep-ytu): `confirmCandidatesAsIntake` is also IMPLEMENTED** — candidates dispositioned `inventory_intake` now become an ACTUAL `inventory_items` row (physical stock) rather than a cost row; `acquisition_cost` stays `confirmCandidatesAsAcquisition`'s alone. See the milestone list below for the shape.

The weaker connection also stays available and is not the same thing: an expense line's cost can be *attributed* to a lot without being capitalized into its basis, through `expense_allocations.acquisition_id`. Gas to drive to the auction is the canonical case. That is business context, not cost basis, and Phase 9 already said so.

---

## 5. Search: where extracted text lives

### The column

Phase 9's [open question 10](../flipping-lifecycle-design/#open-questions) asked whether `documents` needs a `parsed_text` column before a backend exists and answered *"no — adding it now ships an always-null column and an implicit claim that Loxep extracts text."* **This design ships a backend, so it answers that question yes**, on the condition its own tier A actually lands.

```text
documents
parsed_text       text null           NEW  the full extracted text, one row per file
parsed_text_tsv   tsvector            NEW  generated always as
                                           to_tsvector('simple', coalesce(parsed_text,''))
                                           stored
                                      + GIN index
```

- **PostgreSQL full-text, not a search service.** No Elasticsearch, no Meilisearch, no Typesense. The [system overview's](../system-overview/) two-container default is a product property, and one `tsvector` column with a GIN index searches an installation's lifetime of receipts without adding a service, a port, or a backup target.
- **`'simple'`, not `'english'`.** OCR output from a receipt is brand names, model numbers, street names, and amounts. Stemming and stopword removal are tuned for prose and actively hurt here — `'english'` would stem `Milwaukee` fine but discard `a`, `no`, and `on` from part numbers, and it bakes a language assumption into a stored generated column, where changing it later is a migration. `simple` is lossless. Recorded as [open question 7](#open-questions) because it is the sort of default nobody revisits.
- **Generated and stored, not trigger-maintained.** `to_tsvector` with a literal config is `IMMUTABLE`, which is what a generated column requires, and a generated column cannot drift from its source the way a trigger can.
- **No `parsed_text` on `document_line_candidates`.** The line's `description` is already the searchable text of a line, and duplicating page text per line would multiply the index for nothing.

### How an expense's receipts are searched

There is no `documents.expense_id` and this design does not add one. The join already exists through the object both sides point at:

```text
expenses
  -> media_links (resource_type='expense', resource_id=expenses.id::text)
  -> media_objects.id
  -> documents.media_object_id
  -> documents.parsed_text_tsv  @@  websearch_to_tsquery('simple', :q)
```

Stated as a rule so nobody adds the shortcut column: **the media object is the join key between an expense and its extracted text.** It is the same object, it is already indexed both ways (`media_links_resource_idx` and the unique's leading column), and adding `documents.expense_id` would create a second truth that a detached receipt would silently falsify.

The honest cost: a document uploaded through the expense pane and never confirmed into lines is reachable only through the media link, and an expense whose receipt was uploaded through the OLD `POST /api/expenses/receipt` route has **no `documents` row at all** and therefore no text. That is not a migration problem — it is a "text exists from the day OCR is switched on, forward" property, and the surface must say so rather than implying an empty result means an empty receipt.

### What surfaces search it

```text
/finance/import          a `q` filter on the document queue — the primary surface.
                         Searching "Milwaukee" finds the receipt.
/finance/expenses        a `q` filter that joins through the chain above, presented
                         as "search receipt text" and clearly distinct from the
                         existing category/payee filters, because a match in a
                         receipt is a different claim from a match in a field.
expense detail           "Text extracted 2026-08-15 · 412 words" with the matched
                         snippet highlighted via ts_headline when arriving from a
                         search. Never the raw dump — OCR text is ugly and showing
                         it whole invites the operator to trust it as a transcript.
command palette          NO. Deliberately out: a global search over receipt text
                         needs a ranking story across every entity type, and that
                         is a search design, not this one.
```

---

## The weave

```text
      /finance/expenses/new
        |                \
   form (left)            evidence pane (right)
        |                        |
        |                 POST /api/documents/upload
        |                        |
        |                 media_objects (purpose='document')
        |                        + documents (source_kind='upload')
        |                        |
        |                 [tier A] OCR job -> documents.parsed_text  --> SEARCH
        |                        |
        |                 [tier B] parser -> document_line_candidates
        |                                    (+ source_region boxes)
        |                        |
        |     <---- drag a line into the form, or a value into a field
        |                        |
   [ Record expense ]  ---- one transaction ---------------------------
        |                        |                    |               |
   expenses               expense_lines        ReceiptsService   stampConfirmed
   (+ payee_counterparty_id)  (candidate FK)   .attach(media)    (candidates)
        |
   posting engine (already wired: source fact ('expense', id))
```

And the branch that does not come back to this page:

```text
   a candidate dispositioned            a candidate dispositioned
   'acquisition_cost'                   'inventory_intake'
        |                                     |
   confirmCandidatesAsAcquisition        confirmCandidatesAsIntake
   (IMPLEMENTED, loxep-cd3.6)            (IMPLEMENTED, loxep-ytu)
        |                                     |
   acquisitions + acquisition_costs      acquisitions + inventory_items
        |                                     |
   (contributes to the lot's landed-cost pool; allocateCosts
    spreads it across the lot's unlocked items on request)
```

### Reconciling the two flows, which is the crux of the ask

Loxep now has two ways a receipt line becomes a record, and the owner's drag-to-field interaction is a third only if it is designed carelessly. It is not a third:

```text
FLOW 1 (shipped)   /finance/import: a document exists -> review its candidates ->
                   confirm selected lines -> the confirm CREATES an expense.

FLOW 2 (new)       /finance/expenses/new: an expense is being COMPOSED -> a document
                   is dropped -> its candidates appear in the pane -> the operator
                   drags them into the form -> saving creates the expense AND
                   stamps the candidates in the same transaction.
```

> **The rule that makes them one mechanism: a candidate is stamped when a domain record exists, and never before. The form is a staging area in the browser, not a disposition.**

Dragging changes nothing in the database. It moves text into a controlled input, which is exactly what typing does. The stamp — `disposition`, `target_kind`, `target_id`, `confirmed_at`, `confirmed_by_user_id` — happens at save, inside the same transaction that inserts the expense, with the same non-null `actorUserId`. Flow 1 confirms then creates; flow 2 creates then confirms. **Both call the same `confirmCandidatesAsExpense`**, differing only in whether it is handed an expense id or asked to make one.

Two consequences worth stating because they are the ones an implementer would get wrong:

- **Dragging into a HEADER field (amount, date, payee) is pure UI and stamps nothing.** The value came from `documents.document_total`, `documents.document_date`, `documents.counterparty_name`, or a candidate's text, and none of those is a line-level confirmation. Only a drag into the LINES list creates a candidate→line relationship.
- **Abandoning the page leaves candidates `pending`, which is correct.** The document sits in `/finance/import` exactly as if it had been uploaded there, and the operator can finish through flow 1. Nothing is orphaned and nothing is half-confirmed, because nothing was written.

---

## Package ownership

Applying [Phase 6's domain-to-package rule](../services-billing-schema-design/#open-questions) (open question 14) — a table belongs to the package that owns its domain, named after the domain and never the mechanism:

```text
expense_lines                     @loxep/accounting        — it is expense data
confirmCandidatesAsExpense        @loxep/accounting        — moved DOWN from apps/web,
                                                             see below
confirmCandidatesAsAcquisition    @loxep/inventory         — IMPLEMENTED (loxep-cd3.6)
confirmCandidatesAsIntake         @loxep/inventory         — IMPLEMENTED (loxep-ytu)
counterparty_contacts columns     @loxep/counterparties    — existing service
the OCR backend adapter           @loxep/documents         — it is a registered
                                                             ReceiptParser and nothing
                                                             else; the sidecar HTTP
                                                             client is its private
                                                             detail
the payee picker, the page,       apps/web                 — surfaces
the preview component
```

**`@loxep/documents` must continue to depend on neither `@loxep/accounting` nor `@loxep/inventory`.** The inversion is the enforcement mechanism, and a cycle here would be the signal to merge packages, which would be wrong.

Two pieces of debt this design is the right moment to pay, both flagged by Phase 9's M4 as follow-ups rather than discovered here:

1. `apps/web/src/server/documents-functions.ts`'s `confirmLinesAsExpense` re-implements the package's SQL inline because the milestone's write fence excluded `@loxep/accounting`. Flow 2 needs the same logic with an expense-id parameter, and writing a *second* inline copy is how three copies happen. Move it into `@loxep/accounting` as `confirmCandidatesAsExpense` and have both surfaces call it.
2. `apps/web/package.json` declares neither `@loxep/documents` nor the dependency the move implies. The duplication was kept deliberately identical so the dependency add is a deletion; this is the pass that performs the deletion.

## Migration plan sketch

Migration numbers are **not assigned here** — take the next free numbers at implementation time and follow the [add-migration](../../development/implementation-contract/#database-and-schema) discipline (explicit FK names for the 63-byte identifier limit, `MIGRATION_FILE_COUNT` bumped, journal updated).

```text
A  counterparty contact names        counterparty_contacts
   IMPLEMENTED as migration 0023 (loxep-cd3.1).
   ALTER TABLE ADD COLUMN given_name text null
   ALTER TABLE ADD COLUMN family_name text null
   Nothing else. Two nullable columns, no backfill, no constraint.

B  expense payee link                expenses
   IMPLEMENTED as migration 0024 (loxep-cd3.1).
   ALTER TABLE ADD COLUMN payee_counterparty_id uuid null
     references counterparties(id)
   + partial index where payee_counterparty_id is not null
   Named FK explicitly (expenses_payee_counterparty_fk) — the derived name
   turned out to be 51 bytes, under the 63-byte limit, but named explicitly
   anyway per this doc's own instruction AND because drizzle-kit emits a
   second, redundant auto-named FK if the column also carries an inline
   `.references()` alongside an explicit `foreignKey()`.
   No backfill. payee_name is untouched and stays written.

C  expense lines                     expense_lines (new table)
   IMPLEMENTED as migration 0025 (loxep-cd3.3).
   As specified in section 4, including the partial unique on
   document_line_candidate_id.

D  extracted text                    documents
   ALTER TABLE ADD COLUMN parsed_text text null
   ALTER TABLE ADD COLUMN parsed_text_tsv tsvector
     generated always as (to_tsvector('simple', coalesce(parsed_text,''))) stored
   + GIN index on parsed_text_tsv
   Verify drizzle-kit's current support for a generated tsvector column;
   fall back to hand-written SQL rather than weakening it to a trigger.
```

**Which existing tables gain columns:** `counterparty_contacts` (two), `expenses` (one), `documents` (two). **No table loses a column, no CHECK is widened, and no NOT NULL is relaxed anywhere in this design.** That property is worth preserving through implementation — if a migration in this set finds itself dropping a constraint, the design has been misread.

No migration for: `application_settings` entries (`documents.media_limits`, the parser-backend key) — that table exists and takes rows.

## What this design does not create

```text
a trading_partners table                  counterparties is the party model;
                                          Domain Boundaries forbids the duplicate
orders.counterparty_id                    the marketplace boundary; section 2
counterparties.invoiceninja_client_id     external_resources exists for this
an expense line that becomes stock        the acquisition seam; section 4
a per-line tax column                     a tax line is a line
documents.expense_id                      the media object is the join key
a search service                          one tsvector column and a GIN index
a second inbound webhook receiver         still Phase 8's open question
a fuzzy payee matcher / backfill job      @loxep/counterparties argued this at
                                          length and is still right
a bank/OFX path                           settlement is not spend; Phase 5 owns it
an LLM vision backend                     out of scope here; still an owner policy
                                          question, unchanged from Phase 9 OQ3
an accounting_books-per-entity rule        ADR-0017; nothing here touches books
```

## Open questions

Each is genuinely unresolved and carries a recommendation. **A recommendation is not an answer.** Items marked **OWNER-REVIEW-CRITICAL** set precedent or are expensive to reverse after data exists.

1. **OWNER-REVIEW-CRITICAL — the OCR runtime-weight tradeoff.** The survey narrowed this question considerably and it is worth saying how, because an earlier draft of this design asked something harder. **Tier A no longer needs a container**: tesseract.js v7 measured on par with the native binary at half the disk, so searchable receipt text ships as a ~53 MB dependency inside the existing image. What remains is a *second*, narrower question — **is Tesseract's accuracy on crumpled thermal receipts good enough, or does the installation want the ~1.5 GB neural sidecar (tier A+)?**

   *Recommendation: ship tier A in the image, and offer tier A+ as an opt-in Compose profile — never in the default stack.* A capability that arrives as a dependency is a categorically smaller commitment than one that arrives as a service, and the accuracy question is best asked *after* operators have run the free version over their own receipts rather than in advance of any evidence.

   *The owner must still confirm three things, because each is a different kind of commitment:* (i) that ~53 MB and a WASM OCR engine may enter the **default image**, which every deployment carries including those that never parse a receipt — this is the cost tier A moves from the opt-in operator onto everyone, and it is the honest price of dropping the container; (ii) that the product's deployment story may include an **optional third container** for tier A+, given that "two containers" has been quoted as a product property; (iii) that **tier C stays refused** — no model-based structured autofill — because the moment one is added, the honest answer to "why is this box wrong" becomes "the model guessed", and Loxep's whole posture is that it records rather than guesses.

   *What would change this answer:* evidence from real receipts. If Tesseract's error rate makes the extracted text useless for search, tier A has shipped weight for nothing and tier A+ becomes the real tier A. That is a measurement, it has not been taken, and the milestone should take it early enough to stop.

2. **Is `wholesale_buyer` a role, or a segment of `customer`?** The owner named it as a role; the shipped `CHECK` does not have it, and `customer` is what every billing path branches on.

   *Recommendation: segment, not role — do not widen the `CHECK`.* Widening splits `customer` into two values that every existing consumer must now check for, and the failure mode is silent (a wholesale customer stops appearing in a customer list). If the distinction earns its place, an additive nullable `segment` column on `counterparty_entity_roles` with an open TypeScript union costs one migration and breaks nothing.

   *The owner must confirm:* that "wholesale buyer" is a way of describing a customer relationship rather than a different relationship. If it genuinely routes differently — different pricing, different invoice template, different terms by default — the recommendation is wrong and the `CHECK` should be widened before any role rows exist.

3. **Which role does inline-create grant from the expense page — `payee` or `vendor`?** This design says `payee`.

   *Recommendation: `payee`, with `vendor` one click away.* The fact being recorded at that moment is "we paid them", and `payee` is Phase 6's word for it. Granting `vendor` by default would assert a supply relationship the operator did not state, and `vendor` is the role that ought to mean something when the acquisition side starts reading it.

   *The owner must confirm:* whether the distinction is worth a selector at all, or whether every party created from an expense should simply get both. Flagged because a wrong default here is invisible — nobody audits role rows — and it decides what a "trading partner list" contains a year from now.

4. **Does the expense page create a `documents` row for every dropped file, including a photo the operator will never parse?** This design says yes.

   *Recommendation: yes.* One pipeline is worth a cheap row. The alternative — deciding at drop time whether a file is "just an attachment" or "a document" — asks the operator a question they cannot answer yet, and the answer changes when they later want the text searched.

   *The cost, stated:* the `/finance/import` queue fills with documents that were never meant to be reviewed. Mitigation: the queue's default filter excludes documents already linked to a confirmed expense, which is a query, not a column.

5. **Should `expenses.tax_amount` be derived from a `line_kind = 'tax'` line when one exists?** This design says no, and keeps them independent.

   *Recommendation: no derivation, but a visible disagreement.* The operator's `tax_amount` is an assertion about the expense; a tax line is evidence. When they differ, the surface shows both and says so — deriving one from the other would make a transcription error silently rewrite an accounting figure.

6. **Does `document_line_candidates` gain a `payee_name` column?** The CSV importer currently folds payee into `description` as `"Payee — description"`.

   *Recommendation: not in this design.* It is additive and cheap whenever the CSV path is next touched, and doing it here would put an expense-entry design in charge of an import concern. Recorded so the fold is a known divergence rather than a discovered one.

7. **`'simple'` or `'english'` for the `parsed_text_tsv` configuration?** This design says `'simple'`.

   *Recommendation: `'simple'`.* OCR output is names, numbers, and part codes rather than prose, and the config is baked into a stored generated column where changing it is a migration on a table with rows. `'simple'` is the choice that assumes least.

   *Worth knowing:* if operators complain that searching "shelving" fails to find "shelves", the fix is a second generated column or `pg_trgm`, not a config swap on the existing one.

8. **Does the acquisition confirm path (`confirmCandidatesAsAcquisition`) belong to this epic or to a separate inventory pass?** This design scopes it in, because without it requirement 5 is untrue.

   *Recommendation: in, as the last child.* It is the only piece here that touches `@loxep/inventory`, it needs an acquisition-lot picker (create-new versus attach-to-open-lot) that is a real UI, and it is the natural place for the epic to stop if it needs to stop early.

## Contradictions and tensions found in existing documentation

Recorded for a human to resolve; this document does not fix them.

1. **There is no ADR governing the Documents domain.** The never-auto-commit rule — arguably the strongest invariant in the codebase, with a test written specifically to prove it — lives only in an architecture design document's section 2b and in schema module comments. Every comparable rule (integration boundaries, order payload retention, notifiable events) has an ADR. *If this design's OCR tiers are accepted, the parse/confirm boundary is about to be crossed by machine-generated candidates for the first time, and that is the moment the rule should become an ADR of its own (take the next free number at the time — 0024 was claimed while this design was being written) rather than a section reference.*

2. **RESOLVED (loxep-ytu).** `expenses.acquisition_cost_id` now has its writer: `@loxep/accounting`'s `ExpensesService.promoteToAcquisitionCost` — `voidExpense`'s own state transition (`recorded`/`draft` → `void`, kept as evidence, never mutated in place) with `acquisition_cost_id` stamped in the SAME statement. The web layer (`apps/web/src/server/expense-functions.ts`'s `promoteExpenseToAcquisitionCost`) creates the `acquisition_costs` row FIRST via `@loxep/inventory`'s `AcquisitionsService.addCost` (SEQUENTIAL calls, not one shared transaction — the same posture `createAcquisitionFromMarketItem` already documents for a cross-package write), then calls the accounting-side promote. The expense-detail page's "Promote to acquisition" button reuses `AcquisitionLotPickerDialog` (the same create-new-or-attach-existing lot picker the document-review panel uses) chained into a reason-collecting confirm dialog, mirroring `VoidExpenseDialog`'s own two-step chaining pattern. No new posting is invented: voiding makes the `expense` source fact ineligible (the next posting-engine sweep reverses whatever it already posted) and the new `acquisition_costs` row is a fresh `acquisition_cost` source fact the same sweep posts under the existing `acquisition_cost_capitalized` rule — see `source-facts.ts`'s `readAcquisitionCost`, whose `superseded_expense_id` join already made this promotion visible from the ledger side, for the first time with a real writer behind it.

3. **Phase 9 section 1 says "no schema change is required for expense capture", and this design adds four migrations.** That statement was scoped to its own milestone and is true of it; read as a permanent rule it forbids exactly the work the owner has now asked for. This is the same conflation Phase 9 itself recorded about Phase 4's "no existing table gains a column", and the wording deserves the same fix in both places.

4. **The registered-setting pattern for media limits is followed by one of three upload routes.** `inventory-media.ts` reads `inventory.media_limits`; `receipt-media.ts` and `documents-media.ts` hardcode 10 MB and note in comments that they decline the pattern. Three upload routes with two different policies is a coin-flip for the fourth.

5. **`document_line_candidates.source_region` was designed for a highlight UI that no backend could feed.** It has been in the schema since migration 0017 with no writer and no reader. This design is the first thing that would populate it — which is a vindication of the original design rather than a criticism, but it means the column has never been exercised and its serialization format is unfixed. Whoever writes the first backend fixes the format for everyone.

## Before implementing this design

1. **Answer open question 1 (the OCR tier) and open question 2 (the role taxonomy) with a human first.** The first decides whether an optional container joins the product's deployment story; the second decides what a `CHECK` constraint contains before any row uses it.
2. **Re-verify every row of the OCR survey.** This is the fastest-moving category any Loxep survey has covered, and several entries were released within weeks of the verification date.
3. **Write the never-auto-commit test for party creation first**, in the shape `packages/documents/test/never-auto-commit.test.ts` already established: prove that no code path reachable from an integration package or a worker task inserts a `counterparties` row. The parse-side invariant has a test; the sync-side one does not, and section 2's boundary is only as real as that test.
4. **Move `confirmLinesAsExpense` into `@loxep/accounting` BEFORE building flow 2**, not after. Building flow 2 against the inline web-layer copy guarantees a second copy, and the third arrives with the acquisition path.
5. **Build the shared `<DocumentPreview>` component before either surface uses it.** The review panel's bare `<img>` is already broken for PDFs; fixing it in two places is how it stays broken in one.
6. **Read the applied migrations, not this document, before writing any column.** Migrations 0006, 0011, and 0017 are the authority for names; this page's DDL sketches are sketches.
7. **Verify drizzle-kit's current support** for a stored generated `tsvector` column and for a partial unique index, and fall back to hand-written SQL rather than weakening either.
8. **Do not widen a media serving route's purpose gate.** Derive the URL from the object's purpose instead; the gates are load-bearing and Phase 9 already had to say this once.
9. **Keep the OCR sidecar's wire types at the integration boundary** (ADR-0009). Whatever JSON the backend returns is normalized inside `@loxep/documents` into `ParseResult`, and no other package ever sees a backend-shaped object.
10. **Assert by test that a parsed line cannot reach `expense_lines` without an actor**, the same way the document invariant is asserted — the new table is a new way to violate the old rule.
11. **Update this document, the roadmap, and Domain Boundaries when implementation reality diverges**, rather than letting the documentation drift.

## Milestones

Staged so each is independently shippable, and so the epic can stop after any of them with a coherent product.

```text
M1  Trading partners as payees        IMPLEMENTED (loxep-cd3.1). migrations 0023 + 0024.
                                      Counterparty payee picker (PayeeComboboxField)
                                      with inline create, mounted on the quick-entry
                                      dialog; "link this payee" on the expense detail
                                      page (bypasses the draft-only lock, like
                                      reattributeDefaults). The Invoice Ninja client
                                      push widened to the full mapping table below,
                                      including the two static id maps and opt-in
                                      private_notes. NOT yet mounted on M2's
                                      /finance/expenses/new (still plain text there —
                                      see that milestone's own note).

M2  The entry page                    IMPLEMENTED (loxep-cd3.2). no migration.
                                      /finance/expenses/new is real: two-pane
                                      layout, multi-file dropzone over the existing
                                      FileUploader, DocumentPreview shared with the
                                      review panel, documents.media_limits setting
                                      (read by both /api/expenses/receipt and
                                      /api/documents/upload), the serving-URL
                                      mapper (servingUrlFor). Quick entry gained its
                                      "More options" link, unchanged otherwise.
                                      Evidence links via a thin
                                      createExpenseWithEvidence wrapper around the
                                      SAME ExpensesService.create / ReceiptsService
                                      .attach quick entry and confirmLinesAsExpense
                                      already use — no forked write path. The payee
                                      field stays plain text pending M1's picker.

M3  Expense lines                     IMPLEMENTED (loxep-cd3.3). migration 0025.
                                      Lines on the page (in-form array) and on
                                      detail (its own add/remove), confirmCandidatesAsExpense
                                      moved into @loxep/accounting (confirm.ts) and
                                      taught to accept an existing expense id.
                                      Flow-2 stamping of DRAGGED candidates is wired
                                      and tested but has no caller yet — M5 builds
                                      the drag UI that supplies candidateIds.

M4  OCR tier A — searchable text      IMPLEMENTED (loxep-cd3.4). migration 0026.
                                      tesseract.js v7 registered as a ReceiptParser
                                      with vendored language data, pdftotext for
                                      existing PDF text layers, documents.parsed_text
                                      / parsed_text_tsv (GENERATED ALWAYS AS ... STORED,
                                      GIN-indexed), the documents.extract-text Graphile
                                      Worker task (enqueued transactionally at upload),
                                      and the q filters on /finance/import and
                                      /finance/expenses plus the expense-detail
                                      ts_headline snippet are all built and tested.
                                      @loxep/app now depends on @loxep/storage, so
                                      the real worker's registered parser set is
                                      manualParser AND ocr_tesseract, the latter's
                                      media reads bound to a real MediaService
                                      (createDefaultParserRegistry,
                                      documents-extraction.ts) — an operator who
                                      opts into ocr_tesseract gets real OCR, proven
                                      end to end against a real tesseract.js run
                                      (packages/app/test/documents-extraction.test.ts).
                                      Real-receipt error measurement (the
                                      milestone's own first task) has not been run
                                      yet — see scripts/measure-ocr-accuracy.ts.

M4+ OCR tier A+ — the sidecar         no migration. Only if M4's measured accuracy is
                                      not good enough: a neural OCR service under an
                                      opt-in Compose profile, registered as a second
                                      ReceiptParser. A setting, not a rewrite.

M5  OCR tier B — drag to field        IMPLEMENTED (loxep-cd3.5). no migration.
                                      `document_line_candidates.source_region` is
                                      populated for the first time: `tsv-lines.ts`
                                      (`@loxep/documents`) groups tesseract's `tsv`
                                      word rows by (page, block, par, line) into
                                      per-line `ParseResultLine`s — description
                                      verbatim, a bounding box from the union of the
                                      line's words, confidence averaged — and
                                      `tesseract-parser.ts`'s `parseImage` now
                                      returns them instead of `lines: []`, from the
                                      SAME `recognize()` call M4 already made (no
                                      second OCR pass). `source-region.ts` fixes the
                                      serialization format the design's own
                                      "contradictions" section flagged as unfixed:
                                      `{"page":1,"x":..,"y":..,"w":..,"h":..}`,
                                      pixel-space in the source image, with a
                                      strict Zod round-trip
                                      (`serializeSourceRegion`/`parseSourceRegion`)
                                      and its own unit suite. PDF stays `lines: []`
                                      — `pdftotext` reports no per-line geometry, so
                                      tier B does not extend to PDFs from this
                                      backend.

                                      `<DocumentPreview>` (`apps/web/src/components/
                                      document-preview.tsx`) gained an `overlay`
                                      mode for `image/*` documents: boxes positioned
                                      as PERCENTAGES of the rendered image's natural
                                      size (the image renders `w-full h-auto`, no
                                      `object-fit: contain` letterboxing, so a
                                      percentage of natural size IS the source-to-
                                      rendered ratio — no manual pixel math or
                                      resize listener needed), hover-synced with an
                                      always-present "Detected lines" list (the
                                      keyboard/click floor — see below), and a
                                      per-line `@dnd-kit/core` `useDraggable`
                                      (`PointerSensor` + `KeyboardSensor`,
                                      `apps/web/src/features/finance/components/
                                      document-line-dnd.tsx`) — the sanctioned drag
                                      library per this milestone's own DND rule, no
                                      hand-rolled `DragEvent`/`dataTransfer`
                                      anywhere. `pdfjs-dist` was NOT added: it needs
                                      a new `apps/web/package.json` dependency,
                                      which this pass's write fence does not
                                      authorize, so the PDF overlay stays exactly
                                      the M2 iframe with its own honest "no overlay
                                      here" caption — a recorded gap, not a silent
                                      one, and it costs nothing today because no PDF
                                      backend produces boxes either.

                                      RULED 2026-08-16 (loxep-ytu, PROVISIONAL):
                                      `pdfjs-dist` stays out. The dependency's only
                                      job is a canvas to draw boxes on, and no
                                      backend emits a PDF line box — tesseract
                                      parses images, `pdftotext` lifts a text layer
                                      without geometry — so the ~4 MB buys an
                                      overlay with nothing to overlay. The decision
                                      reopens on its own trigger: the first backend
                                      that produces PDF line boxes (`pdftotext
                                      -tsv`, or the M4+ neural sidecar's polygons)
                                      reopens the manifest question, not before.

                                      Drop targets, per the design's "drag a line
                                      into LINES, or a value into a field" split:
                                      `/finance/expenses/new` wraps payee
                                      name/amount/category and every line-item
                                      description/amount subfield in a
                                      `DocumentLineDropTarget` (pure UI — a drop
                                      just calls `field.handleChange`, stamping
                                      nothing), plus a SEPARATE "from a receipt"
                                      drop zone in the Line items card that adds a
                                      candidate-linked pinned line
                                      (`createExpenseWithEvidence`'s new
                                      `droppedLines` input). The keyboard/click
                                      equivalent (accessibility floor) is a "Use…"
                                      menu per detected line — "Add to line items" /
                                      "Fill payee name" / "Fill amount" / "Fill
                                      category" — calling the SAME handlers a drop
                                      calls, so nothing reachable by mouse is
                                      unreachable by keyboard.
                                      `document-review-panel.tsx` mounts the SAME
                                      overlay component read-only (no drop target of
                                      its own — that panel's confirm mechanism is
                                      already the disposition `Select` + batch
                                      "Confirm as..." actions), so the two flows
                                      share one presentation mechanism even though
                                      only one of them needed a drop target.

                                      Amount parsing on drop is PROVISIONAL and
                                      client-side only, per the design's own
                                      tier-B/tier-C boundary: `extractProvisionalAmount`
                                      (`document-line-dnd.tsx`) takes the RIGHTMOST
                                      decimal token in the dragged line's text
                                      (`"TAPE 2 @ 3.99 7.98"` -> `"7.98"`) — not
                                      specified by the design, stated as a rule
                                      here because it needed one. A pinned line's
                                      amount is an editable input, not a stamped
                                      value, and an empty one blocks Save with a
                                      toast rather than defaulting to a guess.

                                      **The stamp still happens only at Save, inside
                                      the expense's own transaction, exactly as
                                      designed.** `createExpenseWithEvidence`
                                      (`apps/web/src/server/expense-functions.ts`)
                                      is the M3 status note's own "no caller yet" —
                                      now wired: for each dropped line, it bumps
                                      the candidate's `disposition` to `expense`
                                      (only if not already `expense`/`supplies`)
                                      and fills `line_amount` (only if still null)
                                      via the same raw-SQL pattern `documents-
                                      functions.ts` already uses for this table,
                                      THEN calls `@loxep/accounting`'s
                                      `confirmCandidatesAsExpense` — the identical
                                      function `/finance/import`'s flow 1 calls —
                                      grouped by document, inside the SAME
                                      transaction that creates the expense.
                                      Abandoning the page without saving leaves
                                      every candidate `pending`, exactly as
                                      designed, because nothing was written.

                                      Tests: `packages/documents/test/tsv-lines.test.ts`
                                      and `source-region.test.ts` (unit,
                                      hand-built tsv fixtures plus the
                                      serialization round-trip),
                                      `tesseract-parser.test.ts` extended with a
                                      real-tsv wiring test and updated real-OCR
                                      assertions (lines now non-empty, each with a
                                      `sourceRegion`). `apps/web/e2e/
                                      document-line-drag.spec.ts` runs against the
                                      REAL pipeline (real tesseract.js, the
                                      harness's own worker process): one test
                                      proves a genuine OCR run renders "Detected
                                      lines"; a second drags a real overlay box
                                      (`@dnd-kit`'s `PointerSensor` listens on
                                      native `pointerdown`/`pointermove`, so this
                                      drives `page.mouse` — dnd-kit is not HTML5
                                      `dataTransfer` DnD, so `dispatchEvent`-based
                                      simulation does not apply here) onto a
                                      line-item description field and asserts the
                                      value landed, still on `/finance/expenses/new`
                                      (nothing confirmed by the drop). Enabling
                                      `ocr_tesseract` in the harness reuses the
                                      generic `/settings/application` registered-
                                      setting editor `settings.spec.ts` already
                                      proves works — no dedicated Documents settings
                                      page exists yet, which is itself worth
                                      recording as a gap for a later pass.
                                      Depends on M2, M3, and M4 — all shipped.

M6  Lines to inventory                IMPLEMENTED (loxep-cd3.6). no migration.
                                      confirmCandidatesAsAcquisition in @loxep/inventory
                                      (packages/inventory/src/confirm.ts), mirroring M3's
                                      confirmCandidatesAsExpense shape exactly: one
                                      transaction covering the acquisition (new draft or
                                      an EXISTING one via the lot picker), acquisition_costs
                                      (description -> description, line_amount -> amount,
                                      cost_class 'goods', capitalize true — no freight-
                                      splitting policy invented, per OQ9), the document's
                                      evidence attached as media_links(acquisition,
                                      'invoice') — the first writer of that value — the
                                      candidate stamped target_kind='acquisition' (not
                                      'acquisition_cost': acquisition_costs carries no
                                      document_line_candidate_id column, so the stamp
                                      points at the record an operator can navigate to,
                                      mirroring confirmCandidatesAsExpense's target_id =
                                      expense.id, never a line id), counters recomputed,
                                      document_confirmed emitted, and a required
                                      actorUserId. Same dependency workaround as M3's
                                      confirm.ts: @loxep/inventory does not depend on
                                      @loxep/documents, so document_line_candidates
                                      stamping/counter/event plumbing is reproduced
                                      locally rather than imported. The review panel
                                      (document-review-panel.tsx) opens an
                                      acquisition-lot picker (acquisition-lot-picker.tsx —
                                      existing-lot search plus a create-new-draft inline
                                      form, the PayeeComboboxField inline-create
                                      precedent) the first time an operator dispositions a
                                      line acquisition_cost/inventory_intake, and a
                                      "Confirm as acquisition" action runs ALONGSIDE
                                      "Confirm as expense" — a mixed receipt (three items
                                      to flip, packing tape, tax) runs both actions against
                                      the SAME document rather than one call that mixes
                                      dispositions; each confirm stays homogeneous to its
                                      own target. The candidates-table's disposition
                                      Select no longer says "not yet confirmable here" for
                                      these two dispositions.

                                      NOT built this pass, both flagged rather than
                                      silently skipped: confirmCandidatesAsIntake (the
                                      candidate -> `inventory_items` path, as distinct
                                      from the cost-row write this milestone ships) and
                                      expenses.acquisition_cost_id's void-and-promote
                                      writer (still the contradiction section 4 recorded:
                                      a shipped FK with no writer anywhere). Both landed
                                      in M7 below (loxep-ytu).

M7  Epic tail: intake +               IMPLEMENTED (loxep-ytu). no migration.
    void-and-promote                  Both pieces M6 deliberately deferred.

                                      confirmCandidatesAsIntake, in the SAME
                                      packages/inventory/src/confirm.ts as M6's
                                      confirmCandidatesAsAcquisition (a shared
                                      resolveAcquisitionTarget helper factors their
                                      identical create-new-or-attach-existing lot
                                      resolution — the one refactor this pass made to
                                      M6's own function, behavior-preserving and
                                      covered by its unchanged test suite). Splits what
                                      M6 had folded together: CONFIRMABLE_AS_ACQUISITION
                                      _DISPOSITIONS narrows to {'acquisition_cost'} (a
                                      MONEY fact — freight, tax, a lump-sum lot price —
                                      unchanged, still an acquisition_costs row); the new
                                      CONFIRMABLE_AS_INTAKE_DISPOSITIONS = {
                                      'inventory_intake'} routes to
                                      confirmCandidatesAsIntake, which mints an ACTUAL
                                      inventory_items row per confirmed candidate via
                                      @loxep/inventory's own ItemsService.create — never
                                      a raw INSERT, so a confirmed intake item gets the
                                      identical item-code generation, attribution
                                      resolution, and `receipt` movement (what actually
                                      sets quantity_on_hand) any other intake producer
                                      gets, landing in status='intake' same as the
                                      manual "add item to lot" form and
                                      createAcquisitionFromMarketItem both produce, so
                                      completeIntakeReview remains the one, deliberate,
                                      human-decided exit. Field mapping: description ->
                                      label, quantity -> quantity (defaults to 1 when
                                      absent or non-positive), line_amount ->
                                      acquisitionCostAmount (seeded directly — NOT paired
                                      with an acquisition_costs row, because that would
                                      double the dollar the next time
                                      AcquisitionsService.allocateCosts spreads the lot's
                                      cost pool across its items; this mirrors the
                                      ALREADY-SHIPPED createAcquisitionFromMarketItem
                                      precedent for "known cost carried to item at
                                      intake" rather than inventing a new one). The
                                      candidate stamps target_kind='inventory_item',
                                      target_id=<the item> — the fourth,
                                      previously-unused member of
                                      document_line_candidates.target_kind's CHECK,
                                      reserved since migration 0017 and never written
                                      until this pass. conditionCode/locationId are
                                      batch-level inputs (one dialog value applies to
                                      every item a single confirm call mints, since a
                                      receipt line carries no per-line condition/
                                      location of its own and this milestone ships no
                                      migration to add one) — a real but minor UX
                                      limitation for a batch whose items genuinely
                                      differ, flagged rather than papered over. The
                                      review panel's "Confirm to a lot" card now runs
                                      TWO independent actions against the chosen lot —
                                      "Confirm N as acquisition cost" and "Confirm N as
                                      intake" — alongside the existing "Confirm as
                                      expense" action, so a mixed receipt (three items to
                                      flip, packing tape, tax) is one document, three
                                      records. candidates-table/columns.tsx gained a
                                      target_kind='inventory_item' link-out to
                                      /inventory/stock/$id.

                                      expenses.acquisition_cost_id's void-and-promote
                                      writer: @loxep/accounting's ExpensesService gained
                                      promoteToAcquisitionCost — a DELIBERATELY SEPARATE
                                      method from voidExpense (not an optional parameter
                                      on it), with the identical reason-required,
                                      posted-refuses, already-void-refuses discipline,
                                      PLUS acquisition_cost_id stamped in the SAME
                                      UPDATE statement. Audited as its own action
                                      (accounting.expense.promoted_to_acquisition_cost)
                                      rather than folded into accounting.expense.voided.
                                      The cross-package write (accounting needs a real
                                      acquisition_costs.id; @loxep/accounting must not
                                      depend on @loxep/inventory, mirroring the seam
                                      @loxep/documents keeps toward both) is orchestrated
                                      at apps/web's server-function layer
                                      (promoteExpenseToAcquisitionCost,
                                      expense-functions.ts), SEQUENTIAL calls rather than
                                      one shared transaction — the same posture
                                      createAcquisitionFromMarketItem already documents
                                      and takes for exactly this kind of cross-package
                                      write, accepting a recoverable partial-failure
                                      state (an orphaned acquisition cost with no expense
                                      pointing at it) over reaching into two
                                      independently-transactional service factories'
                                      internals. No new ledger posting is invented: the
                                      void makes the `expense` source fact ineligible
                                      (the next posting-engine sweep reverses whatever it
                                      already posted) and the new acquisition_costs row
                                      is a fresh `acquisition_cost` source fact the SAME
                                      sweep posts under the existing
                                      acquisition_cost_capitalized rule —
                                      source-facts.ts's readAcquisitionCost, whose
                                      superseded_expense_id join already made this
                                      promotion visible from the ledger side, now has a
                                      real writer behind it. The expense-detail page's
                                      existing acquisitionCostId Alert (previously a
                                      "arriving in a later milestone" placeholder) is
                                      wired for real; a new "Promote to acquisition"
                                      button sits beside "Void & re-record", opening the
                                      SAME AcquisitionLotPickerDialog the document-review
                                      panel uses (create-new or attach-existing, identity
                                      resolution only, no write) chained into a
                                      reason-collecting confirm dialog — mirroring
                                      VoidExpenseDialog's own two-step onVoided ->
                                      QuickExpenseDialog chain.

                                      Tests: packages/inventory/test/confirm.test.ts
                                      gained a full confirmCandidatesAsIntake describe
                                      block mirroring M6's own coverage (actor
                                      requirement, create-new/attach-existing, evidence
                                      attach, cancelled-lot refusal, idempotent
                                      double-confirm, partial-reopen, skip rules) plus
                                      intake-specific assertions (quantity defaults,
                                      batch conditionCode, no paired acquisition_costs
                                      row, target_kind='inventory_item'); one existing M6
                                      test's fixture disposition was corrected from
                                      'inventory_intake' to 'acquisition_cost' now that
                                      the two routes split (behavior-preserving — that
                                      test is about the acquisition-cost path).
                                      packages/accounting/test/expenses.test.ts gained a
                                      promoteToAcquisitionCost describe block (happy
                                      path with the audit-event assertion, no-reason
                                      refusal, already-void refusal, and confirming the
                                      guard checks posted/void only — a draft promotes
                                      too). packages/accounting: 297 passed (was 293).
                                      packages/inventory: 181 passed (was 171).
                                      packages/documents: 112 passed, unchanged. apps/web
                                      typecheck/lint/format:check clean.

                                      No PDF-overlay work: `document-preview.tsx` and
                                      pdfjs-dist are untouched by this pass — that
                                      decision belongs to a separate ruling, not this
                                      milestone.
```

M1 and M2 are independent of each other and of the OCR question entirely, which is what makes this design cheap to start and safe to stop.

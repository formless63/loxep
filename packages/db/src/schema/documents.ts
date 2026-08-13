/**
 * The Documents domain's first two tables (Phase 9 milestone 4, loxep-dgf.4).
 *
 * Physical realization of section 2b ("Receipt and invoice parsing") of
 * `apps/docs/src/content/docs/architecture/flipping-lifecycle-design.md`, and
 * the first schema the Domain Boundaries doc's long-standing Documents
 * definition ever gets — see that doc's "Documents" section.
 *
 * ## The one rule everything here exists to make structural
 *
 * **A parse is never a fact.** `@loxep/documents` (the package built over
 * this schema) owns the CANDIDATE stage of extraction and nothing beyond it:
 * it may never write an `expenses`, `acquisitions`, or `inventory_items` row.
 * Confirmation is INVERTED — each consuming domain owns a confirm function
 * that takes candidates and writes its own records, requiring a non-null
 * actor, and stamps back onto `document_line_candidates` which record a
 * confirmation produced. A background job has no actor and therefore
 * cannot confirm anything; that asymmetry is the enforcement mechanism, not
 * a convention layered on top of it.
 *
 * A CSV expense import and a parsed receipt are the SAME shape — `a stored
 * file -> candidate rows -> a human confirms -> domain records` — so both
 * producers share this one pair of tables. The only per-producer difference
 * is that a parsed receipt's candidates carry `confidence`/`source_region`
 * and a CSV's carry `row_fingerprint`; neither difference justifies two
 * mechanisms.
 *
 * ## Conventions inherited, not reinvented
 *
 * uuid PKs with `defaultRandom()`; `numeric(20,6)` money plus a separate ISO
 * currency `char(3)`; state columns as `text` with application-owned
 * TypeScript unions, `CHECK`ed because every one of them is a genuinely
 * closed Loxep-owned set; ADR-0020 user references as nullable `SET NULL`
 * FKs; no `payload`/free-form attribute `jsonb` column anywhere; the
 * kind/reference `CHECK` pattern this design's siblings established
 * (`orders.source_kind`, `expense_allocations`' target check) applied here to
 * tie `source_kind = 'upload'` to `media_object_id` being non-null.
 *
 * `document_date`/`line_date` are `date`, not `timestamptz` — a receipt or a
 * CSV row names a calendar day, not an instant, matching
 * `expenses.expense_date`'s reasoning exactly.
 *
 * ## What is deliberately NOT here
 *
 * - **No `parsed_text` column.** OCR text is a Documents-domain asset the
 *   boundary doc names, and it earns a column only when a backend produces
 *   one. Manual-assisted is the only backend this milestone ships (OQ3,
 *   resolved by owner directive); adding the column now would ship an
 *   always-null claim that Loxep extracts text.
 * - **`target_kind`/`target_id` on `document_line_candidates` is a STAMP, not
 *   a foreign key.** It records which of four different tables a
 *   confirmation produced, and deliberately does not constrain — the same
 *   treatment `journal_entry_source_links` and `media_links.resource_id`
 *   already get, for the same reason and with the same acknowledged cost: an
 *   orphan-detection report is owed alongside it. A real FK across four
 *   nullable target tables would need a `num_nonnulls` discriminator dance
 *   for a row whose entire purpose is an audit crumb.
 * - **`row_fingerprint` is nullable and never a uniqueness constraint.**
 *   `orders` already answered this shape of question — *detect, do not
 *   constrain* — and it is reused verbatim: the CSV importer WARNS when a
 *   fingerprint has already been committed and lets the operator decide
 *   (two identical coffees bought the same day is a real thing).
 */
import { sql } from "drizzle-orm";
import {
  char,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { economicEntities } from "./entities.ts";
import { mediaObjects } from "./storage.ts";

/* ------------------------------------------------------------------ unions */

/** `documents.document_kind` — closed, `CHECK`ed. */
export const DOCUMENT_KINDS = [
  "receipt",
  "invoice",
  "packing_slip",
  "statement",
  "csv_import",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * `documents.source_kind` — closed, `CHECK`ed. `connector` is named now
 * (the eBay purchase-ingestion path lands its own draft acquisitions
 * directly today — loxep-dgf.5 — and does not yet stage through this table)
 * so a future connector-sourced document needs no `CHECK` migration.
 */
export const DOCUMENT_SOURCE_KINDS = ["upload", "csv", "connector"] as const;
export type DocumentSourceKind = (typeof DOCUMENT_SOURCE_KINDS)[number];

/**
 * `documents.status` — closed, `CHECK`ed.
 *
 * ```text
 * pending               staged, not yet parsed (or a CSV with nothing to parse)
 * parsing               a backend is running — unreachable this milestone;
 *                       manual-assisted has no async step, but the member
 *                       ships so a future backend needs no CHECK migration
 * review                candidates exist and at least one still needs a
 *                       disposition
 * partially_confirmed   some but not all candidates confirmed
 * confirmed             every non-discarded candidate confirmed
 * discarded             the whole document was thrown out
 * failed                a backend attempt errored — unreachable this
 *                       milestone, same reasoning as `parsing`
 * ```
 */
export const DOCUMENT_STATUSES = [
  "pending",
  "parsing",
  "review",
  "partially_confirmed",
  "confirmed",
  "discarded",
  "failed",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * `document_line_candidates.disposition` — closed, `CHECK`ed. This is the
 * whole review workflow, and the members are the operator's actual
 * vocabulary, not decoration:
 *
 * ```text
 * pending             not yet reviewed
 * expense             confirms into `@loxep/accounting`'s expenses
 * acquisition_cost    confirms into a NEW or existing acquisition's costs
 * inventory_intake    confirms into an inventory item under an acquisition
 * supplies            an ingested-purchase line that is real spend but not
 *                     stock — confirms into expenses, exactly like `expense`
 * personal            not a business spend at all — never confirms
 * not_mine             the line does not belong to this operator — never confirms
 * duplicate           a detected repeat of an already-confirmed row — never confirms
 * discarded           thrown out for any other reason — never confirms
 * ```
 */
export const LINE_DISPOSITIONS = [
  "pending",
  "expense",
  "acquisition_cost",
  "inventory_intake",
  "supplies",
  "personal",
  "not_mine",
  "duplicate",
  "discarded",
] as const;
export type LineDisposition = (typeof LINE_DISPOSITIONS)[number];

/** `document_line_candidates.target_kind` — closed, `CHECK`ed. See the stamp note above. */
export const CANDIDATE_TARGET_KINDS = [
  "expense",
  "acquisition",
  "acquisition_cost",
  "inventory_item",
] as const;
export type CandidateTargetKind = (typeof CANDIDATE_TARGET_KINDS)[number];

/* ----------------------------------------------------------------- tables */

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    documentKind: text("document_kind").notNull(),
    sourceKind: text("source_kind").notNull(),

    /**
     * Nullable because a CSV import is not a document you look at — the
     * `CHECK` below ties this to `source_kind = 'upload'` so the two states
     * can never be half-recorded.
     */
    mediaObjectId: uuid("media_object_id").references(() => mediaObjects.id),
    originalFilename: text("original_filename"),

    economicEntityId: uuid("economic_entity_id").references(
      () => economicEntities.id,
    ),

    status: text("status").notNull().default("pending"),

    /** The backend that produced any candidates — `'manual'` this milestone. */
    parserId: text("parser_id"),
    parsedAt: timestamp("parsed_at", { withTimezone: true }),

    currency: char("currency", { length: 3 }),
    documentTotal: numeric("document_total", { precision: 20, scale: 6 }),
    documentDate: date("document_date", { mode: "string" }),
    counterpartyName: text("counterparty_name"),

    /**
     * Caches with ONE writer, maintained in the same transaction as every
     * candidate insert/confirm — exactly as `inventory_items.quantity_on_hand`
     * is. They exist because the review queue lists documents and would
     * otherwise aggregate candidates per row.
     */
    lineCount: integer("line_count").notNull().default(0),
    confirmedCount: integer("confirmed_count").notNull().default(0),

    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedByUserId: text("confirmed_by_user_id").references(
      () => user.id,
      { onDelete: "set null" },
    ),

    note: text("note"),

    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "documents_document_kind_check",
      sql`${table.documentKind} in ('receipt', 'invoice', 'packing_slip', 'statement', 'csv_import')`,
    ),
    check(
      "documents_source_kind_check",
      sql`${table.sourceKind} in ('upload', 'csv', 'connector')`,
    ),
    check(
      "documents_status_check",
      sql`${table.status} in ('pending', 'parsing', 'review', 'partially_confirmed', 'confirmed', 'discarded', 'failed')`,
    ),
    check(
      "documents_source_kind_media_object_check",
      sql`(${table.sourceKind} = 'upload') = (${table.mediaObjectId} is not null)`,
    ),
    check(
      "documents_confirmed_count_check",
      sql`${table.confirmedCount} >= 0 and ${table.confirmedCount} <= ${table.lineCount}`,
    ),

    // The review queue's own worklist: everything not yet fully confirmed,
    // newest first. Partial, and small precisely because of the predicate.
    index("documents_status_created_at_idx")
      .on(table.status, table.createdAt.desc())
      .where(sql`${table.status} <> 'confirmed'`),
    index("documents_economic_entity_id_idx")
      .on(table.economicEntityId)
      .where(sql`${table.economicEntityId} is not null`),
  ],
);

export const documentLineCandidates = pgTable(
  "document_line_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),

    /**
     * Populated only by a CSV import, computed by the importer from the
     * row's source values. A DETECTION signal, never a uniqueness
     * constraint — see the module doc.
     */
    rowFingerprint: text("row_fingerprint"),

    description: text("description"),
    quantity: numeric("quantity", { precision: 20, scale: 6 }),
    unitAmount: numeric("unit_amount", { precision: 20, scale: 6 }),
    lineAmount: numeric("line_amount", { precision: 20, scale: 6 }),
    currency: char("currency", { length: 3 }),
    lineDate: date("line_date", { mode: "string" }),

    /** `0..1`, per line. A manual transcription reports `1.0` — a human typed it. */
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    /**
     * A small serialized rectangle (`{"page":1,"x":..}`), presentation only —
     * nothing but the review UI reads it, so it is `text`, not `jsonb`,
     * matching the design's explicit refusal of a free-form attribute bag
     * here.
     */
    sourceRegion: text("source_region"),

    disposition: text("disposition").notNull().default("pending"),
    /** Stamp, not FK — see the module doc. */
    targetKind: text("target_kind"),
    targetId: uuid("target_id"),

    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedByUserId: text("confirmed_by_user_id").references(
      () => user.id,
      { onDelete: "set null" },
    ),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("document_line_candidates_document_id_line_number_uq").on(
      table.documentId,
      table.lineNumber,
    ),
    check(
      "document_line_candidates_disposition_check",
      sql`${table.disposition} in ('pending', 'expense', 'acquisition_cost', 'inventory_intake', 'supplies', 'personal', 'not_mine', 'duplicate', 'discarded')`,
    ),
    check(
      "document_line_candidates_target_kind_check",
      sql`${table.targetKind} is null or ${table.targetKind} in ('expense', 'acquisition', 'acquisition_cost', 'inventory_item')`,
    ),
    check(
      "document_line_candidates_target_pair_check",
      sql`(${table.targetId} is not null) = (${table.targetKind} is not null)`,
    ),
    check(
      "document_line_candidates_confidence_check",
      sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`,
    ),

    index("document_line_candidates_row_fingerprint_idx")
      .on(table.rowFingerprint)
      .where(sql`${table.rowFingerprint} is not null`),
    index("document_line_candidates_disposition_idx")
      .on(table.documentId, table.disposition)
      .where(sql`${table.disposition} = 'pending'`),
  ],
);

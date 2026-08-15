/**
 * Phase 6 counterparties: the outside parties Loxep's economic entities do
 * business with (Customers and counterparties domain).
 *
 * Physical realization of the counterparty half of
 * `apps/docs/src/content/docs/architecture/services-billing-schema-design.md`.
 * **Four tables out of that design's nineteen.** Projects, time entries,
 * billing rates, material uses, service plans, subscriptions, service periods,
 * invoices, invoice lines, invoice sources, and payments are NOT created here:
 * all three of that document's OWNER-REVIEW-CRITICAL open questions are
 * unresolved, and the first of them (where the own-versus-integrate line for
 * invoicing falls) decides whether most of those tables should exist at all.
 *
 * ## The load-bearing rule, made physical
 *
 * A counterparty is not an economic entity. ADR-0017, the Implementation
 * Contract, Domain Boundaries, the Foundational Data Model, cross-domain rule
 * 10, and Master Domain Map section 6 all repeat it in prose; until this file
 * there was no schema to test it against. The test is not "is it an
 * organization" — both usually are — but:
 *
 * ```text
 * Does Loxep attribute this party's activity as OURS, and would it land in one
 * of OUR books as our own revenue, expense, asset, or liability?
 *    yes -> economic_entity   (installation-owned; ADR-0017; Phase 0)
 *    no  -> counterparty      (an outside party; here)
 * ```
 *
 * Four physical rules enforce it, all cheap:
 *
 * 1. **No shared party table and no subtype relationship.** `economic_entities`
 *    and `counterparties` are two tables with two lifecycles. There is no
 *    `parties` supertype, no `party_kind` discriminator, and no view unioning
 *    them.
 * 2. **`counterparties` has no `economic_entity_id`, and `economic_entities`
 *    gains no `counterparty_id`.** Neither record owns the other. The only
 *    place the two concepts meet is {@link counterpartyEntityRoles}, whose row
 *    reads in exactly one direction: *our entity E has relationship R with
 *    outside party C*. There is no row shape that reads the other way.
 * 3. **`tax_identifier` is permitted only on organizations**, by `CHECK`. A
 *    person's tax number is a payroll artefact, payroll is a permanent
 *    non-goal, and the database refuses to hold one.
 * 4. **A mirror is DECLARED.** {@link counterparties.mirrorsEconomicEntityId}
 *    is the one deliberate door in that wall, and its entire purpose is that
 *    the door is visible — see the column's own note.
 *
 * ## `counterparty_sites` ships here now
 *
 * Migration 0011 (`loxep-nw0`) adds `counterparty_sites`: projects now exist
 * as a consumer (`./projects.ts`), so the table this comment used to defer is
 * shipped alongside them. It lives in THIS domain file rather than
 * `projects.ts`, matching the design's own placement — see the design's
 * "A site is owned by the counterparty, not by a project, and a project
 * points at it" and contradiction 7 — and `counterparty_entity_roles` now
 * carries `billing_site_id` alongside `billing_contact_id`, resolving the
 * divergence this comment used to record.
 *
 * ## Tables from the design deliberately still NOT created here
 *
 * ```text
 * counterparty_identifiers  the matching-evidence table. Its whole purpose is
 *                           backfilling orders.counterparty_id, which is an
 *                           ALTER on a Phase 3 table this slice does not make.
 *                           Shipping the evidence table with nothing to match
 *                           into would be a table nobody writes.
 * ```
 *
 * `counterparty_contacts` IS created, despite not being named in this slice's
 * brief, because `contact_channels` is physically undefined without it: its
 * `num_nonnulls(counterparty_id, counterparty_contact_id) = 1` discriminator
 * and both of its uniques reference the contact. Dropping the contact column
 * instead would have silently changed the design's channel model.
 *
 * Conventions inherited unchanged: uuid PKs with `defaultRandom()`, `date` for
 * business dates and `timestamptz` for genuine instants (Phase 5's divergence,
 * adopted), `text` state columns with TypeScript unions, ADR-0020 user
 * references, and no free-form `jsonb`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { economicEntities } from "./entities.ts";

/* ------------------------------------------------------------------ unions */

/**
 * `counterparties.kind` — a two-member closed set WITH a `CHECK`, because the
 * distinction is structural rather than descriptive: an organization has named
 * humans inside it and a person does not.
 *
 * Everything richer — prospect, supplier, agency, landlord — is a role or a
 * note, never a kind. There is deliberately no `customer` member; see
 * {@link counterpartyEntityRoles}.
 */
export const COUNTERPARTY_KINDS = ["person", "organization"] as const;
export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number];

/**
 * `counterparties.status` — closed, `CHECK`ed.
 *
 * `inactive` means "we no longer do business with them"; `archived` means "hide
 * from every picker". Neither deletes anything, and a counterparty is never
 * hard-deleted in normal operation — history points at it.
 */
export const COUNTERPARTY_STATUSES = [
  "active",
  "inactive",
  "archived",
] as const;
export type CounterpartyStatus = (typeof COUNTERPARTY_STATUSES)[number];

/** `counterparties.tax_identifier_kind` — closed, `CHECK`ed, organizations only. */
export const TAX_IDENTIFIER_KINDS = [
  "vat",
  "gst",
  "abn",
  "ein",
  "company_number",
  "other",
] as const;
export type TaxIdentifierKind = (typeof TAX_IDENTIFIER_KINDS)[number];

/** `counterparty_contacts.status` — closed, `CHECK`ed. */
export const CONTACT_STATUSES = ["active", "inactive"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

/**
 * `contact_channels.channel_kind` — closed, `CHECK`ed.
 *
 * One table for every channel kind, not `emails` plus `phones`: every channel
 * answers the same four questions (what is it, whose is it, is it primary, may
 * we contact it), and three tables would multiply the schema to gain nothing.
 */
export const CONTACT_CHANNEL_KINDS = [
  "email",
  "phone",
  "mobile",
  "fax",
  "website",
  "marketplace_handle",
  "messaging",
  "other",
] as const;
export type ContactChannelKind = (typeof CONTACT_CHANNEL_KINDS)[number];

/**
 * `counterparty_entity_roles.role` — a Loxep-owned CLOSED set with a `CHECK`.
 *
 * No provider invents a relationship type, the billing and posting paths branch
 * on `customer`, and an open set would let a typo (`Customer`) silently create
 * a party nobody can invoice.
 */
export const COUNTERPARTY_ROLES = [
  "customer",
  "vendor",
  "payer",
  "payee",
  "consignor",
  "subcontractor",
  "partner",
  "other",
] as const;
export type CounterpartyRole = (typeof COUNTERPARTY_ROLES)[number];

/** `counterparty_entity_roles.status` — closed, `CHECK`ed. */
export const COUNTERPARTY_ROLE_STATUSES = ["active", "inactive"] as const;
export type CounterpartyRoleStatus =
  (typeof COUNTERPARTY_ROLE_STATUSES)[number];

/**
 * Initial `counterparty_entity_roles.tax_treatment` values. TypeScript union,
 * **no** `CHECK`.
 *
 * It records what the operator was told; it calculates nothing. Phase 5's rule
 * holds unchanged: providers calculate, Loxep records.
 */
export const TAX_TREATMENTS = [
  "standard",
  "exempt",
  "reverse_charge",
  "zero_rated",
  "out_of_scope",
] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

/**
 * `counterparty_sites.site_kind` — closed, `CHECK`ed.
 *
 * Addresses and places where work happens: the customer's warehouse, a
 * billing-only address, a remote/no-site row for pure remote work.
 */
export const COUNTERPARTY_SITE_KINDS = [
  "billing",
  "shipping",
  "service",
  "remote",
  "other",
] as const;
export type CounterpartySiteKind = (typeof COUNTERPARTY_SITE_KINDS)[number];

/** `media_links.resource_type` value for media attached to a counterparty. */
export const COUNTERPARTY_RESOURCE_TYPE = "counterparty";
/** `media_links.resource_type` value for media attached to a counterparty site. */
export const COUNTERPARTY_SITE_RESOURCE_TYPE = "counterparty_site";

/* ----------------------------------------------------------------- tables */

export const counterparties = pgTable(
  "counterparties",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** `CP-2026-0117`. Short, human, and not a UUID. */
    referenceCode: text("reference_code").notNull(),

    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    legalName: text("legal_name"),

    /**
     * Case-folded, punctuation-stripped, suffix-normalized (`Ltd`/`Limited`,
     * `Inc`/`Incorporated`, leading `The`).
     *
     * A matching AID, not an identity: it deliberately carries **no unique
     * constraint**, because two genuinely different "Smith Plumbing" businesses
     * are a real thing. It is what the duplicate-candidate report groups by,
     * and the index below exists for exactly that query.
     */
    normalizedName: text("normalized_name").notNull(),

    status: text("status").notNull().default("active"),

    /**
     * A preference, not a constraint. An invoice's currency is its own column,
     * and a customer normally billed in GBP can receive one USD invoice without
     * a schema change.
     */
    defaultCurrency: char("default_currency", { length: 3 }),

    taxIdentifierKind: text("tax_identifier_kind"),
    /** Organizations only, by `CHECK`. Never a personal tax number. */
    taxIdentifier: text("tax_identifier"),

    notes: text("notes"),

    /**
     * The declared intercompany mirror, and the one deliberate door in the wall
     * ADR-0017 builds.
     *
     * It exists for the honest case — an LLC that genuinely bills its own
     * sibling DBA for shared services — and its purpose is that the mirror is
     * VISIBLE. Every profitability and receivable read model can exclude or
     * separately label rows whose counterparty mirrors an entity, so "revenue
     * that is really intercompany" becomes a query instead of a surprise.
     *
     * The argument for the door is that it exists anyway: an operator who needs
     * to invoice their own DBA will create the counterparty with or without
     * this column, and an UNDECLARED mirror is indistinguishable from a real
     * customer while a declared one is a filter. This is the column a reviewer
     * should push on hardest; the design lists it as an open question and the
     * alternative — dropping it and declaring intercompany billing unsupported
     * — is defensible.
     *
     * Note the direction: this points OUTWARD-IN, from the outside record to
     * ours. `economic_entities` gains nothing, not now and not ever.
     */
    mirrorsEconomicEntityId: uuid("mirrors_economic_entity_id"),

    /**
     * The survivor pointer. A merged counterparty is marked, never deleted, and
     * history's foreign keys are never rewritten — see the module note in
     * `@loxep/counterparties/merge.ts` for the resolution contract this column
     * implies.
     */
    mergedIntoCounterpartyId: uuid("merged_into_counterparty_id"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    mergedByUserId: text("merged_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),

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
    /**
     * Named explicitly, here and on three more foreign keys below, because the
     * derived name would exceed PostgreSQL's 63-byte identifier limit and be
     * silently truncated — the same trap `order_fulfillment_lines` hit in
     * Phase 3 and `acquisition_opportunity_links` in Phase 4.
     */
    foreignKey({
      name: "counterparties_merged_into_fk",
      columns: [table.mergedIntoCounterpartyId],
      foreignColumns: [table.id],
    }),
    foreignKey({
      name: "counterparties_mirrors_entity_fk",
      columns: [table.mirrorsEconomicEntityId],
      foreignColumns: [economicEntities.id],
    }),

    unique("counterparties_reference_code_uq").on(table.referenceCode),

    check(
      "counterparties_kind_check",
      sql`${table.kind} in ('person', 'organization')`,
    ),
    check(
      "counterparties_status_check",
      sql`${table.status} in ('active', 'inactive', 'archived')`,
    ),
    /** The boundary, in one line of DDL. */
    check(
      "counterparties_tax_identifier_org_check",
      sql`${table.taxIdentifier} is null or ${table.kind} = 'organization'`,
    ),
    check(
      "counterparties_tax_identifier_pair_check",
      sql`(${table.taxIdentifier} is null) = (${table.taxIdentifierKind} is null)`,
    ),
    check(
      "counterparties_tax_identifier_kind_check",
      sql`${table.taxIdentifierKind} is null or ${table.taxIdentifierKind} in ('vat', 'gst', 'abn', 'ein', 'company_number', 'other')`,
    ),
    check(
      "counterparties_self_merge_check",
      sql`${table.mergedIntoCounterpartyId} is distinct from ${table.id}`,
    ),
    check(
      "counterparties_merge_pair_check",
      sql`(${table.mergedIntoCounterpartyId} is null) = (${table.mergedAt} is null)`,
    ),

    index("counterparties_normalized_name_idx").on(table.normalizedName),
    index("counterparties_merged_into_idx")
      .on(table.mergedIntoCounterpartyId)
      .where(sql`${table.mergedIntoCounterpartyId} is not null`),
    index("counterparties_mirrors_entity_idx")
      .on(table.mirrorsEconomicEntityId)
      .where(sql`${table.mirrorsEconomicEntityId} is not null`),
  ],
);

/** Named humans inside an organization. Deliberately shallow. */
export const counterpartyContacts = pgTable(
  "counterparty_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    counterpartyId: uuid("counterparty_id")
      .notNull()
      .references(() => counterparties.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    /**
     * Added migration 0023, for the Invoice Ninja `contacts[].first_name` /
     * `last_name` parity gap — the ONE field the push adapter had no source
     * for (see `expense-entry-design.md` section 2's mapping table). Both
     * nullable, no backfill, no constraint: `displayName` stays `NOT NULL`
     * and stays authoritative for every Loxep surface, because a contact may
     * legitimately be "Accounts Payable" rather than a person. The adapter
     * sends the split names when present and falls back to putting
     * `displayName` in `first_name` when absent.
     */
    givenName: text("given_name"),
    familyName: text("family_name"),
    roleTitle: text("role_title"),
    isPrimary: boolean("is_primary").notNull().default(false),
    status: text("status").notNull().default("active"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "counterparty_contacts_status_check",
      sql`${table.status} in ('active', 'inactive')`,
    ),
    /** At most one primary contact per party; a partial unique, not a column. */
    uniqueIndex("counterparty_contacts_primary_uq")
      .on(table.counterpartyId)
      .where(sql`${table.isPrimary}`),
    index("counterparty_contacts_counterparty_id_idx").on(table.counterpartyId),
  ],
);

/**
 * Email, phone, handles — attached to a counterparty **or** to a contact, never
 * both.
 *
 * `billing@acme.example` is the organization's; Jane's mobile is Jane's.
 * Allowing both would make "which email do we send the invoice to" ambiguous in
 * exactly the case that matters, so `num_nonnulls(...) = 1` is a `CHECK` — the
 * same discriminator-consistency pattern `order_fees.fee_scope` established.
 */
export const contactChannels = pgTable(
  "contact_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    counterpartyId: uuid("counterparty_id").references(
      () => counterparties.id,
      { onDelete: "cascade" },
    ),
    counterpartyContactId: uuid("counterparty_contact_id"),
    channelKind: text("channel_kind").notNull(),
    /** Exactly what the operator typed. */
    value: text("value").notNull(),
    /** Case-folded and punctuation-stripped per kind; the match probe. */
    normalizedValue: text("normalized_value").notNull(),
    label: text("label"),
    isPrimary: boolean("is_primary").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /**
     * A communication channel that must not be used is a fact worth storing,
     * and deleting the row loses the fact and invites re-adding it. Nothing in
     * this slice sends anything; the column is here so that when something
     * does, the answer is already recorded.
     */
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** Explicitly named: the derived name is 68 bytes. */
    foreignKey({
      name: "contact_channels_contact_fk",
      columns: [table.counterpartyContactId],
      foreignColumns: [counterpartyContacts.id],
    }).onDelete("cascade"),

    check(
      "contact_channels_owner_check",
      sql`num_nonnulls(${table.counterpartyId}, ${table.counterpartyContactId}) = 1`,
    ),
    check(
      "contact_channels_kind_check",
      sql`${table.channelKind} in ('email', 'phone', 'mobile', 'fax', 'website', 'marketplace_handle', 'messaging', 'other')`,
    ),

    /**
     * `UNIQUE ... NULLS NOT DISTINCT` (PostgreSQL 15+, and the deployment target
     * is `timescale/timescaledb:2.29.1-pg18`). Exactly one owner column is
     * non-null by the `CHECK` above, so under PostgreSQL's DEFAULT null handling
     * this constraint would permit the same channel twice — the duplicate it
     * exists to prevent. The precedent is `channel_listings` (0003).
     */
    unique("contact_channels_owner_kind_value_uq")
      .on(
        table.counterpartyId,
        table.counterpartyContactId,
        table.channelKind,
        table.normalizedValue,
      )
      .nullsNotDistinct(),

    /**
     * At most one primary channel per owner per kind.
     *
     * Drizzle's `uniqueIndex` has no `nullsNotDistinct()` — only the constraint
     * form does — and this one must be PARTIAL, so it uses the portable
     * fallback the design itself names for exactly this case: a unique
     * expression index over `coalesce(...)`. The `CHECK` above guarantees
     * `coalesce(counterparty_id, counterparty_contact_id)` is non-null and
     * unambiguous, which makes the expression a total key. Nothing is weakened.
     */
    uniqueIndex("contact_channels_owner_kind_primary_uq")
      .on(
        sql`coalesce(${table.counterpartyId}, ${table.counterpartyContactId})`,
        table.channelKind,
      )
      .where(sql`${table.isPrimary}`),

    index("contact_channels_normalized_value_idx").on(table.normalizedValue),
    index("contact_channels_counterparty_id_idx")
      .on(table.counterpartyId)
      .where(sql`${table.counterpartyId} is not null`),
    index("contact_channels_contact_id_idx")
      .on(table.counterpartyContactId)
      .where(sql`${table.counterpartyContactId} is not null`),
  ],
);

/**
 * Addresses and places where work happens. Owned by the counterparty, not by
 * a project — a project POINTS at a site, so the customer's warehouse
 * survives the job. This is deliberately smaller than Phase 3's and Phase 4's
 * deferred address model implied: free text lines plus `country`/`region`,
 * consistent with Phase 4's shipping analysis and Phase 5's tax context. No
 * address validation, normalization, or geocoding — `latitude`/`longitude`
 * are operator-entered or absent, per `check((latitude is null) = (longitude
 * is null))`.
 */
export const counterpartySites = pgTable(
  "counterparty_sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    counterpartyId: uuid("counterparty_id")
      .notNull()
      .references(() => counterparties.id, { onDelete: "cascade" }),
    /** `ST-2026-0042`. People label things and a UUID is not a label. */
    siteCode: text("site_code").notNull(),
    name: text("name").notNull(),
    siteKind: text("site_kind").notNull(),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    locality: text("locality"),
    region: text("region"),
    postalCode: text("postal_code"),
    country: char("country", { length: 2 }),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    accessNotes: text("access_notes"),
    primaryContactId: uuid("primary_contact_id"),
    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** Explicitly named: the derived name (65 bytes) exceeds the 63-byte limit. */
    foreignKey({
      name: "counterparty_sites_primary_contact_fk",
      columns: [table.primaryContactId],
      foreignColumns: [counterpartyContacts.id],
    }),

    unique("counterparty_sites_site_code_uq").on(table.siteCode),

    check(
      "counterparty_sites_kind_check",
      sql`${table.siteKind} in ('billing', 'shipping', 'service', 'remote', 'other')`,
    ),
    check(
      "counterparty_sites_latlong_pair_check",
      sql`(${table.latitude} is null) = (${table.longitude} is null)`,
    ),

    index("counterparty_sites_counterparty_id_idx")
      .on(table.counterpartyId)
      .where(sql`${table.active}`),
  ],
);

/**
 * How a counterparty becomes a *customer of one of our entities*.
 *
 * There is no `is_customer` / `is_vendor` pair and no `kind = 'customer'`
 * member, because customer and vendor are not properties of a party — they are
 * properties of a RELATIONSHIP with one of our entities, and the same party is
 * routinely both. The estate-sale dealer who sells you pallets and buys back a
 * repaired lamp breaks the flag model on day one; a bare `is_customer` also
 * fails ADR-0017 sideways, because it says a party is a customer *of the
 * installation*, and an installation is not a party to anything.
 *
 * `economic_entity_id` is **nullable**, and that is the contestable half. A
 * null entity reads as *"this relationship holds for the installation
 * generally"* — the same reading `orders.economic_entity_id is null` already
 * has — and it exists because an operator who has attributed nothing yet still
 * has customers, which is the dominant early state under Phase 3's
 * `unattributed` ladder. `unique nulls not distinct` makes the null a real
 * value for uniqueness, so a party cannot hold two installation-wide `customer`
 * rows.
 *
 * Terms live on the relationship, not the party: net-30 with the LLC and cash
 * on delivery with the personal side is a real arrangement, and
 * `payment_terms_days` on `counterparties` would force one of them to be wrong.
 *
 * The role is **not** effective-dated the way `book_entity_links` is:
 * `since_on`/`until_on` are descriptive and there is no exclusion constraint,
 * because nothing ROUTES on a role the way postings route on a book link.
 *
 * `billing_site_id` was deliberately absent through migration 0006, because
 * `counterparty_sites` did not exist yet and "a column pointing at a table
 * that does not exist is worse than no column" — Phase 5's rule, reused.
 * Migration 0011 ships the site table, so it ships here too, alongside
 * `billing_contact_id`.
 */
export const counterpartyEntityRoles = pgTable(
  "counterparty_entity_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    counterpartyId: uuid("counterparty_id").notNull(),
    economicEntityId: uuid("economic_entity_id"),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    sinceOn: date("since_on", { mode: "string" }),
    untilOn: date("until_on", { mode: "string" }),
    paymentTermsDays: integer("payment_terms_days"),
    defaultCurrency: char("default_currency", { length: 3 }),
    /** Open set: TS union, no `CHECK`. Records; never calculates. */
    taxTreatment: text("tax_treatment"),
    billingContactId: uuid("billing_contact_id"),
    /** Added migration 0011, alongside `counterparty_sites`. */
    billingSiteId: uuid("billing_site_id"),
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
    /** All four explicitly named: every derived name is 64–75 bytes. */
    foreignKey({
      name: "counterparty_entity_roles_party_fk",
      columns: [table.counterpartyId],
      foreignColumns: [counterparties.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "counterparty_entity_roles_entity_fk",
      columns: [table.economicEntityId],
      foreignColumns: [economicEntities.id],
    }),
    foreignKey({
      name: "counterparty_entity_roles_billing_contact_fk",
      columns: [table.billingContactId],
      foreignColumns: [counterpartyContacts.id],
    }),
    foreignKey({
      name: "counterparty_entity_roles_billing_site_fk",
      columns: [table.billingSiteId],
      foreignColumns: [counterpartySites.id],
    }),

    unique("counterparty_entity_roles_party_entity_role_uq")
      .on(table.counterpartyId, table.economicEntityId, table.role)
      .nullsNotDistinct(),

    check(
      "counterparty_entity_roles_role_check",
      sql`${table.role} in ('customer', 'vendor', 'payer', 'payee', 'consignor', 'subcontractor', 'partner', 'other')`,
    ),
    check(
      "counterparty_entity_roles_status_check",
      sql`${table.status} in ('active', 'inactive')`,
    ),
    check(
      "counterparty_entity_roles_dates_check",
      sql`${table.untilOn} is null or ${table.sinceOn} is null or ${table.untilOn} >= ${table.sinceOn}`,
    ),
    check(
      "counterparty_entity_roles_terms_check",
      sql`${table.paymentTermsDays} is null or ${table.paymentTermsDays} >= 0`,
    ),

    index("counterparty_entity_roles_counterparty_id_idx").on(
      table.counterpartyId,
    ),
    index("counterparty_entity_roles_entity_role_idx")
      .on(table.economicEntityId, table.role)
      .where(sql`${table.economicEntityId} is not null`),
  ],
);

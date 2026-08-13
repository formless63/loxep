/**
 * Phase 7 Infrastructure control plane — milestones 1 (loxep-lmy.1) and 2
 * (loxep-lmy.2).
 *
 * Physical realization of
 * `apps/docs/src/content/docs/architecture/infrastructure-control-design.md`.
 * That design lists twelve tables; this file now ships **eleven** of them.
 *
 * Milestone 1 (`0012_infrastructure_control_plane`), ordering steps 1, 2, 4, 5,
 * 6, 7:
 *
 *   hosting_targets, managed_domains, dns_records, reconcile_runs,
 *   reconcile_run_steps, dns_drift_findings, provider_operations
 *
 * Milestone 2 (`0013_infrastructure_mail`), ordering steps 3 and 9:
 *
 *   mailbox_templates, mailbox_template_entries, mail_domains, mailboxes
 *
 * plus the one constraint milestone 1 deferred by name:
 * `managed_domains.mailbox_template_id` gains its foreign key, exactly as that
 * migration's header promised.
 *
 * Deliberately NOT here, and why:
 *
 *   dns_provider_tokens, dns_provider_token_zones
 *                              milestone 3 (design ordering step 8)
 *
 * **No existing table gains a column** — the design's own rule. `connections`,
 * `application_secrets`, `monitor_targets`, `audit_events`, and every
 * commercial table are untouched; this domain extends them only through
 * namespaced `config` keys, new `purpose` / `target_type` / `action` text
 * values, and foreign keys pointing *into* them.
 *
 * **No `economic_entity_id` on any table here, deliberately** (ADR-0017 and
 * the design's "Economic entities: none, deliberately"). A nameserver
 * delegation is not attributable activity, and an entity column here would
 * quietly become the access container ADR-0017 forbids.
 *
 * **No money columns and no hypertable.** Infrastructure has no prices (a
 * hosting bill is an `expenses` row), and a DNS record is a statement of
 * intent, not a temporal sample.
 *
 * Conventions inherited unchanged: uuid PKs with `defaultRandom()`,
 * `timestamptz` with semantic names, `text` state columns with TypeScript
 * unions and `CHECK`s only where the set is genuinely closed and Loxep-owned,
 * ADR-0020 nullable `ON DELETE SET NULL` user references, and no free-form
 * attribute `jsonb`.
 *
 * ## PROVISIONAL decisions recorded on loxep-lmy.1
 *
 * The design's open questions 2-5 were resolved by the owner directive
 * "each per its own recommendation, PROVISIONAL". Two of them are visible in
 * this file:
 *
 *   OQ5  recurring cadence lives on the SHARED scheduling model, so
 *        `managed_domains.reconcile_target_id` exists as a real FK to
 *        `monitor_targets` (the design's own recommended shape). No
 *        infrastructure-owned scheduling table, no `next_reconcile_at`.
 *   OQ7  `dns_records`' natural-key unique covers ALL rows including
 *        soft-deleted tombstones; the materializer RESURRECTS a soft-deleted
 *        row rather than inserting a second one.
 *
 * OQ3 (unexpected records are never auto-deleted) and OQ4 (a `pending`
 * `provider_operations` row is resolved by READING the provider back) are
 * service-level rules with no column of their own; they are enforced in
 * `@loxep/infrastructure` and asserted by its tests.
 *
 * ## Foreign-key naming
 *
 * The design requires explicit constraint names "where the generated name
 * would exceed PostgreSQL's 63-byte identifier limit" and names
 * `dns_provider_token_zones` / `mailbox_template_entries` as the candidates.
 * Every generated name in this file was measured. The longest milestone-1 name
 * is `hosting_targets_fronted_by_target_id_hosting_targets_id_fk` (59); the
 * longest milestone-2 name would have been
 * `mailbox_template_entries_template_id_mailbox_templates_id_fk` (60) — inside
 * the limit, with three bytes of headroom and silent truncation as the failure
 * mode, so it is named explicitly as the design asked. The other two long
 * candidates measured 59 (`managed_domains_mailbox_template_id_…_fk`) and 44
 * (`mail_domains_domain_id_managed_domains_id_fk`).
 * `test/schema-infrastructure.test.ts` asserts the limit against the live
 * catalog rather than trusting arithmetic — PostgreSQL truncates silently, so
 * measuring by hand is exactly the wrong tool.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { connections } from "./connections.ts";
import { monitorTargets } from "./monitoring.ts";
import { applicationSecrets } from "./settings.ts";

/* ------------------------------------------------------------------ unions */

/**
 * `managed_domains.state` — CLOSED and `CHECK`ed, because it is a state
 * machine only the reconciler writes. The design's argument: a constraint here
 * is protective rather than restrictive, and widening it is a migration, which
 * is the appropriate ceremony for changing a state machine.
 *
 * The order is the provisioning chain; `state` only ever advances. Health is
 * orthogonal (`last_error_at`, `consecutive_errors`, `drift_detected_at`) —
 * `degraded` is explicitly NOT a state, it is a derived display predicate.
 */
export const MANAGED_DOMAIN_STATES = [
  "draft",
  "zone_created",
  "awaiting_delegation",
  "zone_active",
  "records_synced",
  "mail_pending",
  "ready",
] as const;
export type ManagedDomainState = (typeof MANAGED_DOMAIN_STATES)[number];

/**
 * `dns_records.owner` — CLOSED and `CHECK`ed, and the most consequential
 * column in the schema: it decides what sync may rewrite.
 *
 *   apex / wildcard   materialized from `managed_domains.apex_target_id`
 *   caa               materialized from the installation's CAA issuance policy
 *   mail              materialized from the mail provider's required set
 *   proxy_resource    materialized from reverse-proxy configuration
 *   manual            authored by a human; the reconciler NEVER rewrites or
 *                     deletes it, in any mode
 *
 * ## `caa` is a DOCUMENTED DIVERGENCE from the design's sketch
 *
 * The design lists five owners and no `caa`, yet its materialization rules say
 * *"always: emit the CAA record set from the installation's configured
 * issuance policy"*. Those two statements cannot both hold, so the gap is
 * resolved here rather than papered over.
 *
 * The alternative — labelling a CAA record `apex` — was rejected because it
 * would be actively wrong, not merely inelegant. `apex` is documented as
 * "materialized from `apex_target_id`", and a **mail-only domain has no apex
 * target at all** while still wanting a CAA policy. Overloading the value
 * would make the reconciler delete the CAA record whenever an operator cleared
 * the apex target, which is a live certificate-issuance change triggered by an
 * unrelated edit.
 *
 * Widening a `CHECK` before any row exists is a one-word edit; discovering the
 * overload later is a migration plus a data repair. Flagged in the design
 * document's implementation-status header per the contract's
 * surface-the-conflict rule.
 */
export const DNS_RECORD_OWNERS = [
  "apex",
  "wildcard",
  "caa",
  "mail",
  "proxy_resource",
  "manual",
] as const;
export type DnsRecordOwner = (typeof DNS_RECORD_OWNERS)[number];

/**
 * `dns_records.type` — an OPEN TypeScript union with **no** `CHECK`, and the
 * design is emphatic about why: DNS resource-record types are an IANA
 * registry, not a closed set. A `CHECK` listing today's seven would make a
 * materializer that needs `HTTPS` or `TLSA` next year fail a constraint rather
 * than write a record. Same treatment provider-extensible order statuses get.
 *
 * These members are the ones the materializer emits or the diff engine
 * currently understands; the column accepts any type.
 */
export const DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "TXT",
  "SRV",
  "CAA",
] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number] | (string & {});

/**
 * `hosting_targets.control_surface` — CLOSED and `CHECK`ed; a Loxep-owned
 * taxonomy of how (or whether) Loxep can reach the thing a name points at.
 * `none` is a real, deliberate value: "DNS only, on purpose" rather than
 * "looks unconfigured".
 */
export const HOSTING_CONTROL_SURFACES = [
  "proxy_node",
  "tunnel_client",
  "direct_reverse_proxy",
  "none",
] as const;
export type HostingControlSurface = (typeof HOSTING_CONTROL_SURFACES)[number];

/**
 * `dns_drift_findings.kind` — CLOSED and `CHECK`ed.
 *
 *   missing      intent has it; the provider does not
 *   modified     both have `(type, name)`; content or `proxied` differ
 *   unexpected   the provider has it; intent does not describe it — the class
 *                that cannot be modelled as columns on `dns_records`, which is
 *                the decisive argument for this being a table
 */
export const DNS_DRIFT_KINDS = ["missing", "modified", "unexpected"] as const;
export type DnsDriftKind = (typeof DNS_DRIFT_KINDS)[number];

/**
 * `dns_drift_findings.resolution` — CLOSED and `CHECK`ed.
 *
 *   applied      an `apply` run fixed it at the provider
 *   adopted      the observed value was written into intent as `owner='manual'`
 *   dismissed    acknowledged; ignored until it changes
 *   disappeared  the next run no longer observed it. Resolution is never a
 *                silent delete, because "this drift went away on its own" is
 *                itself worth knowing.
 */
export const DNS_DRIFT_RESOLUTIONS = [
  "applied",
  "adopted",
  "dismissed",
  "disappeared",
] as const;
export type DnsDriftResolution = (typeof DNS_DRIFT_RESOLUTIONS)[number];

/**
 * `reconcile_runs.mode` — the drift/apply switch, promoted from the
 * specification's `applyDiff` parameter to a stored fact. Without it, a reader
 * cannot tell whether a run that found three differences fixed them.
 */
export const RECONCILE_MODES = ["apply", "check"] as const;
export type ReconcileMode = (typeof RECONCILE_MODES)[number];

/** `reconcile_runs.status` — CLOSED and `CHECK`ed. */
export const RECONCILE_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "partial",
] as const;
export type ReconcileStatus = (typeof RECONCILE_STATUSES)[number];

/** `reconcile_runs.subject_type` — CLOSED and `CHECK`ed. */
export const RECONCILE_SUBJECT_TYPES = [
  "domain",
  "hosting_target",
  "token",
] as const;
export type ReconcileSubjectType = (typeof RECONCILE_SUBJECT_TYPES)[number];

/** `reconcile_runs.trigger` — CLOSED and `CHECK`ed. */
export const RECONCILE_TRIGGERS = [
  "intent_change",
  "sweep",
  "manual",
  "poll",
] as const;
export type ReconcileTrigger = (typeof RECONCILE_TRIGGERS)[number];

/**
 * `provider_operations.status` — CLOSED and `CHECK`ed.
 *
 * `pending` is the state the ledger exists to make visible and cannot itself
 * resolve: "we may or may not have created something at the provider". Per the
 * PROVISIONAL resolution of open question 4, a `pending` row is NEVER
 * auto-retried; it is reconciled by READING the provider for the object the
 * operation would have created, keyed by its natural name.
 */
export const PROVIDER_OPERATION_STATUSES = [
  "pending",
  "succeeded",
  "failed",
] as const;
export type ProviderOperationStatus =
  (typeof PROVIDER_OPERATION_STATUSES)[number];

/**
 * The shared-scheduling target type this domain registers (design open
 * question 5, PROVISIONAL: register one target type rather than adding
 * infrastructure-owned scheduling columns). Also declared structurally in
 * `@loxep/market`'s closed target-type list; this constant is the database
 * end of that contract.
 */
export const INFRASTRUCTURE_DOMAIN_RECONCILE_TARGET_TYPE =
  "infrastructure_domain_reconcile";

/**
 * `mailbox_template_entries.kind` and `mailboxes.kind` — CLOSED and `CHECK`ed
 * in both tables (milestone 2, loxep-lmy.2).
 *
 *   mailbox    a real account at the mail provider, with its own password
 *   alias      an address that forwards; no account, no password
 *   catchall   everything not matching a mailbox or alias, forwarded
 *
 * Loxep-owned, and closed on purpose: the three values decide which provider
 * call a sync makes (a user create versus a routing rule), so a fourth value
 * arriving from a provider would have no implementation and must fail loudly
 * at the constraint rather than silently at the switch.
 */
export const MAILBOX_KINDS = ["mailbox", "alias", "catchall"] as const;
export type MailboxKind = (typeof MAILBOX_KINDS)[number];

/** `audit_events.resource_type` values this domain writes. */
export const MANAGED_DOMAIN_RESOURCE_TYPE = "managed_domain";
/** `audit_events.resource_type` values this domain writes. */
export const HOSTING_TARGET_RESOURCE_TYPE = "hosting_target";
/** `audit_events.resource_type` values this domain writes (milestone 2). */
export const MAILBOX_TEMPLATE_RESOURCE_TYPE = "mailbox_template";
/** `audit_events.resource_type` values this domain writes (milestone 2). */
export const MAIL_DOMAIN_RESOURCE_TYPE = "mail_domain";
/** `audit_events.resource_type` values this domain writes (milestone 2). */
export const MAILBOX_RESOURCE_TYPE = "mailbox";

/**
 * `application_secrets.secret_key` for a generated mailbox password, following
 * the design's stated convention `infrastructure.mailbox.<mailboxes.id>`.
 *
 * The value behind this key is WRITE-ONLY: it is minted, handed to the provider
 * once, and stored. No surface reads it back.
 *
 * ADR-0022 (PROVISIONAL) permits a one-time reveal *"in the response to the
 * creating action"* and forbids any read-back after it. Milestone 2's mint has
 * no such response — it happens inside a worker job with no admin waiting on
 * it — so this value is write-only from birth, and a lost one is a rotation.
 */
export function mailboxSecretKey(mailboxId: string): string {
  return `infrastructure.mailbox.${mailboxId}`;
}

/* ----------------------------------------------------------------- tables */

/**
 * A place a name can point at: a node, a tunnel-connected host, a bare server,
 * or explicitly nothing. The specification called this `vps`; the concept
 * covers more than a VPS and one of its values is "no hosting at all".
 *
 * `fronted_by_target_id` is the column that produces the subtle bug if it is
 * missed. When a domain targets a tunnel-connected host, the address record
 * must point at the **fronting node's** address, not the origin's — the origin
 * is reachable only through the tunnel and may have no public address at all.
 * `materializeDesiredRecords` walks this hop.
 *
 * **The fronting relationship is one hop, and PostgreSQL cannot say so
 * declaratively.** The `CHECK` below blocks only the trivial self-loop. A
 * longer cycle, and the rule that a fronting node may not itself be fronted,
 * are enforced in `@loxep/infrastructure`'s target service with a test. Said
 * here because the next reader will assume the constraint covers it. It does
 * not.
 *
 * `inet`, not `text`: PostgreSQL validates and normalizes it, and refuses the
 * malformed value that would otherwise become a published record.
 *
 * `proxy_connection_id` is milestone-3 territory (driving a reverse-proxy or
 * tunnel API). The column ships now because a nullable unused column is
 * cheaper than an `ALTER` later — the design's own reasoning.
 */
export const hostingTargets = pgTable(
  "hosting_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Closed set: see {@link HOSTING_CONTROL_SURFACES}. */
    controlSurface: text("control_surface").notNull(),
    /** A denormalized note (`hetzner`, `ovh`, ...). No provider adapter. */
    provider: text("provider"),
    region: text("region"),
    addressV4: inet("address_v4"),
    addressV6: inet("address_v6"),
    frontedByTargetId: uuid("fronted_by_target_id"),
    proxyConnectionId: uuid("proxy_connection_id").references(
      () => connections.id,
    ),
    externalSiteId: text("external_site_id"),
    notes: text("notes"),
    /** Decommission rather than delete, because history is why this exists. */
    decommissionedAt: timestamp("decommissioned_at", { withTimezone: true }),
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
    foreignKey({
      name: "hosting_targets_fronted_by_target_fk",
      columns: [table.frontedByTargetId],
      foreignColumns: [table.id],
    }),

    unique("hosting_targets_name_uq").on(table.name),

    check(
      "hosting_targets_control_surface_check",
      sql`${table.controlSurface} in ('proxy_node', 'tunnel_client', 'direct_reverse_proxy', 'none')`,
    ),
    // Blocks the trivial self-loop only. Longer cycles are a service guard.
    check(
      "hosting_targets_no_self_front_check",
      sql`${table.frontedByTargetId} is distinct from ${table.id}`,
    ),
    check(
      "hosting_targets_tunnel_client_check",
      sql`(${table.controlSurface} = 'tunnel_client') = (${table.frontedByTargetId} is not null)`,
    ),
    // A target that is not deliberately address-less must be resolvable to
    // something: its own address, or a fronting node's.
    check(
      "hosting_targets_addressable_check",
      sql`${table.controlSurface} = 'none' or ${table.addressV4} is not null or ${table.addressV6} is not null or ${table.frontedByTargetId} is not null`,
    ),

    // The resolution walk.
    index("hosting_targets_fronted_by_target_id_idx")
      .on(table.frontedByTargetId)
      .where(sql`${table.frontedByTargetId} is not null`),
  ],
);

/**
 * One domain name the installation manages. The name is the natural key and is
 * globally unique in the world, so it is unique here too — the precedent is
 * `catalog_items.unique(sku)` being installation-wide rather than scoped.
 *
 * `dns_connection_id` replaces the specification's `cf_account_id`: the DNS
 * provider account is a `connections` row like every other provider account,
 * and its non-secret account identifier lives in `connections.config` exactly
 * as a WooCommerce store URL does. `not null`, deliberately — a domain Loxep
 * cannot reach is not a domain Loxep manages.
 *
 * `apex_target_id` is nullable and that is a **first-class shape**, not an edge
 * case: a mail-only domain (no hosting, mail enabled) is the common case for a
 * portfolio of names. `mail_enabled` is therefore never derived from it.
 *
 * `registrar` is a denormalized text note, not a foreign key, and there is no
 * registrar adapter in this phase (design open question 8). Delegation is
 * verified by reading the DNS provider's own zone status, which is
 * authoritative for whether delegation actually took effect.
 *
 * `zone_nameservers` is one of the few array columns in the schema, and it is
 * justified: an ordered, small, opaque-to-Loxep list displayed verbatim for the
 * operator to paste at the registrar, never joined or filtered on.
 *
 * `provider_zone_status` retains the provider's own status string verbatim —
 * the evidence-preserving role `orders.provider_status_raw` plays. `state` is
 * Loxep's interpretation; this is what the provider actually said.
 */
export const managedDomains = pgTable(
  "managed_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    dnsConnectionId: uuid("dns_connection_id")
      .notNull()
      .references(() => connections.id),
    /** A note, not an integration. Precedent: `acquisitions.vendor_name`. */
    registrar: text("registrar"),
    /** Closed set, written ONLY by the reconciler. See {@link MANAGED_DOMAIN_STATES}. */
    state: text("state").notNull().default("draft"),
    externalZoneId: text("external_zone_id"),
    zoneNameservers: text("zone_nameservers").array(),
    providerZoneStatus: text("provider_zone_status"),
    delegationVerifiedAt: timestamp("delegation_verified_at", {
      withTimezone: true,
    }),
    apexTargetId: uuid("apex_target_id").references(() => hostingTargets.id),
    apexProxied: boolean("apex_proxied").notNull().default(true),
    wildcardProxied: boolean("wildcard_proxied").notNull().default(true),
    mailEnabled: boolean("mail_enabled").notNull().default(true),
    /**
     * Shipped without its foreign key in milestone 1 (`mailbox_templates` did
     * not exist yet); **milestone 2 adds the constraint**, exactly as that
     * migration's header promised. `ADD CONSTRAINT` against an empty
     * relationship is free; `ADD COLUMN` later would not have been.
     */
    mailboxTemplateId: uuid("mailbox_template_id").references(
      () => mailboxTemplates.id,
    ),
    /**
     * Design open question 5, PROVISIONAL: recurring reconcile cadence lives on
     * the shared scheduling model, one `monitor_targets` row per domain with
     * `target_type = 'infrastructure_domain_reconcile'`. The reference points
     * from Infrastructure to the scheduling row — a real foreign key — rather
     * than storing a `domainId` inside `monitor_targets.config`, which would be
     * a JSON reference with no integrity.
     */
    reconcileTargetId: uuid("reconcile_target_id").references(
      () => monitorTargets.id,
    ),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    /** Denormalized rollup so the domain list renders a badge without a
     * correlated subquery per row. Derived; `dns_drift_findings` is
     * authoritative and this may be recomputed from it. */
    driftDetectedAt: timestamp("drift_detected_at", { withTimezone: true }),
    // Health is orthogonal to state — the `connections` / `monitor_targets`
    // shape, which is why `degraded` is not a state and there is no
    // `last_good_state` shadow column.
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
    notes: text("notes"),
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
    unique("managed_domains_name_uq").on(table.name),

    // One Loxep domain per provider zone. Partial, because a domain in
    // `draft` has no zone yet and those nulls must stay distinct.
    uniqueIndex("managed_domains_connection_zone_uq")
      .on(table.dnsConnectionId, table.externalZoneId)
      .where(sql`${table.externalZoneId} is not null`),

    check(
      "managed_domains_state_check",
      sql`${table.state} in ('draft', 'zone_created', 'awaiting_delegation', 'zone_active', 'records_synced', 'mail_pending', 'ready')`,
    ),
    check(
      "managed_domains_consecutive_errors_check",
      sql`${table.consecutiveErrors} >= 0`,
    ),

    // "Needs attention".
    index("managed_domains_unready_state_idx")
      .on(table.state)
      .where(sql`${table.state} <> 'ready'`),
    // The drift badge.
    index("managed_domains_drift_detected_at_idx")
      .on(table.driftDetectedAt)
      .where(sql`${table.driftDetectedAt} is not null`),
  ],
);

/**
 * The **desired** DNS state, and the heart of the design. A pure statement of
 * intent: no observed value is ever written here, which is what keeps a query
 * from reading observation as intent. Observation lives in
 * `dns_drift_findings`.
 *
 * **The unique key is the natural key, not the provider's record id.**
 * `(domain_id, type, name, content)` is what makes sync convergent and is
 * recomputable from either side of the diff. `external_record_id` is captured
 * opportunistically to make updates and deletes cheap, but it is never
 * identity — the same reasoning that keeps provider order ids out of Loxep
 * primary keys.
 *
 * *Index-tuple size, verified per the design's instruction:* a btree index
 * over `content` inherits PostgreSQL's ~2704-byte index-tuple limit, and the
 * failure would be at INSERT, not at sync. Every record class this design
 * materializes is far inside it — an A/AAAA address, a CAA issuer string, and
 * (milestone 2) a mail provider's CNAME and DKIM/SPF TXT values, where even a
 * 2048-bit DKIM public key is roughly 400 characters. The plain unique is
 * therefore kept; the design's fallback (a unique expression index over a hash
 * of `content`) is only warranted if a future record class can exceed it.
 *
 * `ttl_seconds` is **nullable and means seconds**. `NULL` means "let the
 * provider choose", and the adapter translates it to that provider's sentinel.
 * The specification's `ttl integer default 1` encodes one provider's
 * "automatic" sentinel directly into a Loxep table, which is exactly the leak
 * ADR-0009 #5 exists to prevent.
 *
 * `desired_deleted_at` is a **soft delete**: sync must tell "this should be
 * removed from the provider" apart from "this never existed", and the removal
 * is evidence worth keeping. Per the PROVISIONAL resolution of open question 7,
 * the natural-key unique covers tombstones too, and the materializer
 * resurrects a soft-deleted row (clears `desired_deleted_at`) rather than
 * inserting a second one.
 */
export const dnsRecords = pgTable(
  "dns_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => managedDomains.id, { onDelete: "cascade" }),
    /** OPEN set: TS union, **no** `CHECK`. See {@link DNS_RECORD_TYPES}. */
    type: text("type").notNull(),
    name: text("name").notNull(),
    content: text("content").notNull(),
    priority: integer("priority"),
    /** `NULL` = provider default. Never a provider sentinel. */
    ttlSeconds: integer("ttl_seconds"),
    proxied: boolean("proxied").notNull().default(false),
    /** Closed set: see {@link DNS_RECORD_OWNERS}. */
    owner: text("owner").notNull(),
    externalRecordId: text("external_record_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    desiredDeletedAt: timestamp("desired_deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The diff key; the constraint IS the index.
    unique("dns_records_natural_key_uq").on(
      table.domainId,
      table.type,
      table.name,
      table.content,
    ),

    check(
      "dns_records_owner_check",
      sql`${table.owner} in ('apex', 'wildcard', 'caa', 'mail', 'proxy_resource', 'manual')`,
    ),
    /**
     * Belt and braces, and both belts are load-bearing. Proxying a mail
     * provider's key-publication CNAME makes the DNS provider answer with its
     * own addresses instead of resolving through to the key: mail keeps
     * flowing, signature alignment quietly fails, and the symptom is a
     * deliverability problem discovered weeks later. Enforced in the
     * materializer AND here, because a bug that presents that way must be
     * impossible to introduce.
     */
    check(
      "dns_records_mail_not_proxied_check",
      sql`not (${table.owner} = 'mail' and ${table.proxied})`,
    ),
    check(
      "dns_records_ttl_seconds_check",
      sql`${table.ttlSeconds} is null or ${table.ttlSeconds} between 30 and 604800`,
    ),

    // The materialize/sync read: live intent for one domain.
    index("dns_records_domain_id_live_idx")
      .on(table.domainId)
      .where(sql`${table.desiredDeletedAt} is null`),
  ],
);

/**
 * What the reconciler did, step by step. `reconcile_runs` answers "what did the
 * reconciler do about it"; `audit_events` answers "who changed intent"; and
 * `provider_operations` answers "has this exact non-idempotent create ever
 * succeeded". Three genuinely different questions; no two collapse.
 *
 * `subject_id` is intentionally **not** a foreign key: a run against a subject
 * that was later deleted is still evidence, and a `CASCADE` here would delete
 * exactly the history somebody is trying to read. Same reasoning Phase 5 uses
 * for `journal_entry_source_links`.
 */
export const reconcileRuns = pgTable(
  "reconcile_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The task that ran, e.g. `sync-records`. Open set, no `CHECK`. */
    kind: text("kind").notNull(),
    /** Closed set: see {@link RECONCILE_SUBJECT_TYPES}. */
    subjectType: text("subject_type").notNull(),
    /** Deliberately NOT an FK. See the table note. */
    subjectId: uuid("subject_id").notNull(),
    /** Closed set: see {@link RECONCILE_MODES}. The stored `applyDiff`. */
    mode: text("mode").notNull(),
    /** Closed set: see {@link RECONCILE_STATUSES}. */
    status: text("status").notNull().default("running"),
    /** Closed set: see {@link RECONCILE_TRIGGERS}. */
    trigger: text("trigger").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    stepCount: integer("step_count").notNull().default(0),
    /** A taxonomy kind plus a sanitized message. Never a provider payload. */
    errorSummary: text("error_summary"),
  },
  (table) => [
    check(
      "reconcile_runs_mode_check",
      sql`${table.mode} in ('apply', 'check')`,
    ),
    check(
      "reconcile_runs_status_check",
      sql`${table.status} in ('running', 'succeeded', 'failed', 'partial')`,
    ),
    check(
      "reconcile_runs_subject_type_check",
      sql`${table.subjectType} in ('domain', 'hosting_target', 'token')`,
    ),
    check(
      "reconcile_runs_trigger_check",
      sql`${table.trigger} in ('intent_change', 'sweep', 'manual', 'poll')`,
    ),

    // Subject history, newest first.
    index("reconcile_runs_subject_started_at_idx").on(
      table.subjectType,
      table.subjectId,
      table.startedAt.desc(),
    ),
  ],
);

/**
 * One step of a run. `bigserial` because steps are high-volume, append-only,
 * and never referenced by anything.
 *
 * **`request_summary` and `response_summary` are redacted structures produced
 * by a per-adapter redactor**, not raw payloads — the ADR-0021
 * `redactWooOrderFact` / `redactEbayOrderFact` precedent, where the redactor
 * lives next to the knowledge of which fields are sensitive and the domain
 * service accepts only redacted input.
 *
 * What must NEVER appear here: a token value, a mailbox password, an
 * `Authorization` header, or a full request URL carrying credentials in a
 * query string. What should appear: the operation, the record identity, and
 * the values that actually differed. There is a test per adapter asserting
 * this, not a code review.
 *
 * Retention is design open question 9: no automatic deletion in this phase,
 * matching the observation hypertable's stance.
 */
export const reconcileRunSteps = pgTable(
  "reconcile_run_steps",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => reconcileRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    step: text("step").notNull(),
    status: text("status").notNull(),
    provider: text("provider"),
    /** REDACTED structure. See the table note. */
    requestSummary: jsonb("request_summary"),
    /** REDACTED structure. See the table note. */
    responseSummary: jsonb("response_summary"),
    /** One of the adapter's five taxonomy kinds. */
    errorCode: text("error_code"),
    /** Sanitized. Never headers, query strings, or credential material. */
    errorDetail: text("error_detail"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Ordered read, and the idempotency probe for a re-driven run.
    unique("reconcile_run_steps_run_sequence_uq").on(
      table.runId,
      table.sequence,
    ),
    check("reconcile_run_steps_sequence_check", sql`${table.sequence} >= 0`),
  ],
);

/**
 * The persisted output of a reconcile — desired versus observed.
 *
 * A separate table rather than drift columns on `dns_records`, decisively
 * because **`unexpected` drift has no `dns_records` row to hang off**: a record
 * present at the provider that intent never described is the single most
 * important drift class, since it is how a hand-edit in a provider dashboard
 * becomes visible, and columns on the intent row structurally cannot represent
 * it.
 *
 * The partial unique on unresolved findings is what makes a recurring sweep
 * idempotent: the second detection of the same drift updates
 * `last_detected_at` and `last_seen_run_id` rather than inserting a duplicate,
 * so `first_detected_at` answers "how long has this been wrong" — the question
 * an operator actually asks.
 *
 * PROVISIONAL, open question 3: an `unexpected` record is NEVER deleted
 * automatically, in any mode. Its resolutions are `adopted` (write it into
 * `dns_records` as `owner='manual'`), `dismissed`, or an explicit, separate
 * operator delete. An automatic delete is unrecoverable and assumes Loxep's
 * intent is complete — an assumption that is wrong the first time somebody
 * legitimately adds a record in a provider dashboard.
 */
export const dnsDriftFindings = pgTable(
  "dns_drift_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => managedDomains.id, { onDelete: "cascade" }),
    /** NULL exactly when `kind = 'unexpected'` — enforced by `CHECK`. */
    dnsRecordId: uuid("dns_record_id").references(() => dnsRecords.id, {
      onDelete: "cascade",
    }),
    /** Closed set: see {@link DNS_DRIFT_KINDS}. */
    kind: text("kind").notNull(),
    recordType: text("record_type").notNull(),
    recordName: text("record_name").notNull(),
    desiredContent: text("desired_content"),
    observedContent: text("observed_content"),
    desiredProxied: boolean("desired_proxied"),
    observedProxied: boolean("observed_proxied"),
    externalRecordId: text("external_record_id"),
    firstDetectedAt: timestamp("first_detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastDetectedAt: timestamp("last_detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Closed set: see {@link DNS_DRIFT_RESOLUTIONS}. */
    resolution: text("resolution"),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    firstSeenRunId: uuid("first_seen_run_id")
      .notNull()
      .references(() => reconcileRuns.id),
    lastSeenRunId: uuid("last_seen_run_id")
      .notNull()
      .references(() => reconcileRuns.id),
  },
  (table) => [
    check(
      "dns_drift_findings_kind_check",
      sql`${table.kind} in ('missing', 'modified', 'unexpected')`,
    ),
    check(
      "dns_drift_findings_resolution_check",
      sql`${table.resolution} is null or ${table.resolution} in ('applied', 'adopted', 'dismissed', 'disappeared')`,
    ),
    check(
      "dns_drift_findings_resolution_pair_check",
      sql`(${table.resolvedAt} is null) = (${table.resolution} is null)`,
    ),
    // An `unexpected` finding has no intent row by definition; every other
    // kind must have one.
    check(
      "dns_drift_findings_unexpected_record_check",
      sql`(${table.kind} = 'unexpected') = (${table.dnsRecordId} is null)`,
    ),

    // The upsert probe. `coalesce(observed_content, '')` because a `missing`
    // finding has no observed value and NULLs would not collide, which would
    // let an hourly sweep accumulate a row per sweep.
    uniqueIndex("dns_drift_findings_unresolved_uq")
      .on(
        table.domainId,
        table.kind,
        table.recordType,
        table.recordName,
        sql`coalesce(${table.observedContent}, '')`,
      )
      .where(sql`${table.resolvedAt} is null`),

    // The diff panel.
    index("dns_drift_findings_domain_unresolved_idx")
      .on(table.domainId)
      .where(sql`${table.resolvedAt} is null`),
  ],
);

/**
 * The outbound idempotency ledger. Jobs are at-least-once; some provider calls
 * are not idempotent.
 *
 * Any task performing a non-idempotent provider create — a zone, a token, a
 * mailbox, a mail-domain registration — inserts `pending` **before** the call
 * and updates after. On retry a `succeeded` row short-circuits, and a `pending`
 * row is a deliberate decision point rather than a blind retry. This is what
 * stops a worker crash mid-call from creating two zones or two billable
 * mailboxes.
 *
 * The key is a deterministic natural string the task can always recompute from
 * its own inputs.
 *
 * `response_summary` is redacted, and for token creation it must **never**
 * contain the returned value: that value goes to `application_secrets` and
 * nowhere else. This is the single highest-risk line in the design, because
 * the one provider response containing a long-lived credential is also the one
 * a debugging instinct most wants to log.
 *
 * **Ownership note (design open question 6).** Nothing about this table is
 * infrastructure-specific and it carries no infrastructure-specific columns,
 * so promoting it to shared foundation later is a Domain Boundaries edit
 * rather than a migration. It ships Infrastructure-owned and documented as
 * promotable, deliberately the same move scheduling got before Commerce forced
 * the question.
 */
export const providerOperations = pgTable(
  "provider_operations",
  {
    /** Deterministic, recomputable, and the only access path. */
    idempotencyKey: text("idempotency_key").primaryKey(),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    /** Closed set: see {@link PROVIDER_OPERATION_STATUSES}. */
    status: text("status").notNull().default("pending"),
    runId: uuid("run_id").references(() => reconcileRuns.id),
    /** REDACTED. Never a token value. See the table note. */
    responseSummary: jsonb("response_summary"),
    attempts: integer("attempts").notNull().default(1),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "provider_operations_status_check",
      sql`${table.status} in ('pending', 'succeeded', 'failed')`,
    ),
    check("provider_operations_attempts_check", sql`${table.attempts} >= 1`),
    check(
      "provider_operations_completed_at_check",
      sql`(${table.status} = 'pending') = (${table.completedAt} is null)`,
    ),
  ],
);

/* ------------------------------------------------- mail (milestone 2) ---- */

/**
 * The data-driven standard address set — design ordering step 3, independent of
 * every other table.
 *
 * **This is what makes "provision the standard addresses" a setting rather than
 * a deploy.** Edit the template once and every future domain picks it up; the
 * alternative is a hardcoded list inside the materializer that nobody can
 * change without shipping code.
 *
 * `unique(is_default) where is_default` enforces "at most one default"
 * declaratively — a partial unique index over a boolean, which is the standard
 * PostgreSQL idiom for a singleton flag and is preferable to a service-level
 * check that two concurrent writers can both pass.
 */
export const mailboxTemplates = pgTable(
  "mailbox_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("mailbox_templates_name_uq").on(table.name),
    // "At most one default", declaratively.
    uniqueIndex("mailbox_templates_default_uq")
      .on(table.isDefault)
      .where(sql`${table.isDefault}`),
  ],
);

/**
 * One address in a template.
 *
 * `generate_password` is per ENTRY rather than per template, because the
 * distinction it encodes is real: `postmaster` wants a real account with a
 * password, `abuse` is usually an alias that forwards to it, and a template
 * that could not express both would be replaced by a hardcoded list within a
 * month.
 *
 * ## Explicit foreign-key name
 *
 * The design names this table as one of the two candidates for exceeding
 * PostgreSQL's 63-byte identifier limit, so it was measured rather than
 * assumed: the generated name
 * `mailbox_template_entries_template_id_mailbox_templates_id_fk` is 60 bytes —
 * inside the limit, but with three bytes of headroom and a silent truncation as
 * the failure mode. It is named explicitly anyway, which is what the design
 * asked for and costs nothing.
 */
export const mailboxTemplateEntries = pgTable(
  "mailbox_template_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id").notNull(),
    /** Local part only — `postmaster`, never `postmaster@example.com`. */
    localPart: text("local_part").notNull(),
    /** Closed set: see {@link MAILBOX_KINDS}. */
    kind: text("kind").notNull(),
    forwardTo: text("forward_to"),
    generatePassword: boolean("generate_password").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "mailbox_template_entries_template_fk",
      columns: [table.templateId],
      foreignColumns: [mailboxTemplates.id],
    }).onDelete("cascade"),

    unique("mailbox_template_entries_local_part_uq").on(
      table.templateId,
      table.localPart,
    ),

    check(
      "mailbox_template_entries_kind_check",
      sql`${table.kind} in ('mailbox', 'alias', 'catchall')`,
    ),
    // A forwarding kind must say where, and a real mailbox must not: the
    // biconditional catches both halves in one constraint.
    check(
      "mailbox_template_entries_forward_to_check",
      sql`(${table.kind} in ('alias', 'catchall')) = (${table.forwardTo} is not null)`,
    ),
  ],
);

/**
 * Mail-provider registration and ownership-verification state for one domain —
 * design ordering step 9.
 *
 * `domain_id` is the PRIMARY KEY, not a plain foreign key: a managed domain has
 * at most one mail registration, and making that a primary key says so with a
 * constraint instead of a convention.
 *
 * ## `ownership_code` is NOT a secret, and must not be treated as one
 *
 * Its entire purpose is to be published in a public `TXT` record. The design
 * says so explicitly *"so the argument is not had twice"*: it is stored in
 * plaintext `text`, it is safe in a redacted run-step summary, and it must not
 * be moved into `application_secrets`. Verified against Purelymail's own API on
 * 2026-08-13, the code is per-ACCOUNT rather than per-domain (`getOwnershipCode`
 * takes an empty request body), which makes the point even sharper — the same
 * published value proves every domain in the account.
 *
 * ## The verification counters exist because delegation takes days
 *
 * `verify_attempts` / `last_verify_error` / `last_verify_at` are the resumable
 * half of the design's delegation gate. Ownership verification cannot succeed
 * while the registrar still delegates elsewhere, so a failed attempt is an
 * expected intermediate state rather than an error — it is recorded here,
 * surfaced in the UI, and retried by the next bounded poll. It is deliberately
 * NOT a `managed_domains.state` regression: `state` only ever advances.
 */
export const mailDomains = pgTable(
  "mail_domains",
  {
    domainId: uuid("domain_id")
      .primaryKey()
      .references(() => managedDomains.id, { onDelete: "cascade" }),
    mailConnectionId: uuid("mail_connection_id")
      .notNull()
      .references(() => connections.id),
    /** Set when the provider accepted the domain. Evidence, not intent. */
    providerAddedAt: timestamp("provider_added_at", { withTimezone: true }),
    /** PUBLIC by construction. See the table note; never encrypt this. */
    ownershipCode: text("ownership_code"),
    ownershipVerifiedAt: timestamp("ownership_verified_at", {
      withTimezone: true,
    }),
    verifyAttempts: integer("verify_attempts").notNull().default(0),
    /** The adapter's taxonomy kind plus a sanitized message. Never a payload. */
    lastVerifyError: text("last_verify_error"),
    lastVerifyAt: timestamp("last_verify_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("mail_domains_verify_attempts_check", sql`${table.verifyAttempts} >= 0`),
    // Verification implies registration: the provider cannot have verified a
    // domain it never accepted. Ordering made a constraint rather than a
    // comment, because the reconciler advances the two independently.
    check(
      "mail_domains_verified_implies_added_check",
      sql`${table.ownershipVerifiedAt} is null or ${table.providerAddedAt} is not null`,
    ),

    // "Which domains are still waiting on ownership verification" — the
    // bounded poll's work list, and the UI's "needs attention" panel.
    index("mail_domains_unverified_idx")
      .on(table.domainId)
      .where(sql`${table.ownershipVerifiedAt} is null`),
  ],
);

/**
 * The intended mailboxes and aliases for one domain — INTENT, materialized from
 * a template or authored directly, never a mirror of provider state.
 *
 * `secret_id` points at a **logical** `application_secrets` record, never a
 * version row — ADR-0019's rule, and the same shape `storage_backends.secret_id`
 * and `notification_endpoints.secret_id` already use. The generated password is
 * written under `mailboxSecretKey(id)` with the `mailbox_password` purpose.
 *
 * **That secret is write-only.** It is minted, sent to the provider once, and
 * stored; nothing reads it back. ADR-0022 (PROVISIONAL) resolved the design's
 * open question 1 as "reveal-once at mint time, write-only forever after" —
 * and milestone 2's mint happens inside a worker job, where there is no
 * creating response to reveal into, so only the second half applies. A lost
 * password is a rotation, never a recovery.
 *
 * `desired_deleted_at` is a soft delete for the same reason `dns_records` has
 * one: sync must tell "remove this mailbox at the provider" apart from "this
 * mailbox never existed", and a deleted mailbox is exactly the history somebody
 * will need. A mailbox delete is also destructive at the provider in a way a
 * DNS record is not — it takes the mail with it.
 */
export const mailboxes = pgTable(
  "mailboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => managedDomains.id, { onDelete: "cascade" }),
    /** Local part only. The provider is told `local_part@domain`. */
    localPart: text("local_part").notNull(),
    /** Closed set: see {@link MAILBOX_KINDS}. */
    kind: text("kind").notNull(),
    forwardTo: text("forward_to"),
    /** LOGICAL `application_secrets` id (ADR-0019), never a version row. */
    secretId: uuid("secret_id").references(() => applicationSecrets.id),
    providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
    desiredDeletedAt: timestamp("desired_deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The design's index strategy names exactly this one. It covers tombstones
    // for the same reason `dns_records`' natural key does: a re-declared
    // address is RESURRECTED, not inserted a second time (open question 7's
    // resolution, applied to the table that shares its shape).
    unique("mailboxes_domain_local_part_uq").on(table.domainId, table.localPart),

    check(
      "mailboxes_kind_check",
      sql`${table.kind} in ('mailbox', 'alias', 'catchall')`,
    ),
    // Mirrors mailbox_template_entries, deliberately: an intent row derived
    // from a template must not be able to hold a shape its template could not.
    check(
      "mailboxes_forward_to_check",
      sql`(${table.kind} in ('alias', 'catchall')) = (${table.forwardTo} is not null)`,
    ),

    // The sync read: live intent for one domain.
    index("mailboxes_domain_id_live_idx")
      .on(table.domainId)
      .where(sql`${table.desiredDeletedAt} is null`),
  ],
);

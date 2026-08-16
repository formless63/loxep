/**
 * Phase 7 Infrastructure control plane — milestones 1 (loxep-lmy.1), 2
 * (loxep-lmy.2), and 3 (loxep-lmy.3) — plus the Pangolin chain design's
 * milestone 2 (loxep-acj.2).
 *
 * Physical realization of
 * `apps/docs/src/content/docs/architecture/infrastructure-control-design.md`
 * (twelve tables, all shipped) and, for the two tables at the end of this
 * file,
 * `apps/docs/src/content/docs/architecture/pangolin-chain-design.md`'s
 * milestone 2.
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
 * Milestone 3 (`0016_infrastructure_tokens`), ordering step 8:
 *
 *   dns_provider_tokens, dns_provider_token_zones
 *
 * Pangolin chain design, milestone 2 (`0027_proxy_resources`, loxep-acj.2):
 *
 *   proxy_resources, proxy_resource_rules
 *
 * plus the one constraint milestone 1 (loxep-lmy.1) reserved by name:
 * `reconcile_runs.subject_type`'s `CHECK` widens to include `proxy_resource`,
 * exactly as that table's own doc comment promised.
 *
 * Pangolin chain design, milestone 6 (`0028_provisioning_templates`,
 * loxep-acj.6) — the template engine, a COMPILER and a DRIVER, never a
 * second workflow engine:
 *
 *   provisioning_templates, provisioning_template_steps, template_runs,
 *   template_run_steps
 *
 * plus the one constraint the design's own "template run" section names:
 * `reconcile_runs.subject_type`'s `CHECK` widens AGAIN, to include
 * `template_run` — a template run's own driver-pass evidence is an ordinary
 * `reconcile_runs` row (`kind = 'run-provisioning-template'`), exactly the
 * same "one-word edit now; a migration plus data repair later" reasoning
 * `caa` and `proxy_resource` already used on this same column.
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
  primaryKey,
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

/**
 * `reconcile_runs.subject_type` — CLOSED and `CHECK`ed.
 *
 * `proxy_resource` (loxep-acj.2, M2 of the Pangolin chain design) is the one
 * new member: a proxy reconcile run's subject is a single `proxy_resources`
 * row, not the domain it belongs to — a domain may own several resources
 * (one per subdomain), each reconciled and evidenced independently, the same
 * granularity `hosting_target` already uses for the container-host
 * reconciler. Widening this `CHECK` is a one-word migration edit; discovering
 * the overload later is a migration plus a data repair — the same reasoning
 * that gave `dns_records.owner` its `caa` value.
 *
 * `template_run` (loxep-acj.6, M6 of the Pangolin chain design) is the
 * second addition: the provisioning-template driver opens ONE `reconcile_runs`
 * row per drive (per resume), `subject_id = template_runs.id`, so a driver
 * pass is legible next to every other reconciler run on `/infrastructure/
 * runs` — "distinguished by kind", never a parallel history table. The
 * PERSISTENT step ladder (which steps ran, which are blocked, which reconcile
 * run is each step's evidence) lives on `template_run_steps`, not here — this
 * row is one pass's own summary, the same relationship an ordinary
 * `reconcile_runs` row already has to the domain/resource it reconciled.
 */
export const RECONCILE_SUBJECT_TYPES = [
  "domain",
  "hosting_target",
  "token",
  "proxy_resource",
  "template_run",
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

/**
 * `dns_provider_tokens.permission_scope` — CLOSED and `CHECK`ed (milestone 3,
 * loxep-lmy.3).
 *
 * A Loxep-owned LABEL, deliberately not a stored array of provider
 * permission-group identifiers — those are provider constants that belong in
 * the adapter, the same reason provider filter grammar never appears in a
 * `monitor_targets` config. The design states there is exactly one value
 * "initially"; widening this set is a migration, which is the appropriate
 * ceremony for a scope vocabulary that decides what a live host credential
 * may edit.
 */
export const DNS_PROVIDER_TOKEN_SCOPES = ["dns_edit"] as const;
export type DnsProviderTokenScope = (typeof DNS_PROVIDER_TOKEN_SCOPES)[number];

/** `audit_events.resource_type` values this domain writes (milestone 3). */
export const DNS_PROVIDER_TOKEN_RESOURCE_TYPE = "dns_provider_token";

/**
 * `proxy_resources.mode` — Pangolin's own resource-create vocabulary,
 * verbatim (the Pangolin chain design's "Object model" section: `mode:
 * http|ssh|rdp|vnc|tcp|udp`). CLOSED and `CHECK`ed, unlike `dns_records.type`
 * (an open IANA registry): a reverse-proxy resource's mode is a small,
 * provider-PUBLISHED enum rather than an extensible external namespace, and
 * Pangolin's own `http`/`protocol` fields are already deprecated in favor of
 * it — mirroring it structurally rather than leaving it a free-form string
 * catches a typo at the constraint instead of at a failed create.
 */
export const PROXY_RESOURCE_MODES = [
  "http",
  "ssh",
  "rdp",
  "vnc",
  "tcp",
  "udp",
] as const;
export type ProxyResourceMode = (typeof PROXY_RESOURCE_MODES)[number];

/**
 * `proxy_resource_rules.action` — Pangolin's rule vocabulary, verbatim
 * (`action ACCEPT|DROP|PASS`). CLOSED and `CHECK`ed: the API defines exactly
 * three values.
 */
export const PROXY_RULE_ACTIONS = ["ACCEPT", "DROP", "PASS"] as const;
export type ProxyRuleAction = (typeof PROXY_RULE_ACTIONS)[number];

/**
 * `proxy_resource_rules.match` — Pangolin's rule vocabulary, verbatim
 * (`match CIDR|IP|PATH|COUNTRY|COUNTRY_IS_NOT|ASN|REGION`). CLOSED and
 * `CHECK`ed for the same reason {@link PROXY_RESOURCE_MODES} is.
 */
export const PROXY_RULE_MATCHES = [
  "CIDR",
  "IP",
  "PATH",
  "COUNTRY",
  "COUNTRY_IS_NOT",
  "ASN",
  "REGION",
] as const;
export type ProxyRuleMatch = (typeof PROXY_RULE_MATCHES)[number];

/**
 * `proxy_resource_rules.owner` — CLOSED and `CHECK`ed: the `dns_records.owner`
 * precedent applied to a rule SET rather than a single record. The Pangolin
 * chain design's own resolution of open question 7 is why this is a column
 * rather than a comment: *"a rule set is a multi-row set with per-row
 * ownership… which rules may the reconciler rewrite must be a column."*
 *
 *   template     materialized from a provisioning template (a later
 *                milestone; the value exists now so the column never needs
 *                widening for it)
 *   manual       authored by a human; the reconciler NEVER rewrites or
 *                deletes it, in any mode — the exact rule `dns_records.owner`'s
 *                `'manual'` carries
 *   dynamic_ip   materialized from a named IP alias (a later milestone); the
 *                fan-out target when an alias's address changes
 */
export const PROXY_RESOURCE_RULE_OWNERS = [
  "template",
  "manual",
  "dynamic_ip",
] as const;
export type ProxyResourceRuleOwner =
  (typeof PROXY_RESOURCE_RULE_OWNERS)[number];

/** `audit_events.resource_type` value this domain writes (loxep-acj.2). */
export const PROXY_RESOURCE_RESOURCE_TYPE = "proxy_resource";

/**
 * `application_secrets.secret_key` for a minted per-host DNS token, following
 * the design's stated convention `infrastructure.dns_token.<dns_provider_tokens.id>`.
 *
 * Per ADR-0022, the plaintext is shown to the requesting admin exactly once,
 * in the response to the request-scoped mint action — never inside a worker
 * job, which is the gap milestone 2 found and named for this milestone to
 * avoid. After that response, the stored ciphertext is write-only forever;
 * there is no read-back path in any API, server function, or UI.
 */
export function dnsProviderTokenSecretKey(tokenId: string): string {
  return `infrastructure.dns_token.${tokenId}`;
}

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
      sql`${table.subjectType} in ('domain', 'hosting_target', 'token', 'proxy_resource', 'template_run')`,
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

/* ------------------------------------------------ tokens (milestone 3) --- */

/**
 * A narrow, per-host DNS-edit credential the control plane MINTS — design
 * ordering step 8 (milestone 3, loxep-lmy.3).
 *
 * The distinction the design insists is stated flatly: this is not a
 * credential Loxep authenticates with. It is an artifact Loxep PRODUCES, at a
 * host's request, so a process on that host can edit its own zones directly.
 * The high-privilege account credential Loxep itself uses lives in
 * `connections` + `connection_credentials` (`dns_connection_id`, here, is that
 * connection); this table's `secret_id` points at the narrow token instead.
 *
 * **Deliberately NO `created_by_user_id`.** The design's own inherited-
 * conventions section names exactly two tables in this schema that need an
 * ADR-0020 user reference — `managed_domains` and `hosting_targets` — and this
 * is not one of them. Who minted a token is `audit_events`' fact (the mint
 * action's actor), not a column that would duplicate it.
 *
 * ## The value is returned EXACTLY ONCE, and that is a transaction property
 *
 * The provider returns the token's plaintext value only at creation; every
 * subsequent read omits it. `secret_id` must be captured into an
 * `application_secrets` version in the SAME database transaction that writes
 * this row, or the value is unrecoverable and the only remedy is rolling the
 * token — `@loxep/infrastructure`'s `tokens.ts` enforces this with a test.
 * `secret_id` is nullable only for the instant between "the row exists" and
 * "the secret write committed" inside that one transaction; no code outside
 * `tokens.ts` should observe it null.
 *
 * ADR-0022 governs what a human ever sees of that value: reveal-once, in the
 * response to the request-scoped mint action, never from a worker job and
 * never read back afterward. See {@link dnsProviderTokenSecretKey}.
 *
 * ## A policy update REPLACES the whole array — `dns_provider_token_zones` is
 * intent, not a mirror
 *
 * There is no provider call to "add one zone" to an existing token's policy.
 * `dns_provider_token_zones` therefore holds the desired zone SET, and the
 * `infrastructure.sync-token-policy` task rebuilds the provider's policy from
 * it every time — the desired-state pattern applied one level down.
 * `policy_synced_at` records when that rebuild last reached the provider;
 * `dns_provider_token_zones` itself carries no sync timestamp of its own,
 * because the unit of sync is the whole policy, not one row.
 *
 * **Changing scope does not change the value.** Granting a host another zone
 * needs no redeployment; rolling the token does. `last_rolled_at` exists so
 * the UI can show "which hosts would need updating" and style a roll as the
 * destructive, deliberate action it is — the design's explicit instruction
 * that scope editing and token rolling must not be presented as neighbours.
 */
export const dnsProviderTokens = pgTable(
  "dns_provider_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostingTargetId: uuid("hosting_target_id")
      .notNull()
      .references(() => hostingTargets.id),
    dnsConnectionId: uuid("dns_connection_id")
      .notNull()
      .references(() => connections.id),
    /** The provider's own token id — never Loxep's primary key. */
    externalTokenId: text("external_token_id").notNull(),
    name: text("name").notNull(),
    /** Closed set: see {@link DNS_PROVIDER_TOKEN_SCOPES}. */
    permissionScope: text("permission_scope").notNull(),
    /**
     * LOGICAL `application_secrets` id (ADR-0019), never a version row — the
     * same shape `mailboxes.secret_id` uses. Write-only from the caller's
     * perspective; see the table note on the one-time reveal.
     */
    secretId: uuid("secret_id").references(() => applicationSecrets.id),
    policySyncedAt: timestamp("policy_synced_at", { withTimezone: true }),
    lastRolledAt: timestamp("last_rolled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // A provider token id is unique per DNS account, not globally — the same
    // "provider identifiers never become Loxep keys" discipline every other
    // table here follows.
    unique("dns_provider_tokens_connection_external_token_uq").on(
      table.dnsConnectionId,
      table.externalTokenId,
    ),

    check(
      "dns_provider_tokens_permission_scope_check",
      sql`${table.permissionScope} in ('dns_edit')`,
    ),

    // "Which host owns which token" — the fleet detail read.
    index("dns_provider_tokens_hosting_target_id_idx").on(
      table.hostingTargetId,
    ),
  ],
);

/**
 * The zone-scope INTENT for a minted token — design ordering step 8.
 *
 * A pure join, and deliberately not a mirror of the provider's policy: the
 * provider's "update policy" call replaces the entire array in one shot, so
 * this table is what the sync task reads to REBUILD that array, not a cache
 * of what it last pushed. No `synced_at` of its own for that reason —
 * `dns_provider_tokens.policy_synced_at` is the one timestamp that means
 * anything, because the unit of sync is the whole set.
 *
 * ## Explicit foreign-key names
 *
 * The design names this table by name as one of the two candidates for
 * exceeding PostgreSQL's 63-byte identifier limit (the other,
 * `mailbox_template_entries`, shipped in milestone 2). Measured against the
 * live catalog by `test/schema-infrastructure.test.ts` rather than assumed —
 * PostgreSQL truncates silently, which is exactly the failure mode hand
 * arithmetic misses.
 */
export const dnsProviderTokenZones = pgTable(
  "dns_provider_token_zones",
  {
    tokenId: uuid("token_id").notNull(),
    domainId: uuid("domain_id").notNull(),
  },
  (table) => [
    foreignKey({
      name: "dns_provider_token_zones_token_fk",
      columns: [table.tokenId],
      foreignColumns: [dnsProviderTokens.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "dns_provider_token_zones_domain_fk",
      columns: [table.domainId],
      foreignColumns: [managedDomains.id],
    }).onDelete("cascade"),

    // The pair IS the primary key: one row per (token, zone) intent.
    primaryKey({ columns: [table.tokenId, table.domainId] }),
  ],
);

/* -------------------------------------------------- proxy (loxep-acj.2) --- */

/**
 * One desired Pangolin PUBLIC resource — the chain's third link (`domain ->
 * Cloudflare record -> Pangolin resource -> hosting target`,
 * apps/docs/.../architecture/pangolin-chain-design.md). Milestone 2
 * (`loxep-acj.2`) ships this table, its sibling {@link proxyResourceRules},
 * and a CHECK-MODE-ONLY reconciler against both; nothing here is ever
 * applied to Pangolin until a later milestone builds the write-authorization
 * gate (`infrastructure.provider_write_policy`).
 *
 * `hosting_target_id` is the origin this resource fronts. The CONNECTION to
 * reconcile against is resolved from THAT row's `hosting_targets
 * .proxy_connection_id`, never duplicated onto this table — the same "the
 * link is authoritative, not a second column" discipline
 * `container-host-port.ts` documents for `externalHostId`.
 *
 * `domain_id` is the Loxep `managed_domains` row this resource's hostname
 * belongs to, for attribution and for the fleet/domain-detail chain render.
 * `subdomain` is `NULL` for an apex resource — `dns_records`' own
 * apex-is-the-absence-of-a-label convention, read through this column rather
 * than stored as a literal `'@'`.
 *
 * `external_resource_id` and `external_domain_id` are both nullable and both
 * self-retiring, following `container-host-port.ts`'s `externalHostId`
 * bootstrap: the first is Pangolin's own numeric resource id (written the
 * first time a create succeeds or a check-mode plan matches by
 * `(domain_id, subdomain)`); the second is Pangolin's own ORG-SCOPED domain
 * id (`PangolinDomainFact.domainId`, resolved by `resolveDomain`). Neither is
 * `NOT NULL`, because a check-mode-only milestone may declare intent before
 * that resolution has ever run.
 *
 * No `economic_entity_id`, by rule (ADR-0017) — a reverse-proxy resource is
 * not attributable activity.
 */
export const proxyResources = pgTable(
  "proxy_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => managedDomains.id, { onDelete: "cascade" }),
    hostingTargetId: uuid("hosting_target_id")
      .notNull()
      .references(() => hostingTargets.id),
    /** `NULL` = the domain's apex. Zone-relative, matching `dns_records.name`'s convention. */
    subdomain: text("subdomain"),
    /** Closed set: see {@link PROXY_RESOURCE_MODES}. */
    mode: text("mode").notNull().default("http"),
    /** Only meaningful for a raw `tcp`/`udp` resource. */
    proxyPort: integer("proxy_port"),
    ssl: boolean("ssl").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
    /** Self-retiring bootstrap id — see the table doc. */
    externalResourceId: text("external_resource_id"),
    /** Pangolin's own org-scoped domain id — see the table doc. */
    externalDomainId: text("external_domain_id"),
    lastAppliedAt: timestamp("last_applied_at", { withTimezone: true }),
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
    // One resource per (domain, subdomain) — the bootstrap join key
    // `container-host-port.ts`'s doc calls "the NAME", composed here from a
    // fact both sides can independently derive before a create ever happens
    // (Pangolin returns the same value, joined with the domain, as
    // `fullDomain`). `NULLS NOT DISTINCT` so two apex resources on the same
    // domain collide instead of silently coexisting.
    unique("proxy_resources_domain_id_subdomain_uq")
      .on(table.domainId, table.subdomain)
      .nullsNotDistinct(),

    check(
      "proxy_resources_mode_check",
      sql`${table.mode} in ('http', 'ssh', 'rdp', 'vnc', 'tcp', 'udp')`,
    ),

    index("proxy_resources_hosting_target_id_idx").on(table.hostingTargetId),
    index("proxy_resources_domain_id_idx").on(table.domainId),
  ],
);

/**
 * The rule-set INTENT for one {@link proxyResources} row — a multi-row set
 * with PER-ROW ownership, which is precisely what `dns_records.owner`
 * exists to express and what a jsonb array would turn into a code-only
 * convention (the design's resolution of its own open question 7).
 *
 * `value` carries EXACTLY what the operator or a template wrote — a literal
 * (`'203.0.113.7'`) or an alias REFERENCE (`'alias:home'`), resolved only at
 * materialization time by a later milestone. This table never resolves it.
 *
 * `owner = 'manual'` rows are NEVER rewritten or deleted by the reconciler,
 * in any mode — the same rule `dns_records.owner`'s `'manual'` carries.
 *
 * The natural-key unique excludes `priority` deliberately: Pangolin requires
 * `priority` on every rule write and treats it as ordering metadata for an
 * otherwise-identical rule, not part of the rule's identity — the same
 * distinction `dns_records`' natural key draws by excluding `ttl_seconds`.
 * `(proxy_resource_id, action, match, value)` is also what a stuck
 * `provider_operations` row's read-back reconciliation matches on (the
 * design's own read-back rule for a non-idempotent rule create).
 */
export const proxyResourceRules = pgTable(
  "proxy_resource_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proxyResourceId: uuid("proxy_resource_id").notNull(),
    /** Closed set: see {@link PROXY_RULE_ACTIONS}. */
    action: text("action").notNull(),
    /** Closed set: see {@link PROXY_RULE_MATCHES}. */
    match: text("match").notNull(),
    /** A literal or an `alias:<name>` reference. See the table doc. */
    value: text("value").notNull(),
    priority: integer("priority").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Closed set: see {@link PROXY_RESOURCE_RULE_OWNERS}. */
    owner: text("owner").notNull().default("manual"),
    externalRuleId: text("external_rule_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 60 bytes — inside PostgreSQL's 63-byte identifier limit, but with only
    // 3 bytes of headroom and silent truncation as the failure mode, so it
    // is named explicitly, matching `mailbox_template_entries`' and
    // `dns_provider_token_zones`' own precedent at the same margin.
    foreignKey({
      name: "proxy_resource_rules_proxy_resource_fk",
      columns: [table.proxyResourceId],
      foreignColumns: [proxyResources.id],
    }).onDelete("cascade"),

    unique("proxy_resource_rules_natural_key_uq").on(
      table.proxyResourceId,
      table.action,
      table.match,
      table.value,
    ),

    check(
      "proxy_resource_rules_action_check",
      sql`${table.action} in ('ACCEPT', 'DROP', 'PASS')`,
    ),
    check(
      "proxy_resource_rules_match_check",
      sql`${table.match} in ('CIDR', 'IP', 'PATH', 'COUNTRY', 'COUNTRY_IS_NOT', 'ASN', 'REGION')`,
    ),
    check(
      "proxy_resource_rules_owner_check",
      sql`${table.owner} in ('template', 'manual', 'dynamic_ip')`,
    ),
    check("proxy_resource_rules_priority_check", sql`${table.priority} >= 0`),

    index("proxy_resource_rules_proxy_resource_id_idx").on(
      table.proxyResourceId,
    ),
  ],
);

/* ------------------------------------ provisioning templates (loxep-acj.6) */

/**
 * `provisioning_template_steps.step_kind` — CLOSED and `CHECK`ed on purpose:
 * the design's own words are "a template that wants an eighth thing is a
 * template that wants a new service, and the closed set forces that
 * conversation instead of letting `params` grow a scripting language." Each
 * kind maps to an EXISTING service this package already ships:
 *
 * ```text
 * domain.declare          managedDomains.create + updateIntent   (intent only)
 * dns.point-at-target     apex_target_id / proxied flags;
 *                         the materializer does the rest         (intent only)
 * dns.manual-record       addManualRecord                        (intent only)
 * proxy.ensure-resource   proxy_resources intent + reconcile()
 * proxy.ensure-rules      proxy_resource_rules intent + reconcile()
 * mail.enable             enableMail + runMailDomainSync
 * mail.ensure-mailbox     mailbox intent + runMailboxSync
 * ```
 *
 * See `provisioning.ts`'s module doc for exactly how the driver dispatches
 * each kind — this column is the closed vocabulary, not the behavior.
 */
export const PROVISIONING_STEP_KINDS = [
  "domain.declare",
  "dns.point-at-target",
  "dns.manual-record",
  "proxy.ensure-resource",
  "proxy.ensure-rules",
  "mail.enable",
  "mail.ensure-mailbox",
] as const;
export type ProvisioningStepKind = (typeof PROVISIONING_STEP_KINDS)[number];

/**
 * `provisioning_template_steps.provider` / `template_run_steps.provider` —
 * the three providers a compiled step can touch, or `null` for a step that
 * writes only Loxep-owned intent with no provider call this milestone (a
 * `dns.*` step still touches Cloudflare THROUGH the existing record-sync
 * service, so it is NOT `null` — see the vocabulary above; `null` is reserved
 * for a genuinely provider-less step, none of which exist in the closed seven
 * today, kept as a real value because a future Loxep-only step kind should not
 * need a schema change to express "no provider").
 */
export const PROVISIONING_STEP_PROVIDERS = [
  "cloudflare",
  "purelymail",
  "pangolin",
] as const;
export type ProvisioningStepProvider =
  (typeof PROVISIONING_STEP_PROVIDERS)[number];

/** `template_runs.status` — CLOSED and `CHECK`ed. Same four values `reconcile_runs.status` uses, same meanings. */
export const TEMPLATE_RUN_STATUSES = [
  "running",
  "succeeded",
  "partial",
  "failed",
] as const;
export type TemplateRunStatus = (typeof TEMPLATE_RUN_STATUSES)[number];

/**
 * `template_run_steps.status` — CLOSED and `CHECK`ed, and the design's
 * `'blocked'` state is a FIRST-CLASS member here, not a repurposed `'failed'`:
 * never a silent skip, never conflated with a real fault. `'skipped'` is
 * reserved for an `optional` step whose prerequisite never clears — the run
 * still finishes without it, honestly recorded as skipped rather than
 * pretending it succeeded.
 */
export const TEMPLATE_RUN_STEP_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "blocked",
  "failed",
  "skipped",
] as const;
export type TemplateRunStepStatus =
  (typeof TEMPLATE_RUN_STEP_STATUSES)[number];

/**
 * A provisioning template: a NAMED, VERSIONED, strictly ordered list of
 * idempotent steps an operator can run against a fresh set of inputs
 * (`template_runs.inputs`) — "provision a standard domain", data-driven, the
 * same reason `mailbox_templates` exists rather than a hardcoded list
 * (Pangolin chain design, "The template engine").
 *
 * `version` is bumped on every edit to the template's step list —
 * `template_runs.template_version` freezes the value a run started against,
 * so the compiled plan a run is driving never silently changes underfoot.
 *
 * `unique(is_default) where is_default` is `mailbox_templates`' own singleton
 * idiom, copied verbatim: "at most one default", declaratively, immune to two
 * concurrent writers both passing a service-level check.
 *
 * SHIPS UNSEEDED, deliberately, following `mailbox_templates`' own precedent
 * (design open question 10): no migration-authored 'new domain' row. The
 * operator guide is where that step list is described; `/infrastructure/
 * templates/new` (or a "create from example" affordance) is where it becomes
 * a real row, exactly the way an installation's mailbox template starts as
 * "none" rather than a guessed default.
 */
export const provisioningTemplates = pgTable(
  "provisioning_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    version: integer("version").notNull().default(1),
    isDefault: boolean("is_default").notNull().default(false),
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
    unique("provisioning_templates_name_uq").on(table.name),
    // "At most one default", declaratively — `mailbox_templates_default_uq`'s
    // own idiom.
    uniqueIndex("provisioning_templates_default_uq")
      .on(table.isDefault)
      .where(sql`${table.isDefault}`),
    check("provisioning_templates_version_check", sql`${table.version} >= 1`),
  ],
);

/**
 * One step of a template's DEFINITION — never a run's own step; see
 * {@link templateRunSteps} for that. `params` is `jsonb` and that is
 * deliberate: "the parameters of 'create a resource named `$name` with rule
 * set `$rules`' are genuinely heterogeneous across step kinds, and columns
 * for the union of them would be the 'shared table containing unrelated
 * optional columns' cross-domain rule 5 forbids." It is safe because
 * `step_kind` is closed and `CHECK`ed, so every jsonb shape has exactly one
 * zod schema that parses it (`provisioning.ts`'s `provisioningStepParamsSchemas`,
 * the same closed-union-plus-per-member-schema discipline
 * `monitorTargetConfigSchemas` uses for `monitor_targets.config`) — an
 * unknown kind fails at the `CHECK` constraint, never at a runtime switch
 * statement with no `default` arm.
 *
 * `optional` — a blocked or failed optional step does not stop the REST of
 * the plan from being judged complete; the run can still finish `succeeded`
 * around it. Every step in the seeded 'new domain' example is non-optional
 * (`optional = false`), because each one is load-bearing for that template's
 * own promise.
 */
export const provisioningTemplateSteps = pgTable(
  "provisioning_template_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id").notNull(),
    sequence: integer("sequence").notNull(),
    /** Closed set: see {@link PROVISIONING_STEP_KINDS}. */
    stepKind: text("step_kind").notNull(),
    /** Closed set or `NULL`: see {@link PROVISIONING_STEP_PROVIDERS}. */
    provider: text("provider"),
    /** Loxep-owned; one zod schema per `step_kind`. See the table doc. */
    params: jsonb("params").notNull().default({}),
    optional: boolean("optional").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "provisioning_template_steps_template_fk",
      columns: [table.templateId],
      foreignColumns: [provisioningTemplates.id],
    }).onDelete("cascade"),

    unique("provisioning_template_steps_sequence_uq").on(
      table.templateId,
      table.sequence,
    ),

    check(
      "provisioning_template_steps_kind_check",
      sql`${table.stepKind} in ('domain.declare', 'dns.point-at-target', 'dns.manual-record', 'proxy.ensure-resource', 'proxy.ensure-rules', 'mail.enable', 'mail.ensure-mailbox')`,
    ),
    check(
      "provisioning_template_steps_provider_check",
      sql`${table.provider} is null or ${table.provider} in ('cloudflare', 'purelymail', 'pangolin')`,
    ),
    check(
      "provisioning_template_steps_sequence_check",
      sql`${table.sequence} >= 0`,
    ),

    index("provisioning_template_steps_template_id_idx").on(table.templateId),
  ],
);

/**
 * One RUN of a template against a concrete set of inputs.
 *
 * `compiled_plan` is the single most important column in this design: it is
 * the FROZEN step list, resolved against the template at start. "Freezing the
 * plan at start is what makes a run reproducible after a template edit, what
 * makes 'resume' mean the same thing three days later, and what lets the UI
 * show the whole ladder — including steps not yet reached — instead of only
 * what has happened." A template edited mid-run therefore cannot change a
 * running run: the driver reads `compiled_plan`, never `provisioning_template_steps`,
 * once a run exists. Its shape mirrors `provisioning.ts`'s `CompiledStep[]` —
 * kept as untyped `jsonb` here (like `reconcile_run_steps.request_summary`)
 * because validating it is the COMPILER's job, at write time, not a `CHECK`
 * constraint's.
 *
 * `template_version` is the template's `version` at compile time — evidence
 * of which edit of the template this run was compiled against, independent of
 * whether the template has since been edited again.
 */
export const templateRuns = pgTable(
  "template_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id").notNull(),
    templateVersion: integer("template_version").notNull(),
    /** The operator's answers, e.g. `{domain: 'example.com', ...}`. */
    inputs: jsonb("inputs").notNull().default({}),
    /** The FROZEN step list. See the table doc — never re-read from the template. */
    compiledPlan: jsonb("compiled_plan").notNull(),
    /** Closed set: see {@link TEMPLATE_RUN_STATUSES}. */
    status: text("status").notNull().default("running"),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "template_runs_template_fk",
      columns: [table.templateId],
      foreignColumns: [provisioningTemplates.id],
      // Deliberately NOT cascade: a template's run history is evidence that
      // outlives an edit, matching `dns_drift_findings`' `first_seen_run_id`/
      // `last_seen_run_id` reasoning for `reconcile_runs` — the default
      // (`NO ACTION`) simply means a template with runs cannot be deleted
      // out from under them, which this design's own "no teardown" stance
      // treats as correct rather than inconvenient.
    }),

    check(
      "template_runs_status_check",
      sql`${table.status} in ('running', 'succeeded', 'partial', 'failed')`,
    ),
    check(
      "template_runs_template_version_check",
      sql`${table.templateVersion} >= 1`,
    ),

    index("template_runs_template_id_idx").on(table.templateId),
    index("template_runs_status_idx").on(table.status),
  ],
);

/**
 * One step of one RUN — the persistent ladder `/infrastructure/templates/
 * $id/run/$runId` renders, distinct from {@link provisioningTemplateSteps}
 * (the template's own DEFINITION). Copied verbatim from `compiled_plan` at
 * start (`step_kind`/`provider` never change after that), then advanced by
 * the driver task exactly as far as it currently can on each pass.
 *
 * `reconcile_run_id` is the second most important column in this design: "a
 * template step does not invent its own evidence." A `dns.point-at-target`
 * step's evidence is an ordinary `reconcile_runs` row of kind `sync-records`,
 * identical to one an operator's manual re-sync would produce — this column
 * is that link, and it is what keeps this from being a second execution
 * engine: the template run is a SPINE, the reconcile runs it points at are
 * the VERTEBRAE. `NULL` for a step with no reconciler run of its own
 * (`domain.declare` writes Loxep-owned intent only — see `provisioning.ts`).
 *
 * `blocked_reason` is deliberately an OPEN `text` column, not `CHECK`ed —
 * the design's own list ("`'credential_scope' | 'awaiting_delegation' |
 * 'write_policy' | …'`") is explicitly non-exhaustive, the same open-taxonomy
 * treatment `reconcile_run_steps.error_code` already gets, because a NEW
 * blocked reason should never need a migration to express — only new,
 * legible copy at the call site.
 */
export const templateRunSteps = pgTable(
  "template_run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    /** Closed set: see {@link PROVISIONING_STEP_KINDS}. Copied from `compiled_plan` at start. */
    stepKind: text("step_kind").notNull(),
    /** Closed set or `NULL`: see {@link PROVISIONING_STEP_PROVIDERS}. */
    provider: text("provider"),
    /** Closed set: see {@link TEMPLATE_RUN_STEP_STATUSES}. */
    status: text("status").notNull().default("pending"),
    /** Open taxonomy. See the table doc. `NULL` unless `status = 'blocked'`. */
    blockedReason: text("blocked_reason"),
    /** This step's EVIDENCE — an ordinary `reconcile_runs` row. See the table doc. */
    reconcileRunId: uuid("reconcile_run_id"),
    /** Set when this step made a non-idempotent provider create, ledgered through `provider_operations`. */
    providerOperationKey: text("provider_operation_key"),
    /** One of the adapter's taxonomy kinds, or a Loxep-owned reason code. */
    errorCode: text("error_code"),
    /** Sanitized. Never headers, query strings, or credential material — same discipline as `reconcile_run_steps.error_detail`. */
    errorDetail: text("error_detail"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "template_run_steps_run_fk",
      columns: [table.runId],
      foreignColumns: [templateRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "template_run_steps_reconcile_run_fk",
      columns: [table.reconcileRunId],
      foreignColumns: [reconcileRuns.id],
      // Deliberately NOT cascade: `reconcile_runs` rows are never deleted
      // (same "history is not deleted" stance as `dns_drift_findings`'
      // `first_seen_run_id` FK above), so this can never actually fire — but
      // the default (no action) is still the right one to state explicitly.
    }),
    foreignKey({
      name: "template_run_steps_provider_operation_fk",
      columns: [table.providerOperationKey],
      foreignColumns: [providerOperations.idempotencyKey],
    }),

    unique("template_run_steps_sequence_uq").on(table.runId, table.sequence),

    check(
      "template_run_steps_kind_check",
      sql`${table.stepKind} in ('domain.declare', 'dns.point-at-target', 'dns.manual-record', 'proxy.ensure-resource', 'proxy.ensure-rules', 'mail.enable', 'mail.ensure-mailbox')`,
    ),
    check(
      "template_run_steps_provider_check",
      sql`${table.provider} is null or ${table.provider} in ('cloudflare', 'purelymail', 'pangolin')`,
    ),
    check(
      "template_run_steps_status_check",
      sql`${table.status} in ('pending', 'running', 'succeeded', 'blocked', 'failed', 'skipped')`,
    ),
    check(
      "template_run_steps_blocked_reason_check",
      sql`(${table.status} = 'blocked') = (${table.blockedReason} is not null)`,
    ),
    check(
      "template_run_steps_sequence_check",
      sql`${table.sequence} >= 0`,
    ),

    index("template_run_steps_run_id_idx").on(table.runId),
  ],
);

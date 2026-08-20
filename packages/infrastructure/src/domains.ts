/**
 * Managed domains and their desired DNS records — the operator INTENT services.
 *
 * Two properties this module exists to guarantee, both of which are silent
 * when they break:
 *
 * ## 1. Intent change and job enqueue commit atomically
 *
 * ```text
 * BEGIN
 *   UPDATE managed_domains SET apex_target_id = ... WHERE id = ...
 *   enqueue(tx, 'infrastructure.materialize-records', { domainId })
 * COMMIT
 * ```
 *
 * Graphile Worker's queue is a table in the same database, which is why
 * ADR-0003 chose it: there is no outbox and no "the row changed but the job
 * never fired" class of bug. **The way to lose the guarantee silently is to
 * enqueue through a separate pool client** rather than the transaction handle,
 * so the enqueuer is a port taking the transaction handle, and
 * `test/intent.test.ts` asserts that a rolled-back intent change leaves no job
 * behind. Otherwise the property is a comment, not a behavior.
 *
 * ## 2. `state` is written only by the reconciler
 *
 * No function here sets `managed_domains.state`. A UI action changes intent;
 * the reconciler moves the state. That is the same discipline Phase 3 applies
 * to `orders.entity_attribution_source`, and it is enforced structurally —
 * `state` is not in any input schema below.
 *
 * ## Soft-deleted records are RESURRECTED, never re-inserted
 *
 * Open question 7, resolved PROVISIONAL: the natural-key unique covers
 * tombstones, so re-declaring a record that was soft-deleted must clear
 * `desired_deleted_at` on the existing row. Inserting would collide with the
 * tombstone; a partial unique would instead permit an unbounded pile of them
 * and make "has this ever been declared" a scan.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { dnsRecords, managedDomains } from "@loxep/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  InfrastructureNotFoundError,
  InfrastructureValidationError,
} from "./errors.ts";
import type { DesiredRecord } from "./materialize.ts";

export type ManagedDomainRow = typeof managedDomains.$inferSelect;
export type DnsRecordRow = typeof dnsRecords.$inferSelect;

/** `audit_events.resource_type` for this table. */
export const MANAGED_DOMAIN_RESOURCE_TYPE = "managed_domain";

/** Graphile task names, per the design's job graph. */
export const MATERIALIZE_RECORDS_TASK = "infrastructure.materialize-records";
export const SYNC_RECORDS_TASK = "infrastructure.sync-records";

/**
 * The transactional enqueue seam. The implementation MUST issue its insert
 * through the same transaction handle it is given; the composition root wires
 * the Graphile-backed one, and tests wire a recorder.
 */
export type TransactionalEnqueue = (
  tx: Pick<LoxepDb, "execute">,
  taskName: string,
  payload: Record<string, unknown>,
  options?: { jobKey?: string; jobKeyMode?: "replace" | "preserve_run_at" },
) => Promise<void>;

/**
 * `@loxep/jobs`' `jobKeyFor` shape, re-declared so this module does not depend
 * on the jobs runtime just to build a string. The design's job graph fixes
 * these keys: `domain:{id}:materialize`, `domain:{id}:records`.
 */
export function domainJobKey(taskName: string, domainId: string): string {
  return `${taskName}:domain:${domainId}`;
}

/**
 * A domain name, lowercased and validated shallowly.
 *
 * Deliberately not an exhaustive DNS grammar: the provider is the authority on
 * what it will accept, and a strict local regex would reject a valid IDN or a
 * new TLD long before the provider would. What IS enforced is the pair of
 * shapes that silently break a natural key — a trailing dot and a leading or
 * embedded upper-case letter, both of which would make the same domain look
 * like two rows.
 */
const domainNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((value) => value.replace(/\.$/, "").toLowerCase())
  .refine((value) => value.includes("."), {
    message: "a managed domain name must contain at least one dot",
  })
  .refine((value) => !value.includes(" "), {
    message: "a managed domain name must not contain spaces",
  });

const createDomainSchema = z.strictObject({
  name: domainNameSchema,
  dnsConnectionId: z.string().uuid(),
  registrar: z.string().trim().min(1).nullish(),
  apexTargetId: z.string().uuid().nullish(),
  apexProxied: z.boolean().optional(),
  wildcardProxied: z.boolean().optional(),
  mailEnabled: z.boolean().optional(),
  notes: z.string().trim().min(1).nullish(),
  createdByUserId: z.string().min(1).nullish(),
});

export type CreateManagedDomainInput = z.input<typeof createDomainSchema>;

const updateIntentSchema = z
  .strictObject({
    apexTargetId: z.string().uuid().nullish(),
    apexProxied: z.boolean().optional(),
    wildcardProxied: z.boolean().optional(),
    mailEnabled: z.boolean().optional(),
    registrar: z.string().trim().min(1).nullish(),
    notes: z.string().trim().min(1).nullish(),
    actorUserId: z.string().min(1).nullish(),
  })
  .refine(
    (value) =>
      Object.keys(value).some(
        (key) => key !== "actorUserId" && value[key as keyof typeof value] !== undefined,
      ),
    { message: "empty intent update" },
  );

export type UpdateDomainIntentInput = z.input<typeof updateIntentSchema>;

/**
 * `loxep-8f8`'s "attach an existing zone" input. Deliberately NOT run
 * through {@link updateIntentSchema}/`updateIntent`: attaching a zone is not
 * an intent change the reconciler should react to (it enqueues nothing —
 * see {@link ManagedDomainsService.attachZone}'s own doc), and its fields
 * (`externalZoneId`, `providerZoneStatus`, `zoneNameservers`) are exactly the
 * ones `updateIntentSchema`'s `.strictObject` already refuses.
 */
const attachZoneSchema = z.strictObject({
  externalZoneId: z.string().trim().min(1),
  /** The provider's own status string, verbatim — retained exactly as
   * `provisioning.ts`'s `dispatchDomainDeclare` step already does. */
  providerZoneStatus: z.string().trim().min(1).nullish(),
  /** Ordered, opaque — `CloudflareZoneFact.nameservers`, when the caller has it. */
  zoneNameservers: z.array(z.string().trim().min(1)).nullish(),
  /**
   * Required to overwrite an ALREADY-SET `external_zone_id` with a
   * DIFFERENT one. Re-attaching the SAME zone id never needs it — that path
   * is idempotent by construction, not a replace.
   */
  replace: z.boolean().optional(),
  actorUserId: z.string().min(1).nullish(),
});

export type AttachZoneInput = z.input<typeof attachZoneSchema>;

/** A manual record an operator authored, or one adopted from observed drift. */
export interface ManualRecordInput {
  type: string;
  name: string;
  content: string;
  ttlSeconds?: number | null;
  priority?: number | null;
  proxied?: boolean;
  externalRecordId?: string | null;
}

export interface ManagedDomainsService {
  create(input: CreateManagedDomainInput): Promise<ManagedDomainRow>;
  get(id: string): Promise<ManagedDomainRow>;
  findByName(name: string): Promise<ManagedDomainRow | null>;
  list(): Promise<ManagedDomainRow[]>;
  /** Changes intent and enqueues a re-materialize, atomically. */
  updateIntent(
    id: string,
    input: UpdateDomainIntentInput,
  ): Promise<ManagedDomainRow>;
  /**
   * `loxep-8f8`: attach a zone the operator already has at the DNS
   * provider — option (b) of the three the design's job-graph note weighs,
   * chosen because the owner's zones already exist at Cloudflare and
   * `ensure-zone`/`provision-domain` remain unbuilt tasks. Writes
   * `external_zone_id` (+ whatever of `provider_zone_status`/
   * `zone_nameservers` the caller has) so `createRecordSyncService.run()` no
   * longer refuses this domain. Mirrors the ONE existing writer
   * (`provisioning.ts`'s `dispatchDomainDeclare` step) in every way except
   * that it takes an already-resolved zone rather than resolving one itself
   * — the caller (an estate-style Cloudflare zone list, per Rule P11) has
   * already made the provider READ.
   *
   * IDEMPOTENT: re-attaching the SAME `externalZoneId` a domain already
   * carries succeeds and refreshes `providerZoneStatus`/`zoneNameservers` if
   * given — it is not a "replace". Attaching a DIFFERENT `externalZoneId`
   * to a domain that already has one throws {@link InfrastructureValidationError}
   * unless `input.replace` is `true` — pointing a domain at a different zone
   * is a real, deliberate operator act, never an accidental overwrite.
   *
   * Deliberately enqueues NOTHING. Rule P11 (adopt-into-intent): adoption
   * "changes nothing on the provider" and "does NOT enqueue a reconcile" —
   * attaching a zone is Loxep starting to track a binding, not a request to
   * sync. The operator's existing "Sync now" (`requestDomainResync`) is the
   * separate, explicit next step, and it is what was refusing before this
   * method existed.
   */
  attachZone(id: string, input: AttachZoneInput): Promise<ManagedDomainRow>;
  /** Live desired state for one domain. */
  listRecords(domainId: string): Promise<DnsRecordRow[]>;
  /** Author a `manual` record the reconciler will never rewrite. */
  addManualRecord(
    domainId: string,
    input: ManualRecordInput,
    options?: { actorUserId?: string | null },
  ): Promise<DnsRecordRow>;
  /**
   * Replace every reconciler-owned record with a freshly materialized set,
   * resurrecting tombstones and soft-deleting what intent no longer describes.
   * Manual records are untouched.
   */
  applyMaterializedRecords(
    domainId: string,
    desired: readonly DesiredRecord[],
    options?: { executor?: LoxepDb },
  ): Promise<{ created: number; updated: number; softDeleted: number }>;
}

/** Owners the reconciler materializes; `manual` is deliberately excluded. */
const MATERIALIZED_OWNERS = [
  "apex",
  "wildcard",
  "caa",
  "mail",
  "proxy_resource",
] as const;

export function createManagedDomainsService(options: {
  db: LoxepDb;
  enqueue?: TransactionalEnqueue;
}): ManagedDomainsService {
  const { db } = options;
  const enqueue: TransactionalEnqueue =
    options.enqueue ?? (async () => undefined);

  async function requireDomain(
    executor: Pick<LoxepDb, "select">,
    id: string,
  ): Promise<ManagedDomainRow> {
    const rows = await executor
      .select()
      .from(managedDomains)
      .where(eq(managedDomains.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(`managed domain ${id} not found`, {
        id,
      });
    }
    return row;
  }

  return {
    async create(input) {
      const parsed = createDomainSchema.parse(input);

      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(managedDomains)
          .values({
            name: parsed.name,
            dnsConnectionId: parsed.dnsConnectionId,
            registrar: parsed.registrar ?? null,
            apexTargetId: parsed.apexTargetId ?? null,
            ...(parsed.apexProxied === undefined
              ? {}
              : { apexProxied: parsed.apexProxied }),
            ...(parsed.wildcardProxied === undefined
              ? {}
              : { wildcardProxied: parsed.wildcardProxied }),
            ...(parsed.mailEnabled === undefined
              ? {}
              : { mailEnabled: parsed.mailEnabled }),
            notes: parsed.notes ?? null,
            createdByUserId: parsed.createdByUserId ?? null,
            // `state` is deliberately absent: the column defaults to 'draft'
            // and only the reconciler ever advances it.
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("managed domain insert returned no row");
        }

        await createAuditService({ db: tx }).append({
          actorUserId: parsed.createdByUserId ?? null,
          action: "infrastructure.managed_domain.create",
          resourceType: MANAGED_DOMAIN_RESOURCE_TYPE,
          resourceId: row.id,
          after: {
            name: row.name,
            dnsConnectionId: row.dnsConnectionId,
            apexTargetId: row.apexTargetId,
            mailEnabled: row.mailEnabled,
          },
        });

        // Same transaction. This is the whole point.
        await enqueue(
          tx,
          MATERIALIZE_RECORDS_TASK,
          { domainId: row.id },
          { jobKey: domainJobKey(MATERIALIZE_RECORDS_TASK, row.id) },
        );

        return row;
      });
    },

    async get(id) {
      return requireDomain(db, id);
    },

    async findByName(name) {
      const parsed = domainNameSchema.parse(name);
      const rows = await db
        .select()
        .from(managedDomains)
        .where(eq(managedDomains.name, parsed));
      return rows[0] ?? null;
    },

    async list() {
      return db.select().from(managedDomains);
    },

    async updateIntent(id, input) {
      const parsed = updateIntentSchema.parse(input);

      return db.transaction(async (tx) => {
        const before = await requireDomain(tx, id);
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (parsed.apexTargetId !== undefined) {
          patch["apexTargetId"] = parsed.apexTargetId;
        }
        if (parsed.apexProxied !== undefined) {
          patch["apexProxied"] = parsed.apexProxied;
        }
        if (parsed.wildcardProxied !== undefined) {
          patch["wildcardProxied"] = parsed.wildcardProxied;
        }
        if (parsed.mailEnabled !== undefined) {
          patch["mailEnabled"] = parsed.mailEnabled;
        }
        if (parsed.registrar !== undefined) patch["registrar"] = parsed.registrar;
        if (parsed.notes !== undefined) patch["notes"] = parsed.notes;

        const rows = await tx
          .update(managedDomains)
          .set(patch)
          .where(eq(managedDomains.id, id))
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("managed domain update returned no row");
        }

        await createAuditService({ db: tx }).append({
          actorUserId: parsed.actorUserId ?? null,
          action: "infrastructure.managed_domain.update_intent",
          resourceType: MANAGED_DOMAIN_RESOURCE_TYPE,
          resourceId: id,
          before: {
            apexTargetId: before.apexTargetId,
            apexProxied: before.apexProxied,
            wildcardProxied: before.wildcardProxied,
            mailEnabled: before.mailEnabled,
          },
          after: {
            apexTargetId: row.apexTargetId,
            apexProxied: row.apexProxied,
            wildcardProxied: row.wildcardProxied,
            mailEnabled: row.mailEnabled,
          },
        });

        await enqueue(
          tx,
          MATERIALIZE_RECORDS_TASK,
          { domainId: id },
          { jobKey: domainJobKey(MATERIALIZE_RECORDS_TASK, id) },
        );

        return row;
      });
    },

    async attachZone(id, input) {
      const parsed = attachZoneSchema.parse(input);

      return db.transaction(async (tx) => {
        const before = await requireDomain(tx, id);

        const isReplace =
          before.externalZoneId !== null &&
          before.externalZoneId !== parsed.externalZoneId;
        if (isReplace && parsed.replace !== true) {
          throw new InfrastructureValidationError(
            `managed domain "${before.name}" is already attached to zone "${before.externalZoneId}" — pass replace: true to point it at a different zone`,
            {
              domainId: id,
              currentExternalZoneId: before.externalZoneId,
              requestedExternalZoneId: parsed.externalZoneId,
            },
          );
        }

        const patch: Record<string, unknown> = {
          externalZoneId: parsed.externalZoneId,
          updatedAt: new Date(),
        };
        if (parsed.providerZoneStatus !== undefined) {
          patch["providerZoneStatus"] = parsed.providerZoneStatus;
        }
        if (parsed.zoneNameservers !== undefined) {
          patch["zoneNameservers"] = parsed.zoneNameservers;
        }

        // Left untouched, deliberately: `delegationVerifiedAt`. Unlike
        // `providerZoneStatus`, no zone fact this design has ever produced
        // carries confirmed delegation evidence — `isDelegationConfirmed`
        // (`mail-sync.ts`) treats `providerZoneStatus === 'active'` as
        // sufficient on its own, so a freshly-attached already-active zone
        // is already delegation-confirmed through that column, with no
        // separate write needed here.
        const rows = await tx
          .update(managedDomains)
          .set(patch)
          .where(eq(managedDomains.id, id))
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("managed domain zone attach returned no row");
        }

        await createAuditService({ db: tx }).append({
          actorUserId: parsed.actorUserId ?? null,
          action: "infrastructure.managed_domain.attach_zone",
          resourceType: MANAGED_DOMAIN_RESOURCE_TYPE,
          resourceId: id,
          before: {
            externalZoneId: before.externalZoneId,
            providerZoneStatus: before.providerZoneStatus,
          },
          after: {
            externalZoneId: row.externalZoneId,
            providerZoneStatus: row.providerZoneStatus,
          },
        });

        // NO enqueue. See this method's own doc — Rule P11.
        return row;
      });
    },

    async listRecords(domainId) {
      return db
        .select()
        .from(dnsRecords)
        .where(
          and(
            eq(dnsRecords.domainId, domainId),
            isNull(dnsRecords.desiredDeletedAt),
          ),
        );
    },

    async addManualRecord(domainId, input, manualOptions) {
      if (input.proxied === true && input.type === "TXT") {
        throw new InfrastructureValidationError(
          "a TXT record cannot be proxied",
          { type: input.type },
        );
      }

      return db.transaction(async (tx) => {
        await requireDomain(tx, domainId);
        // Resurrect rather than insert: the natural-key unique covers
        // tombstones (open question 7).
        const rows = await tx
          .insert(dnsRecords)
          .values({
            domainId,
            type: input.type,
            name: input.name,
            content: input.content,
            ttlSeconds: input.ttlSeconds ?? null,
            priority: input.priority ?? null,
            proxied: input.proxied ?? false,
            owner: "manual",
            externalRecordId: input.externalRecordId ?? null,
          })
          .onConflictDoUpdate({
            target: [
              dnsRecords.domainId,
              dnsRecords.type,
              dnsRecords.name,
              dnsRecords.content,
            ],
            set: {
              desiredDeletedAt: null,
              owner: "manual",
              ttlSeconds: input.ttlSeconds ?? null,
              priority: input.priority ?? null,
              proxied: input.proxied ?? false,
              updatedAt: new Date(),
            },
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error("dns record upsert returned no row");
        }

        await createAuditService({ db: tx }).append({
          actorUserId: manualOptions?.actorUserId ?? null,
          action: "infrastructure.dns_record.add_manual",
          resourceType: MANAGED_DOMAIN_RESOURCE_TYPE,
          resourceId: domainId,
          after: {
            type: row.type,
            name: row.name,
            content: row.content,
            owner: row.owner,
          },
        });

        await enqueue(
          tx,
          SYNC_RECORDS_TASK,
          { domainId },
          { jobKey: domainJobKey(SYNC_RECORDS_TASK, domainId) },
        );

        return row;
      });
    },

    async applyMaterializedRecords(domainId, desired, applyOptions) {
      const executor = applyOptions?.executor ?? db;
      const now = new Date();
      let created = 0;
      let updated = 0;

      const naturalKey = (record: {
        type: string;
        name: string;
        content: string;
      }): string => `${record.type} ${record.name} ${record.content}`;

      const desiredKeys = new Set(desired.map(naturalKey));

      // Read before write, so "created" and "updated" are facts rather than a
      // guess derived from a timestamp the database — not this process — set.
      const beforeRows = await executor
        .select()
        .from(dnsRecords)
        .where(eq(dnsRecords.domainId, domainId));
      const beforeKeys = new Set(beforeRows.map(naturalKey));

      for (const record of desired) {
        const rows = await executor
          .insert(dnsRecords)
          .values({
            domainId,
            type: record.type,
            name: record.name,
            content: record.content,
            ttlSeconds: record.ttlSeconds,
            priority: record.priority,
            proxied: record.proxied,
            owner: record.owner,
          })
          .onConflictDoUpdate({
            target: [
              dnsRecords.domainId,
              dnsRecords.type,
              dnsRecords.name,
              dnsRecords.content,
            ],
            set: {
              // The resurrection: a re-declared record clears its tombstone
              // rather than colliding with it.
              desiredDeletedAt: null,
              ttlSeconds: record.ttlSeconds,
              priority: record.priority,
              proxied: record.proxied,
              owner: record.owner,
              updatedAt: now,
            },
            // A manual record wins. The materializer never takes ownership of
            // a row a human authored, even when it would emit the same value.
            setWhere: sql`${dnsRecords.owner} <> 'manual'`,
          })
          .returning({ id: dnsRecords.id });
        const row = rows[0];
        if (row === undefined) continue;
        if (beforeKeys.has(naturalKey(record))) updated += 1;
        else created += 1;
      }

      // Soft-delete reconciler-owned rows intent no longer describes. Manual
      // rows are excluded by the owner predicate, not by a filter someone can
      // forget.
      const existing = await executor
        .select()
        .from(dnsRecords)
        .where(
          and(
            eq(dnsRecords.domainId, domainId),
            isNull(dnsRecords.desiredDeletedAt),
            inArray(dnsRecords.owner, [...MATERIALIZED_OWNERS]),
          ),
        );
      let softDeleted = 0;
      for (const row of existing) {
        const key = naturalKey(row);
        if (desiredKeys.has(key)) continue;
        await executor
          .update(dnsRecords)
          .set({ desiredDeletedAt: now, updatedAt: now })
          .where(eq(dnsRecords.id, row.id));
        softDeleted += 1;
      }

      return { created, updated, softDeleted };
    },
  };
}

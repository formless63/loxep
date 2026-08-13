/**
 * Counterparty sites: addresses and places where work happens.
 *
 * ## Owned by the counterparty, not by a project
 *
 * A site is a fact about the PARTY — the customer's warehouse, a billing-only
 * address, a remote/no-site row for pure remote work — and a project merely
 * POINTS at one (`projects.counterparty_site_id`, migration 0011). This
 * resolves a documentation split recorded in the design's contradiction 7: the
 * roadmap's "Projects/jobs/sites" reads as Projects owning sites, while Domain
 * Boundaries assigns addresses/sites to Customers. The customer's warehouse
 * survives the job — deleting a project must never take the site with it, and
 * this package's ownership of the table is what makes that true.
 *
 * ## Deliberately smaller than a real address model
 *
 * Free text lines plus `country`/`region`, matching Phase 4's shipping
 * analysis and Phase 5's tax context. No address validation, normalization, or
 * geocoding. `latitude`/`longitude` are operator-entered or absent —
 * `counterparty_sites_latlong_pair_check` is the only thing the database
 * enforces about them.
 *
 * ## PROVISIONAL
 *
 * `counterparty_sites` was deferred out of migration 0006 because it had no
 * consumer yet (see that migration's header). Migration 0011 ships it
 * alongside `projects`, its first consumer, per `bd show loxep-nw0`'s own
 * design note. This service is the counterparty-side half of that slice —
 * project-side site selection lives wherever a future `@loxep/work` package's
 * project service reads `counterparty_site_id`, which does not exist yet.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { counterpartySites } from "@loxep/db/schema";
import type { CounterpartySiteKind } from "@loxep/db/schema";
import { z } from "zod";
import { counterpartySiteCode, withCodeRetry } from "./codes.ts";
import {
  CounterpartyNotFoundError,
  CounterpartyValidationError,
} from "./errors.ts";
import { textLiteral, toDate, uuidLiteral } from "./sql.ts";

export type CounterpartySiteRow = typeof counterpartySites.$inferSelect;

const SITE_KINDS = [
  "billing",
  "shipping",
  "service",
  "remote",
  "other",
] as const satisfies readonly CounterpartySiteKind[];

const isoCountry = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "expected an ISO-3166-1 alpha-2 code")
  .nullish();

const createSchema = z
  .strictObject({
    counterpartyId: z.uuid(),
    /** Generated as `ST-<year>-NNNN` when omitted. */
    siteCode: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1),
    siteKind: z.enum(SITE_KINDS),
    addressLine1: z.string().trim().min(1).nullish(),
    addressLine2: z.string().trim().min(1).nullish(),
    locality: z.string().trim().min(1).nullish(),
    region: z.string().trim().min(1).nullish(),
    postalCode: z.string().trim().min(1).nullish(),
    country: isoCountry,
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    accessNotes: z.string().trim().min(1).nullish(),
    primaryContactId: z.uuid().nullish(),
    active: z.boolean().default(true),
    notes: z.string().trim().min(1).nullish(),
    actorUserId: z.string().min(1).nullish(),
    requestId: z.string().min(1).nullish(),
  })
  .refine(
    (input) =>
      (input.latitude === undefined || input.latitude === null) ===
      (input.longitude === undefined || input.longitude === null),
    {
      message:
        "latitude and longitude are recorded together or not at all " +
        "(counterparty_sites_latlong_pair_check)",
      path: ["longitude"],
    },
  );

export type CreateSiteInput = z.input<typeof createSchema>;

const updateSchema = z
  .strictObject({
    siteId: z.uuid(),
    name: z.string().trim().min(1).optional(),
    siteKind: z.enum(SITE_KINDS).optional(),
    addressLine1: z.string().trim().min(1).nullish(),
    addressLine2: z.string().trim().min(1).nullish(),
    locality: z.string().trim().min(1).nullish(),
    region: z.string().trim().min(1).nullish(),
    postalCode: z.string().trim().min(1).nullish(),
    country: isoCountry,
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    accessNotes: z.string().trim().min(1).nullish(),
    primaryContactId: z.uuid().nullish(),
    active: z.boolean().optional(),
    notes: z.string().trim().min(1).nullish(),
    actorUserId: z.string().min(1).nullish(),
    requestId: z.string().min(1).nullish(),
  })
  .refine(
    (input) =>
      input.latitude === undefined ||
      input.longitude === undefined ||
      (input.latitude === null) === (input.longitude === null),
    {
      message:
        "latitude and longitude are updated together, never one alone, " +
        "when both are provided (counterparty_sites_latlong_pair_check)",
      path: ["longitude"],
    },
  );

export type UpdateSiteInput = z.input<typeof updateSchema>;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new CounterpartyValidationError(`invalid site: ${issues}`);
  }
  return parsed.data;
}

function numericLiteral(value: number | null | undefined): string {
  if (value === null || value === undefined) return "null";
  if (!Number.isFinite(value)) {
    throw new CounterpartyValidationError("expected a finite number");
  }
  return String(value);
}

export interface SitesService {
  create: (input: CreateSiteInput) => Promise<CounterpartySiteRow>;
  get: (siteId: string) => Promise<CounterpartySiteRow>;
  update: (input: UpdateSiteInput) => Promise<CounterpartySiteRow>;
  /** Sets `active = false`. Never deletes — projects and roles may reference the site. */
  deactivate: (input: {
    siteId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<CounterpartySiteRow>;
  reactivate: (input: {
    siteId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<CounterpartySiteRow>;
  /** Every site for a party. `includeInactive` defaults to false — the common list view. */
  listForCounterparty: (
    counterpartyId: string,
    options?: { includeInactive?: boolean },
  ) => Promise<CounterpartySiteRow[]>;
}

export function createSitesService(options: { db: LoxepDb }): SitesService {
  const { db } = options;

  function toRow(row: Record<string, unknown>): CounterpartySiteRow {
    return {
      id: row["id"] as string,
      counterpartyId: row["counterparty_id"] as string,
      siteCode: row["site_code"] as string,
      name: row["name"] as string,
      siteKind: row["site_kind"] as string,
      addressLine1: (row["address_line1"] as string | null) ?? null,
      addressLine2: (row["address_line2"] as string | null) ?? null,
      locality: (row["locality"] as string | null) ?? null,
      region: (row["region"] as string | null) ?? null,
      postalCode: (row["postal_code"] as string | null) ?? null,
      country: (row["country"] as string | null) ?? null,
      latitude: (row["latitude"] as string | null) ?? null,
      longitude: (row["longitude"] as string | null) ?? null,
      accessNotes: (row["access_notes"] as string | null) ?? null,
      primaryContactId: (row["primary_contact_id"] as string | null) ?? null,
      active: row["active"] as boolean,
      notes: (row["notes"] as string | null) ?? null,
      createdAt: toDate(row["created_at"]),
      updatedAt: toDate(row["updated_at"]),
    };
  }

  async function load(
    executor: Pick<LoxepDb, "execute">,
    siteId: string,
  ): Promise<CounterpartySiteRow> {
    const result = await executor.execute(
      `select * from counterparty_sites where id = ${uuidLiteral(siteId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CounterpartyNotFoundError(`unknown site "${siteId}"`);
    }
    return toRow(row);
  }

  async function generateSiteCode(
    executor: Pick<LoxepDb, "execute">,
    year: number,
  ): Promise<string> {
    const result = await executor.execute(
      `select coalesce(max(
                (substring(site_code from '^ST-[0-9]{4}-([0-9]+)$'))::integer
              ), 0)::text as max_seq
         from counterparty_sites
        where site_code like ${textLiteral(`ST-${year}-%`)}`,
    );
    const next = Number(result.rows[0]?.["max_seq"] ?? "0") + 1;
    return counterpartySiteCode(year, next);
  }

  return {
    get: async (siteId) => load(db, siteId),

    create: async (input) => {
      const value = parse(createSchema, input);
      const year = new Date().getUTCFullYear();
      return withCodeRetry(
        async () =>
          db.transaction(async (tx) => {
            const siteCode =
              value.siteCode ?? (await generateSiteCode(tx, year));
            const inserted = await tx
              .insert(counterpartySites)
              .values({
                counterpartyId: value.counterpartyId,
                siteCode,
                name: value.name,
                siteKind: value.siteKind,
                addressLine1: value.addressLine1 ?? null,
                addressLine2: value.addressLine2 ?? null,
                locality: value.locality ?? null,
                region: value.region ?? null,
                postalCode: value.postalCode ?? null,
                country: value.country?.toUpperCase() ?? null,
                latitude: value.latitude?.toString() ?? null,
                longitude: value.longitude?.toString() ?? null,
                accessNotes: value.accessNotes ?? null,
                primaryContactId: value.primaryContactId ?? null,
                active: value.active,
                notes: value.notes ?? null,
              })
              .returning();
            const row = inserted[0];
            if (row === undefined) {
              throw new CounterpartyValidationError(
                "counterparty_sites insert returned no row",
              );
            }
            await createAuditService({ db: tx }).append({
              actorUserId: value.actorUserId ?? null,
              action: "counterparty.site_added",
              resourceType: "counterparty",
              resourceId: value.counterpartyId,
              after: {
                siteId: row.id,
                siteCode: row.siteCode,
                siteKind: row.siteKind,
                active: row.active,
              },
              requestId: value.requestId ?? null,
            });
            return row;
          }),
        { label: "counterparty site code" },
      );
    },

    update: async (input) => {
      const value = parse(updateSchema, input);
      return db.transaction(async (tx) => {
        const before = await load(tx, value.siteId);

        const nextLatitude =
          value.latitude === undefined
            ? before.latitude === null
              ? null
              : Number(before.latitude)
            : value.latitude;
        const nextLongitude =
          value.longitude === undefined
            ? before.longitude === null
              ? null
              : Number(before.longitude)
            : value.longitude;
        if ((nextLatitude === null) !== (nextLongitude === null)) {
          throw new CounterpartyValidationError(
            "latitude and longitude must both be set or both be null " +
              "(counterparty_sites_latlong_pair_check)",
          );
        }

        const assignments = ["updated_at = now()"];
        if (value.name !== undefined) {
          assignments.push(`name = ${textLiteral(value.name)}`);
        }
        if (value.siteKind !== undefined) {
          assignments.push(`site_kind = ${textLiteral(value.siteKind)}`);
        }
        if (value.addressLine1 !== undefined) {
          assignments.push(
            `address_line1 = ${value.addressLine1 === null ? "null" : textLiteral(value.addressLine1)}`,
          );
        }
        if (value.addressLine2 !== undefined) {
          assignments.push(
            `address_line2 = ${value.addressLine2 === null ? "null" : textLiteral(value.addressLine2)}`,
          );
        }
        if (value.locality !== undefined) {
          assignments.push(
            `locality = ${value.locality === null ? "null" : textLiteral(value.locality)}`,
          );
        }
        if (value.region !== undefined) {
          assignments.push(
            `region = ${value.region === null ? "null" : textLiteral(value.region)}`,
          );
        }
        if (value.postalCode !== undefined) {
          assignments.push(
            `postal_code = ${value.postalCode === null ? "null" : textLiteral(value.postalCode)}`,
          );
        }
        if (value.country !== undefined) {
          assignments.push(
            `country = ${value.country === null ? "null" : textLiteral(value.country.toUpperCase())}`,
          );
        }
        if (value.latitude !== undefined) {
          assignments.push(`latitude = ${numericLiteral(value.latitude)}`);
        }
        if (value.longitude !== undefined) {
          assignments.push(`longitude = ${numericLiteral(value.longitude)}`);
        }
        if (value.accessNotes !== undefined) {
          assignments.push(
            `access_notes = ${value.accessNotes === null ? "null" : textLiteral(value.accessNotes)}`,
          );
        }
        if (value.primaryContactId !== undefined) {
          assignments.push(
            `primary_contact_id = ${value.primaryContactId === null ? "null" : uuidLiteral(value.primaryContactId)}`,
          );
        }
        if (value.active !== undefined) {
          assignments.push(`active = ${value.active}`);
        }
        if (value.notes !== undefined) {
          assignments.push(
            `notes = ${value.notes === null ? "null" : textLiteral(value.notes)}`,
          );
        }

        await tx.execute(
          `update counterparty_sites set ${assignments.join(", ")}
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await load(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: value.actorUserId ?? null,
          action: "counterparty.site_updated",
          resourceType: "counterparty",
          resourceId: before.counterpartyId,
          before: { siteKind: before.siteKind, active: before.active },
          after: { siteKind: after.siteKind, active: after.active },
          requestId: value.requestId ?? null,
          metadata: { siteId: before.id },
        });
        return after;
      });
    },

    deactivate: async (input) =>
      db.transaction(async (tx) => {
        const before = await load(tx, input.siteId);
        await tx.execute(
          `update counterparty_sites set active = false, updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await load(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "counterparty.site_deactivated",
          resourceType: "counterparty",
          resourceId: before.counterpartyId,
          requestId: input.requestId ?? null,
          metadata: { siteId: before.id },
        });
        return after;
      }),

    reactivate: async (input) =>
      db.transaction(async (tx) => {
        const before = await load(tx, input.siteId);
        await tx.execute(
          `update counterparty_sites set active = true, updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await load(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "counterparty.site_reactivated",
          resourceType: "counterparty",
          resourceId: before.counterpartyId,
          requestId: input.requestId ?? null,
          metadata: { siteId: before.id },
        });
        return after;
      }),

    listForCounterparty: async (counterpartyId, options) => {
      const includeInactive = options?.includeInactive ?? false;
      const predicate = includeInactive ? "" : "and active";
      const result = await db.execute(
        `select * from counterparty_sites
          where counterparty_id = ${uuidLiteral(counterpartyId)} ${predicate}
          order by active desc, name`,
      );
      return result.rows.map(toRow);
    },
  };
}

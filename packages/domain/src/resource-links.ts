/**
 * Generic external-resource companion-link service (loxep-v5r.3).
 *
 * CONSOLIDATION: this module is the SINGLE owner of the external-resource
 * link service — the generic "attach a companion resource (a wiki page, an
 * uptime dashboard, a task board, ...) to a Loxep record" mechanism. Phase 8
 * milestone 3 (fleet tool links, loxep-ovj.3) and the knowledge/tasks
 * companion designs (loxep-p1j, loxep-juk) both consume this module rather
 * than building their own copy of it — see the knowledge-tasks design's
 * "three designs now scope the same link service" open question. Those
 * consumers add their own resource-kind registrations (a `RESOURCE_LINK_
 * RESOURCE_TYPES` entry, where relevant) and surface wiring — never a second
 * `registerExternalResource`/`upsertExternalResource`/`attachLink`/
 * `detachLink`/`listLinksFor`.
 *
 * ## Migrations
 *
 * `external_resources` and `resource_links` shipped in migration 0000
 * (constrained — the `(external_resource_id, resource_type, resource_id,
 * purpose)` unique key and its index — in 0004, loxep-dyx). This module was
 * the first `@loxep/domain` service layered on top of them, and it remains
 * the only one: `external_resources` later gained a second constraint, the
 * partial `external_resources_provider_type_external_id_uq` unique index
 * (migration 0021, loxep-uhs) that `upsertExternalResource` targets — see
 * that verb's doc comment for why the index (and the verb) had to be
 * partial. See
 * `apps/docs/.../architecture/fleet-observability-design.md#the-link-model-and-its-vocabulary`
 * for the fixed fleet-tool link vocabulary a future consumer follows, and
 * the knowledge-tasks design's mirrored section for the content-tool
 * vocabulary. Both are tables of `(provider, external_type, resource_type,
 * purpose)` — every one of those four fields is a plain string this service
 * accepts and stores; it does not itself close any of them except
 * `resourceType` (see below).
 *
 * ## The two-row shape, and why `createLink` still exists
 *
 * An external resource (a BookStack page, a Gatus dashboard, a Vikunja
 * project) is recorded once in `external_resources`; each attachment of that
 * resource to a Loxep record is a separate `resource_links` row. The two
 * verbs (`registerExternalResource`, `attachLink`) are independently useful
 * — a tier-2/3 adapter refreshes one `external_resources` row that several
 * links may point at — but the tier-1 "Add a companion link" UI this issue
 * ships always wants both at once, so `createLink` composes them
 * transactionally, the way `apps/web/src/server/finance-billing-functions.ts`'s
 * `persistResourceLink` already did ad hoc before this module existed to
 * share it.
 *
 * ## `resourceType` is a closed, extensible union — the monitor-target precedent
 *
 * `resource_links.resource_type` is a plain `text` column (no PG enum, no
 * migration needed to add a value), but the knowledge-tasks design states
 * the actual constraint precisely: "`resource_type` values may only name
 * tables that exist when the milestone ships." `RESOURCE_LINK_RESOURCE_TYPES`
 * below is the same shape as `@loxep/market`'s `MONITOR_TARGET_TYPES` — a
 * closed array + derived TS union, extended by whichever milestone adds a
 * new Loxep-side record type worth linking, in the SAME change as its entry
 * in `resourceLinkResourceTypeConfig` (mirroring the `MONITOR_TARGET_TYPES`/
 * `monitorTargetConfigSchemas` split-registration discipline documented in
 * `packages/market/src/monitors.ts`). `hosting_target` is the only member
 * today (Phase 7's fleet, the one surface with a live consumer, loxep-lmy.3
 * note 5). Phase 6/8's `project`/`counterparty`/`acquisition`/
 * `managed_domain`/`economic_entity` get added by whichever milestone
 * actually mounts a panel against them — not pre-declared here.
 *
 * `provider`, `externalType`, and `purpose` stay genuinely free text: they
 * are the vocabulary EACH CONSUMER defines for itself (see the two designs'
 * vocabulary tables), and this generic service has no business closing them.
 * `metadata` carries sync metadata only (a last-observed instant, the
 * companion's own status string, an ETag) per both designs — never a copy of
 * the companion's content — but that rule is enforced by callers (the way
 * `health.ts`'s `guardHealthDetail` enforces its own rule at the boundary),
 * not by this module, because a tier-1 link has no `metadata` to police yet.
 *
 * Queries go through the Drizzle relational query API and the insert
 * builder; the one delete this module needs goes through `db.execute` with
 * validated literals, so `@loxep/domain` needs no direct `drizzle-orm`
 * dependency (see `sql.ts`).
 */
import { externalResources, resourceLinks } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { z } from "zod";
import { DomainValidationError } from "./errors.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

/**
 * Closed, extensible union of Loxep-side record types a companion link may
 * point at. See the module doc: add a new member and its
 * {@link resourceLinkResourceTypeConfig} entry together, in the change that
 * actually mounts a panel against it.
 */
export const RESOURCE_LINK_RESOURCE_TYPES = ["hosting_target"] as const;
export type ResourceLinkResourceType =
  (typeof RESOURCE_LINK_RESOURCE_TYPES)[number];

/**
 * The "kind registry" pairing required alongside {@link RESOURCE_LINK_RESOURCE_TYPES}
 * — union + config together, mirroring `@loxep/market`'s
 * `monitorTargetConfigSchemas`. Today's only config is a display label;
 * future consumers may extend the value shape as they add entries, so long
 * as every existing member keeps a `label`.
 */
export const resourceLinkResourceTypeConfig: Record<
  ResourceLinkResourceType,
  { readonly label: string }
> = {
  hosting_target: { label: "Hosting target" },
};

export interface ExternalResourceRow {
  id: string;
  provider: string;
  connectionId: string | null;
  externalType: string;
  externalId: string | null;
  url: string;
  title: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResourceLinkRow {
  externalResourceId: string;
  resourceType: ResourceLinkResourceType;
  resourceId: string;
  purpose: string;
  createdAt: Date;
}

/** A link joined with the external resource it points at — the shape every list/read caller wants. */
export interface CompanionLink extends ResourceLinkRow {
  provider: string;
  externalType: string;
  externalId: string | null;
  url: string;
  title: string | null;
  metadata: Record<string, unknown>;
}

export interface RegisterExternalResourceInput {
  provider: string;
  externalType: string;
  url: string;
  connectionId?: string | null;
  externalId?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AttachLinkInput {
  externalResourceId: string;
  resourceType: ResourceLinkResourceType;
  resourceId: string;
  purpose: string;
}

export interface DetachLinkInput {
  externalResourceId: string;
  resourceType: ResourceLinkResourceType;
  resourceId: string;
  purpose: string;
}

/** `registerExternalResource` + `attachLink` in one transaction. */
export type CreateLinkInput = RegisterExternalResourceInput &
  Omit<AttachLinkInput, "externalResourceId">;

export interface ResourceLinksService {
  /** Records one companion object. Does not attach it to anything yet. */
  registerExternalResource: (
    input: RegisterExternalResourceInput,
  ) => Promise<ExternalResourceRow>;
  /**
   * Records or refreshes one companion object, keyed on
   * `(provider, externalType, externalId)` (loxep-uhs). This is the verb
   * scheduled adapter-driven discovery (Beszel systems, Gatus endpoints,
   * Tailscale devices, Dockhand environments, Termix hosts) must call on
   * every sweep instead of `registerExternalResource`: a re-observed object
   * refreshes its `url`/`title`/`metadata`/`connectionId` in place via
   * `ON CONFLICT ... DO UPDATE` against the
   * `external_resources_provider_type_external_id_uq` partial unique index,
   * rather than inserting a fresh row (and a fresh `integration_health`
   * subject) every 5 minutes.
   *
   * Naming: the bead that requested this named two candidate verbs,
   * `upsertExternalResource` and `refreshExternalResource`. This module
   * picks `upsertExternalResource` — it is a plain upsert (insert-or-update
   * on a natural key), not a refresh of an existing, known row, and the name
   * should say what the SQL does.
   *
   * Throws {@link DomainValidationError} when `externalId` is null, absent,
   * or blank: the unique index this upserts against is partial
   * (`WHERE external_id IS NOT NULL`), so a null external id has no
   * `ON CONFLICT` target and cannot be upserted against — there would be no
   * way to tell "insert a new row" from "update the existing one" for two
   * calls that both carry a null id. Callers with no external id (tier-1
   * operator-typed companion links entered by hand) must keep using
   * `registerExternalResource`, which is unchanged and still a plain insert.
   */
  upsertExternalResource: (
    input: RegisterExternalResourceInput,
  ) => Promise<ExternalResourceRow>;
  /**
   * Attaches an already-registered external resource to a Loxep record.
   * Idempotent: an at-least-once retry with the same
   * `(externalResourceId, resourceType, resourceId, purpose)` is a no-op,
   * targeting the `resource_links_resource_purpose_uq` constraint.
   */
  attachLink: (input: AttachLinkInput) => Promise<void>;
  /** `registerExternalResource` + `attachLink`, transactionally — the tier-1 "Add a companion link" entry point. */
  createLink: (input: CreateLinkInput) => Promise<CompanionLink>;
  /** Every companion link attached to one Loxep record, newest first. */
  listLinksFor: (
    resourceType: ResourceLinkResourceType,
    resourceId: string,
  ) => Promise<CompanionLink[]>;
  /**
   * Removes one attachment. If no other `resource_links` row still points at
   * the same `external_resources` row, that row is deleted too — an orphaned
   * companion record with no attachment left is dead weight, not history
   * (unlike `integration_health`, an external resource carries no audit
   * value once nothing links to it). Idempotent: detaching an already-gone
   * link is a no-op, not an error.
   */
  detachLink: (input: DetachLinkInput) => Promise<void>;
}

type ExternalResourceRowShape = typeof externalResources.$inferSelect;

function toExternalResourceRow(
  row: ExternalResourceRowShape,
): ExternalResourceRow {
  return {
    id: row.id,
    provider: row.provider,
    connectionId: row.connectionId,
    externalType: row.externalType,
    externalId: row.externalId,
    url: row.url,
    title: row.title,
    metadata: row.metadata as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCompanionLink(
  link: { resourceType: string; resourceId: string; purpose: string; createdAt: Date },
  resource: ExternalResourceRowShape,
): CompanionLink {
  return {
    externalResourceId: resource.id,
    resourceType: link.resourceType as ResourceLinkResourceType,
    resourceId: link.resourceId,
    purpose: link.purpose,
    createdAt: link.createdAt,
    provider: resource.provider,
    externalType: resource.externalType,
    externalId: resource.externalId,
    url: resource.url,
    title: resource.title,
    metadata: resource.metadata as Record<string, unknown>,
  };
}

const urlSchema = z.url();

/**
 * Local literal helpers for the one hand-written statement below
 * (`upsertExternalResource`'s `ON CONFLICT ... WHERE ... DO UPDATE`, which
 * the Drizzle insert builder cannot express without a `drizzle-orm` `sql`
 * tag this package deliberately does not depend on — see the module doc).
 * `textLiteral`/`uuidLiteral` already cover the non-null case; these three
 * wrap them for the nullable/JSON columns this one query needs.
 */
function nullableTextLiteral(value: string | null): string {
  return value === null ? "null" : textLiteral(value);
}

function nullableUuidLiteral(value: string | null): string {
  return value === null ? "null" : uuidLiteral(value);
}

function jsonbLiteral(value: Record<string, unknown>): string {
  return `${textLiteral(JSON.stringify(value))}::jsonb`;
}

function assertResourceType(
  resourceType: string,
): asserts resourceType is ResourceLinkResourceType {
  if (
    !RESOURCE_LINK_RESOURCE_TYPES.includes(
      resourceType as ResourceLinkResourceType,
    )
  ) {
    throw new DomainValidationError(
      `unregistered resource_links resource_type "${resourceType}" — ` +
        "add it to RESOURCE_LINK_RESOURCE_TYPES and resourceLinkResourceTypeConfig first",
    );
  }
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new DomainValidationError(`${field} is required`);
  }
  return trimmed;
}

export function createResourceLinksService(options: {
  db: LoxepDb;
}): ResourceLinksService {
  const { db } = options;

  async function insertExternalResource(
    dbOrTx: Pick<LoxepDb, "insert">,
    input: RegisterExternalResourceInput,
  ): Promise<ExternalResourceRowShape> {
    const provider = requireNonEmpty(input.provider, "provider");
    const externalType = requireNonEmpty(input.externalType, "externalType");
    const parsedUrl = urlSchema.safeParse(input.url.trim());
    if (!parsedUrl.success) {
      throw new DomainValidationError("url must be a valid absolute URL");
    }
    const title = input.title?.trim();
    const rows = await dbOrTx
      .insert(externalResources)
      .values({
        provider,
        externalType,
        url: parsedUrl.data,
        connectionId: input.connectionId ?? null,
        externalId: input.externalId ?? null,
        title: title === undefined || title === "" ? null : title,
        metadata: input.metadata ?? {},
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("external_resources insert returned no row");
    }
    return row;
  }

  async function insertLink(
    dbOrTx: Pick<LoxepDb, "insert">,
    input: AttachLinkInput,
  ): Promise<void> {
    assertResourceType(input.resourceType);
    const resourceId = requireNonEmpty(input.resourceId, "resourceId");
    const purpose = requireNonEmpty(input.purpose, "purpose");
    await dbOrTx
      .insert(resourceLinks)
      .values({
        externalResourceId: input.externalResourceId,
        resourceType: input.resourceType,
        resourceId,
        purpose,
      })
      .onConflictDoNothing({
        target: [
          resourceLinks.externalResourceId,
          resourceLinks.resourceType,
          resourceLinks.resourceId,
          resourceLinks.purpose,
        ],
      });
  }

  async function registerExternalResource(
    input: RegisterExternalResourceInput,
  ): Promise<ExternalResourceRow> {
    return toExternalResourceRow(await insertExternalResource(db, input));
  }

  async function attachLink(input: AttachLinkInput): Promise<void> {
    await insertLink(db, input);
  }

  async function upsertExternalResource(
    input: RegisterExternalResourceInput,
  ): Promise<ExternalResourceRow> {
    const provider = requireNonEmpty(input.provider, "provider");
    const externalType = requireNonEmpty(input.externalType, "externalType");
    const externalId = input.externalId?.trim();
    if (externalId === undefined || externalId === "") {
      throw new DomainValidationError(
        "upsertExternalResource requires a non-empty externalId — it " +
          "targets the external_resources_provider_type_external_id_uq " +
          "partial index (WHERE external_id IS NOT NULL), so a null " +
          "external id has no ON CONFLICT target; callers with no " +
          "external id must use registerExternalResource instead",
      );
    }
    const parsedUrl = urlSchema.safeParse(input.url.trim());
    if (!parsedUrl.success) {
      throw new DomainValidationError("url must be a valid absolute URL");
    }
    const title = input.title?.trim();
    const metadata = input.metadata ?? {};

    // Hand-written SQL, not the insert builder: `ON CONFLICT (...) WHERE ...
    // DO UPDATE` against a partial unique index needs a `targetWhere`
    // expressed with drizzle-orm's `sql` tag, and this package deliberately
    // takes no direct `drizzle-orm` dependency (see the module doc and
    // `sql.ts`). `excluded.*` refreshes exactly the columns the module doc
    // promises — url, title, metadata, connection_id — plus updated_at;
    // provider/external_type/external_id are the conflict target and never
    // change on update, and created_at is left untouched.
    const result = await db.execute(
      `insert into external_resources
          (provider, connection_id, external_type, external_id, url, title, metadata)
        values (
          ${textLiteral(provider)},
          ${nullableUuidLiteral(input.connectionId ?? null)},
          ${textLiteral(externalType)},
          ${textLiteral(externalId)},
          ${textLiteral(parsedUrl.data)},
          ${nullableTextLiteral(title === undefined || title === "" ? null : title)},
          ${jsonbLiteral(metadata)}
        )
        on conflict (provider, external_type, external_id)
          where external_id is not null
        do update set
          url = excluded.url,
          title = excluded.title,
          metadata = excluded.metadata,
          connection_id = excluded.connection_id,
          updated_at = now()
        returning id, provider, connection_id, external_type, external_id,
                  url, title, metadata, created_at, updated_at`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("external_resources upsert returned no row");
    }
    // `db.execute` on a hand-written string does not carry the schema-aware
    // Date coercion the typed insert/query builders apply, so `created_at`/
    // `updated_at` can arrive as driver-native timestamp strings rather than
    // `Date` instances — normalize explicitly to keep this row shape-
    // compatible with `toExternalResourceRow`'s `ExternalResourceRow`.
    return {
      id: row["id"] as string,
      provider: row["provider"] as string,
      connectionId: row["connection_id"] as string | null,
      externalType: row["external_type"] as string,
      externalId: row["external_id"] as string | null,
      url: row["url"] as string,
      title: row["title"] as string | null,
      metadata: row["metadata"] as Record<string, unknown>,
      createdAt: new Date(row["created_at"] as string | Date),
      updatedAt: new Date(row["updated_at"] as string | Date),
    };
  }

  async function createLink(input: CreateLinkInput): Promise<CompanionLink> {
    return db.transaction(async (tx) => {
      const resource = await insertExternalResource(tx, input);
      await insertLink(tx, {
        externalResourceId: resource.id,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        purpose: input.purpose,
      });
      return toCompanionLink(
        {
          resourceType: input.resourceType,
          resourceId: input.resourceId.trim(),
          purpose: input.purpose.trim(),
          createdAt: resource.createdAt,
        },
        resource,
      );
    });
  }

  async function listLinksFor(
    resourceType: ResourceLinkResourceType,
    resourceId: string,
  ): Promise<CompanionLink[]> {
    assertResourceType(resourceType);
    const links = await db.query.resourceLinks.findMany({
      where: (table, { and, eq }) =>
        and(eq(table.resourceType, resourceType), eq(table.resourceId, resourceId)),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });
    if (links.length === 0) return [];

    const resourceIds = [...new Set(links.map((link) => link.externalResourceId))];
    const resources = await db.query.externalResources.findMany({
      where: (table, { inArray }) => inArray(table.id, resourceIds),
    });
    const resourceById = new Map(resources.map((resource) => [resource.id, resource]));

    return links
      .map((link) => {
        const resource = resourceById.get(link.externalResourceId);
        return resource === undefined ? null : toCompanionLink(link, resource);
      })
      .filter((link): link is CompanionLink => link !== null);
  }

  async function detachLink(input: DetachLinkInput): Promise<void> {
    assertResourceType(input.resourceType);
    const resourceId = requireNonEmpty(input.resourceId, "resourceId");
    const purpose = requireNonEmpty(input.purpose, "purpose");
    const externalResourceId = uuidLiteral(input.externalResourceId);

    await db.transaction(async (tx) => {
      await tx.execute(
        `delete from resource_links
          where external_resource_id = ${externalResourceId}
            and resource_type = ${textLiteral(input.resourceType)}
            and resource_id = ${textLiteral(resourceId)}
            and purpose = ${textLiteral(purpose)}`,
      );
      const remaining = await tx.query.resourceLinks.findFirst({
        where: (table, { eq }) => eq(table.externalResourceId, input.externalResourceId),
      });
      if (remaining === undefined) {
        await tx.execute(
          `delete from external_resources where id = ${externalResourceId}`,
        );
      }
    });
  }

  return {
    registerExternalResource,
    upsertExternalResource,
    attachLink,
    createLink,
    listLinksFor,
    detachLink,
  };
}

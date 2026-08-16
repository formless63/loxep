/**
 * Server functions for the Cloudflare estate browser (loxep-47o.2), the
 * first consumer of the estate-browser shell (loxep-47o.1). Design:
 * `apps/docs/src/content/docs/architecture/estate-browsers-design.md` §3.1.
 *
 * ## Sections, and their call cost
 *
 * {@link fetchCloudflareEstateZones} is the OVERVIEW: one `listZones` call
 * per page, operator-driven ("Load more" — Rule P8), cross-referenced
 * against `managed_domains` for this connection. Rule P7's overview budget
 * (at most 3 calls) is honored trivially: the first render costs exactly
 * ONE call.
 *
 * {@link fetchCloudflareEstateRecords} is the per-zone DRILL-IN (Rule P6):
 * fired only when an operator expands one zone, via `adapter.read()`, cross-
 * referenced against `dns_records`/`dns_drift_findings` for whichever
 * `managed_domains` row (if any) this zone corresponds to — a database
 * read, never a second Cloudflare call.
 *
 * `listZones`/`read` both paginate INTERNALLY from page 1 up to their given
 * `maxPages` (`@loxep/integration-cloudflare`'s `paginate()` helper has no
 * page-cursor parameter, only a cumulative ceiling) — this package is
 * outside this milestone's edit fence, so "Load more" is implemented as
 * incrementing `maxPages` and re-requesting from page 1. For the vast
 * majority of installations (a single Cloudflare account's zone/record
 * count is far under one page — Cloudflare's own `per_page` ceiling is 50
 * zones / 100 records, and a live read-only verification against the real
 * connection this design targets found its zone count comfortably under
 * that ceiling too) this costs exactly the one call Rule P8 promises; only
 * past that ceiling does a SECOND "Load more" click re-walk page 1, an
 * accepted trade-off of the adapter's public surface rather than a new
 * adapter verb.
 *
 * ## Honesty states cross the RPC boundary as DATA, not thrown errors
 *
 * Every classifiable Cloudflare failure (the adapter's own five-kind
 * taxonomy) is caught HERE and returned as an `EstateSectionResult`'s
 * `'error'` branch — never thrown — because a thrown error's `.kind`/
 * `.detail` do not survive `createServerFn`'s boundary (the same reason
 * `ebay-oauth.ts`'s validation handler already classifies server-side). Only
 * a genuinely unexpected failure (wrong connection provider, a bug) throws.
 *
 * ## The one write: adopt-into-intent, reusing the EXISTING verb (Rule P10/P11)
 *
 * {@link adoptCloudflareEstateRecord} writes a `dns_records` row via
 * `ManagedDomainsService.addManualRecord` — the SAME service method the
 * shipped drift panel's "Adopt" button already calls
 * (`adoptDriftFinding`, `infrastructure-functions.ts`), entered zone-first
 * here instead of drift-finding-first. This milestone adds NO new verb to
 * `packages/infrastructure`: `addManualRecord` already exists, is already
 * reachable from another surface, and writes only Loxep's own table —
 * never a Cloudflare call — so it needs no `assertWritePolicy` check any
 * more than the drift panel's own Adopt button does. Record editing,
 * deletion, and zone creation stay permanently absent from this page — see
 * the design's §3.1 "Permanently read-only here".
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { classifyCaughtProviderError } from '@/features/estate/error-taxonomy';
import { estateError, estateOk, type EstateSectionResult } from '@/features/estate/types';

function iso(date: Date): string {
  return date.toISOString();
}

const CLOUDFLARE_PROVIDER = 'cloudflare';

const MAX_PAGES_SCHEMA = z.number().int().min(1).max(10).default(1);

// ---------------------------------------------------------------------------
// Zones — the overview, one call per "Load more" page
// ---------------------------------------------------------------------------

export interface CloudflareEstateZoneDto {
  externalZoneId: string;
  name: string;
  /** Verbatim provider status (Rule P3) — never mapped to a Loxep verdict word. */
  status: string;
  paused: boolean;
  nameservers: string[];
  accountId: string | null;
  /** Non-null when a `managed_domains` row for THIS connection shares this zone's name. */
  managedDomain: { id: string; name: string } | null;
}

export interface CloudflareEstateZonesDto {
  zones: CloudflareEstateZoneDto[];
  pagesLoaded: number;
  hasMore: boolean;
}

const fetchCloudflareEstateZonesInput = z.strictObject({
  connectionId: z.uuid(),
  maxPages: MAX_PAGES_SCHEMA
});

export const fetchCloudflareEstateZones = createServerFn({ method: 'GET' })
  .inputValidator(fetchCloudflareEstateZonesInput)
  .handler(async ({ data }): Promise<EstateSectionResult<CloudflareEstateZonesDto>> => {
    const { requireSession, getAdminServices, getCloudflareAdapterForConnection, getFleetModule } =
      await import('@/server/admin');
    await requireSession();
    const { connections } = getAdminServices();
    const connection = await connections.getConnection(data.connectionId);
    if (connection.provider !== CLOUDFLARE_PROVIDER) {
      throw new Error(`connection "${data.connectionId}" is not a Cloudflare connection`);
    }

    const readAt = iso(new Date());
    let zones: Awaited<
      ReturnType<
        Awaited<ReturnType<typeof getCloudflareAdapterForConnection>>['adapter']['listZones']
      >
    >;
    try {
      const { adapter } = await getCloudflareAdapterForConnection(data.connectionId);
      zones = await adapter.listZones({ maxPages: data.maxPages });
    } catch (error) {
      return estateError(
        classifyCaughtProviderError(error, 'Could not read Cloudflare zones.'),
        readAt
      );
    }

    const { handle } = getAdminServices();
    const managedRows = await handle.db.query.managedDomains.findMany({
      where: (table, { eq }) => eq(table.dnsConnectionId, data.connectionId),
      columns: { id: true, name: true }
    });
    const managedByName = new Map(managedRows.map((row) => [row.name, row]));

    // `@loxep/integration-cloudflare` is not a direct `apps/web` dependency
    // (provider SDK shapes stop at the integration boundary) — its per_page
    // ceiling is read through `@loxep/app`'s dynamic module the same way
    // every other fleet-adapter symbol reaches this app.
    const fleet = await getFleetModule();

    return estateOk<CloudflareEstateZonesDto>(
      {
        zones: zones.map((zone) => ({
          externalZoneId: zone.externalZoneId,
          name: zone.name,
          status: zone.status,
          paused: zone.paused,
          nameservers: zone.nameservers,
          accountId: zone.accountId,
          managedDomain: managedByName.get(zone.name) ?? null
        })),
        pagesLoaded: data.maxPages,
        hasMore: cloudflareEstateHasMore(
          zones.length,
          data.maxPages,
          fleet.CLOUDFLARE_ZONES_DEFAULT_PER_PAGE
        )
      },
      readAt
    );
  });

// ---------------------------------------------------------------------------
// Records — per-zone drill-in, ON EXPAND ONLY
// ---------------------------------------------------------------------------

export type CloudflareEstateRecordCrossReference = 'declared' | 'drift_open' | 'unexpected';

/**
 * The design's own three-way record cross-reference (§3.1): a live record
 * with no matching `dns_records` row is `'unexpected'`; one that matches but
 * has an open `dns_drift_findings` row is `'drift_open'`; otherwise it is
 * `'declared'`. Pure and exported so it is unit-testable with fakes (no
 * database, no adapter) — the shape `matchDeclaredResource` already
 * established for the Pangolin estate browser's own cross-reference.
 */
export function cloudflareRecordCrossReference(
  record: { type: string; name: string },
  declaredByKey: ReadonlyMap<string, { id: string }>,
  openFindingRecordIds: ReadonlySet<string>
): CloudflareEstateRecordCrossReference {
  const declared = declaredByKey.get(`${record.type}:${record.name}`);
  if (declared === undefined) return 'unexpected';
  return openFindingRecordIds.has(declared.id) ? 'drift_open' : 'declared';
}

/**
 * Rule P8's "Load more" boundary: whether the just-fetched page count could
 * plausibly hide more rows. `>=` rather than `>`, deliberately conservative
 * — a page that exactly fills `perPage` might be the whole truth, but
 * showing one extra (harmless) "Load more" click is a better failure mode
 * than silently hiding a row that exists.
 */
export function cloudflareEstateHasMore(
  rowCount: number,
  maxPages: number,
  perPage: number
): boolean {
  return rowCount >= maxPages * perPage;
}

export interface CloudflareEstateRecordDto {
  externalRecordId: string;
  type: string;
  /** Zone-relative, as `dns_records.name` stores it (`@`, `www`, …). */
  name: string;
  /** The complete name, via the adapter's own `toProviderName` — what an operator recognizes. */
  fqdn: string;
  content: string;
  /** `null` renders as "automatic" — the adapter already translated Cloudflare's `1` sentinel. */
  ttlSeconds: number | null;
  priority: number | null;
  proxied: boolean;
  /** Cloudflare's own read-only signal for whether THIS record type/name could ever be proxied. */
  proxiable: boolean;
  crossReference: CloudflareEstateRecordCrossReference;
}

export interface CloudflareEstateRecordsDto {
  externalZoneId: string;
  zoneName: string;
  /** Non-null exactly when a `managed_domains` row exists for this zone — the adopt affordance needs it. */
  managedDomainId: string | null;
  records: CloudflareEstateRecordDto[];
  pagesLoaded: number;
  hasMore: boolean;
}

const fetchCloudflareEstateRecordsInput = z.strictObject({
  connectionId: z.uuid(),
  externalZoneId: z.string().trim().min(1),
  zoneName: z.string().trim().min(1),
  maxPages: MAX_PAGES_SCHEMA
});

/**
 * Live DNS records for ONE zone — fired only when an operator expands that
 * zone (Rule P6). The `managed_domains`/`dns_records`/`dns_drift_findings`
 * cross-reference is a database read, never a second Cloudflare call, so
 * this drill-in costs exactly one provider call per "Load more" page —
 * inside Rule P7's "at most 2 calls per drill-in" ceiling with room to
 * spare.
 */
export const fetchCloudflareEstateRecords = createServerFn({ method: 'GET' })
  .inputValidator(fetchCloudflareEstateRecordsInput)
  .handler(async ({ data }): Promise<EstateSectionResult<CloudflareEstateRecordsDto>> => {
    const { requireSession, getAdminServices, getCloudflareAdapterForConnection, getFleetModule } =
      await import('@/server/admin');
    await requireSession();
    const { connections } = getAdminServices();
    const connection = await connections.getConnection(data.connectionId);
    if (connection.provider !== CLOUDFLARE_PROVIDER) {
      throw new Error(`connection "${data.connectionId}" is not a Cloudflare connection`);
    }

    const readAt = iso(new Date());
    let records: Awaited<
      ReturnType<Awaited<ReturnType<typeof getCloudflareAdapterForConnection>>['adapter']['read']>
    >;
    try {
      const { adapter } = await getCloudflareAdapterForConnection(data.connectionId);
      records = await adapter.read({
        externalZoneId: data.externalZoneId,
        zoneName: data.zoneName,
        maxPages: data.maxPages
      });
    } catch (error) {
      return estateError(
        classifyCaughtProviderError(error, "Could not read this zone's DNS records."),
        readAt
      );
    }

    const { handle } = getAdminServices();
    const managedDomain = await handle.db.query.managedDomains.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.dnsConnectionId, data.connectionId), eq(table.name, data.zoneName)),
      columns: { id: true }
    });

    const declaredRows =
      managedDomain === undefined
        ? []
        : await handle.db.query.dnsRecords.findMany({
            where: (table, { and, eq, isNull }) =>
              and(eq(table.domainId, managedDomain.id), isNull(table.desiredDeletedAt)),
            columns: { id: true, type: true, name: true }
          });
    const declaredByKey = new Map(declaredRows.map((row) => [`${row.type}:${row.name}`, row]));

    const openFindingRecordIds =
      managedDomain === undefined
        ? new Set<string>()
        : new Set(
            (
              await handle.db.query.dnsDriftFindings.findMany({
                where: (table, { and, eq, isNull }) =>
                  and(eq(table.domainId, managedDomain.id), isNull(table.resolvedAt)),
                columns: { dnsRecordId: true }
              })
            )
              .map((finding) => finding.dnsRecordId)
              .filter((id): id is string => id !== null)
          );

    const fleet = await getFleetModule();

    return estateOk<CloudflareEstateRecordsDto>(
      {
        externalZoneId: data.externalZoneId,
        zoneName: data.zoneName,
        managedDomainId: managedDomain?.id ?? null,
        records: records.map((record) => ({
          externalRecordId: record.externalRecordId,
          type: record.type,
          name: record.name,
          fqdn: fleet.cloudflareToProviderName(record.name, data.zoneName),
          content: record.content,
          ttlSeconds: record.ttlSeconds,
          priority: record.priority,
          proxied: record.proxied,
          proxiable: record.proxiable,
          crossReference: cloudflareRecordCrossReference(
            record,
            declaredByKey,
            openFindingRecordIds
          )
        })),
        pagesLoaded: data.maxPages,
        hasMore: cloudflareEstateHasMore(
          records.length,
          data.maxPages,
          fleet.CLOUDFLARE_RECORDS_DEFAULT_PER_PAGE
        )
      },
      readAt
    );
  });

// ---------------------------------------------------------------------------
// "Adopt" — the ONE write, and it reuses the EXISTING drift-panel verb
// ---------------------------------------------------------------------------

const adoptCloudflareEstateRecordInput = z.strictObject({
  connectionId: z.uuid(),
  domainId: z.uuid(),
  type: z.string().trim().min(1),
  name: z.string().trim().min(1),
  content: z.string().trim().min(1),
  ttlSeconds: z.number().int().nullable(),
  priority: z.number().int().nullable(),
  proxied: z.boolean(),
  externalRecordId: z.string().trim().min(1)
});

/**
 * Turns one LIVE Cloudflare record into a declared `dns_records` row —
 * exactly `DnsDriftPanel`'s "Adopt" button (`adoptDriftFinding`), entered
 * zone-first instead of drift-finding-first, sharing the SAME
 * `ManagedDomainsService.addManualRecord` write. No Cloudflare call of any
 * kind; idempotent by the natural key `(domainId, type, name, content)`.
 * Admin-only. Does NOT enqueue a reconcile — adopting means "start
 * controlling this from Loxep", matching Rule P11 exactly.
 */
export const adoptCloudflareEstateRecord = createServerFn({ method: 'POST' })
  .inputValidator(adoptCloudflareEstateRecordInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getAdminServices, getManagedDomainsService } =
      await import('@/server/admin');
    const session = await requireAdmin();
    const { handle } = getAdminServices();
    const domain = await handle.db.query.managedDomains.findFirst({
      where: (table, { eq }) => eq(table.id, data.domainId),
      columns: { id: true, dnsConnectionId: true }
    });
    if (domain === undefined || domain.dnsConnectionId !== data.connectionId) {
      throw new Error('This managed domain does not belong to this Cloudflare connection.');
    }
    const record = await getManagedDomainsService().addManualRecord(
      data.domainId,
      {
        type: data.type,
        name: data.name,
        content: data.content,
        ttlSeconds: data.ttlSeconds,
        priority: data.priority,
        proxied: data.proxied,
        externalRecordId: data.externalRecordId
      },
      { actorUserId: session.user.id }
    );
    return { id: record.id };
  });

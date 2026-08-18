/**
 * eBay purchase-sync enablement for eligible connections (loxep-dgf.5).
 *
 * `ebay_purchases` monitor targets are `@loxep/inventory`'s
 * (`purchase-sync.ts`, `ensurePurchaseSyncTarget`) — this module is what lets
 * an operator turn ingestion on from `/settings/connections`, the same gap
 * `@/server/order-sync-functions` closed for `woo_orders`/`ebay_orders`
 * (loxep-cxh).
 *
 * IMPLEMENTATION CHOICE — unlike `order-sync-functions.ts`: `@loxep/inventory`
 * (unlike `@loxep/commerce`) IS a direct `apps/web` dependency already
 * (`inventory-functions.ts`'s acquisitions/items surfaces reach it through
 * `@/server/admin`'s service registry), so this module calls
 * `ensurePurchaseSyncTarget` directly rather than re-implementing its
 * find-or-create invariant against `@loxep/market`'s `createMonitorService`.
 * The import stays a DYNAMIC one inside each handler regardless — the same
 * "server packages stay out of the client bundle" discipline every handler in
 * this directory follows (see `market-functions.ts`'s
 * `await import('@loxep/domain')` and `infrastructure-functions.ts`'s
 * `await import('@loxep/infrastructure')` for the same pattern reaching a
 * package outside `@/server/admin`'s registry). `admin.ts` was out of this
 * change's write fence (a sibling owns it this wave), which is the second
 * reason this reaches `@loxep/inventory` directly instead of adding a new
 * `getAdminServices()` accessor there.
 *
 * `ensurePurchaseSyncTarget` only finds-or-creates; it does not flip
 * `enabled` on an existing-but-disabled row (an idempotent re-poke must never
 * silently turn a deliberately-paused sync back on). Re-enabling and
 * disabling both go through `@loxep/market`'s `createMonitorService.
 * updateTarget` (`getMonitorService()` from `@/server/admin`, exactly
 * `order-sync-functions.ts`'s pattern) — `ebay_purchases` is registered in
 * `@loxep/market`'s `MONITOR_TARGET_TYPES`/`monitorTargetConfigSchemas` from
 * the same change that added the type, so that CRUD already covers it.
 *
 * ELIGIBILITY: `active`, non-archived, `provider = 'ebay'`, AND the
 * connection has completed eBay user consent at ALL — unlike order sync,
 * purchase sync does NOT require the wider `orders` consent tier.
 * `GetMyeBayBuying`'s `WonList` container is a Trading call authenticated by
 * the IAF user-token header with NO OAuth scope beyond the base
 * `watchlist`-tier grant every consented eBay connection already holds (this
 * bead's own VERIFIED FACTS, and `purchases.ts`'s module doc) — so the only
 * question here is "has this account completed eBay consent," read the same
 * way `EbayCredentialStatus`/`EbayConnectionActions`
 * (`@/features/settings/components/ebay-connection-actions`) do, just without
 * narrowing to the `orders` tier.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

/**
 * Mirrors `@loxep/inventory`'s `EBAY_PURCHASES_TARGET_TYPE` and the matching
 * `@loxep/market` `MonitorTargetType` entry. Re-declared, not imported at the
 * top level — see the module doc: every handler in this directory keeps
 * top-level imports type-only/framework-only and reaches a domain package
 * through a dynamic `import()` inside the handler instead.
 */
export const EBAY_PURCHASES_TARGET_TYPE = 'ebay_purchases' as const;

const EBAY_PROVIDER = 'ebay';

/** Per-connection purchase-sync status, folded into `ConnectionDto.purchaseSync`. */
export interface PurchaseSyncStatusDto {
  targetId: string;
  enabled: boolean;
  lastSuccessAt: string | null;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Whether a connection's `config.ebayOAuth` records ANY granted scope —
 * consent completed, at whichever tier. Mirrors `@/server/ebay-oauth`'s
 * `ebayGrantedScopes` shape without importing it (that module is a mixed
 * client/server helper file, and this check needs only the "consent
 * completed at all" fact, not the tier classification order sync needs).
 */
function hasEbayUserConsent(config: Record<string, unknown>): boolean {
  const scopes = readObject(config['ebayOAuth'])['scopes'];
  return Array.isArray(scopes) && scopes.length > 0;
}

/** Whether purchase sync may be turned ON for this connection right now. */
function isPurchaseSyncEligible(connection: {
  provider: string;
  status: string;
  config: Record<string, unknown>;
}): boolean {
  if (connection.status === 'archived') return false;
  if (connection.provider !== EBAY_PROVIDER) return false;
  return hasEbayUserConsent(connection.config);
}

function toPurchaseSyncStatusDto(row: {
  id: string;
  enabled: boolean;
  lastSuccessAt: Date | null;
}): PurchaseSyncStatusDto {
  return { targetId: row.id, enabled: row.enabled, lastSuccessAt: iso(row.lastSuccessAt) };
}

/**
 * Find or create the `ebay_purchases` target for a connection and enable it.
 * See the module doc for why creation goes through `@loxep/inventory`'s own
 * `ensurePurchaseSyncTarget` while re-enabling an existing disabled row goes
 * through `@loxep/market`'s monitor service.
 */
export const enablePurchaseSync = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ connectionId: z.uuid() }))
  .handler(async ({ data }): Promise<PurchaseSyncStatusDto> => {
    const { requireAdmin, getAdminServices, getMonitorService } = await import('@/server/admin');
    const session = await requireAdmin();
    const { connections, handle } = getAdminServices();
    const connection = await connections.getConnection(data.connectionId);

    if (!isPurchaseSyncEligible(connection)) {
      throw new Error(
        connection.status === 'archived'
          ? 'Cannot enable purchase sync for an archived account'
          : connection.provider !== EBAY_PROVIDER
            ? 'Purchase sync is only supported for eBay accounts'
            : 'Connect an eBay account first — use "Connect" to grant access'
      );
    }

    const { ensurePurchaseSyncTarget } = await import('@loxep/inventory');
    const cursor = await ensurePurchaseSyncTarget(handle.db, {
      connectionId: connection.id,
      createdByUserId: session.user.id
    });

    const row = await handle.db.query.monitorTargets.findFirst({
      where: (table, { eq }) => eq(table.id, cursor.monitorTargetId)
    });
    if (row === undefined) {
      throw new Error('Purchase-sync target insert returned no row');
    }
    if (row.enabled) return toPurchaseSyncStatusDto(row);

    const monitor = await getMonitorService();
    const updated = await monitor.updateTarget(row.id, { enabled: true });
    return toPurchaseSyncStatusDto(updated);
  });

/** Disable an existing purchase-sync target for a connection. */
export const disablePurchaseSync = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ connectionId: z.uuid() }))
  .handler(async ({ data }): Promise<PurchaseSyncStatusDto> => {
    const { requireAdmin, getAdminServices, getMonitorService } = await import('@/server/admin');
    await requireAdmin();
    const { connections, handle } = getAdminServices();
    const connection = await connections.getConnection(data.connectionId);

    const existing = await handle.db.query.monitorTargets.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.connectionId, connection.id),
          eq(table.targetType, EBAY_PURCHASES_TARGET_TYPE)
        ),
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)]
    });
    if (existing === undefined) {
      throw new Error('No purchase-sync target exists for this account yet');
    }

    if (!existing.enabled) {
      return toPurchaseSyncStatusDto(existing);
    }
    const monitor = await getMonitorService();
    const row = await monitor.updateTarget(existing.id, { enabled: false });
    return toPurchaseSyncStatusDto(row);
  });

/**
 * "Sync now" (loxep-u8c A25). The registry's own doc calls a "sync now"
 * button exactly this task's on-demand entry point, and `@loxep/app` already
 * exports `enqueueEbayPurchaseSync`/`ebayPurchaseSyncJobKey` for precisely
 * this — this function is the first caller.
 *
 * `enqueueEbayPurchaseSync` takes a raw Graphile `addJob(identifier,
 * payload?, spec?)`-shaped callback (`RawAddJob`, `@loxep/commerce`), not
 * `@loxep/infrastructure`'s `TransactionalEnqueue` (`(tx, taskName, payload,
 * options?)`) every OTHER apps/web "sync now" action uses. Rather than fork
 * a second enqueue path (or import `@loxep/jobs`'s real `addJob`, which must
 * never reach the web bundle), the adapter below wraps `getSyncNowEnqueue()`
 * in a `RawAddJob`-shaped closure over one transaction — every write still
 * goes through the same `graphile_worker.add_job` SQL insert
 * `TransactionalEnqueue` always uses, so this reuses
 * `enqueueEbayPurchaseSync`'s own payload/job-key construction instead of
 * duplicating it, while staying on the sanctioned transactional seam.
 * `spec?.jobKeyMode` is hardcoded to `'replace'` rather than forwarded,
 * because `enqueueEbayPurchaseSync` only ever passes that literal — see its
 * source in `packages/app/src/inventory-ebay.ts`.
 *
 * Requires an existing, ENABLED `ebay_purchases` target — this never
 * creates or enables one (that stays `enablePurchaseSync`'s job).
 */
export const syncPurchasesNow = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ connectionId: z.uuid() }))
  .handler(async ({ data }): Promise<{ enqueued: true }> => {
    const { requireAdmin, getAdminServices, getSyncNowEnqueue, getFleetModule } =
      await import('@/server/admin');
    await requireAdmin();
    const { connections, handle } = getAdminServices();
    const connection = await connections.getConnection(data.connectionId);

    if (connection.provider !== EBAY_PROVIDER) {
      throw new Error('Purchase sync is only supported for eBay accounts');
    }

    const existing = await handle.db.query.monitorTargets.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.connectionId, connection.id),
          eq(table.targetType, EBAY_PURCHASES_TARGET_TYPE)
        ),
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)]
    });
    if (existing === undefined || !existing.enabled) {
      throw new Error('Enable purchase sync before syncing on demand');
    }

    const enqueue = getSyncNowEnqueue();
    const fleet = await getFleetModule();
    await handle.db.transaction(async (tx) => {
      await fleet.enqueueEbayPurchaseSync(
        (identifier, payload, spec) =>
          enqueue(
            tx,
            identifier,
            (payload ?? {}) as Record<string, unknown>,
            spec?.jobKey === undefined ? undefined : { jobKey: spec.jobKey, jobKeyMode: 'replace' }
          ),
        { connectionId: connection.id }
      );
    });
    return { enqueued: true };
  });

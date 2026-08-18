/**
 * Order-sync enablement for eligible connections (loxep-cxh).
 *
 * `woo_orders`/`ebay_orders` monitor targets were previously creatable only
 * through `@loxep/commerce`'s composition-root helpers
 * (`ensureWooOrderSyncTarget`/`ensureEbayOrderSyncTarget`) — nothing in
 * apps/web could reach them, so an operator with an active WooCommerce store
 * or an eBay connection consented at the orders tier had no way to turn
 * order ingestion on from the app.
 *
 * IMPLEMENTATION CHOICE — no `@loxep/commerce` dependency here:
 * `apps/web/package.json` does not declare `@loxep/commerce` (unlike
 * `@loxep/market`/`@loxep/notifications`, which `@/server/admin` already
 * reaches through its `@vite-ignore` dynamic-import registry), and adding
 * that dependency edge is outside this change's write fence. It is also
 * unnecessary: `woo_orders` and `ebay_orders` are both registered in
 * `@loxep/market`'s `MONITOR_TARGET_TYPES` / `monitorTargetConfigSchemas`
 * (loxep-itn closed exactly this gap so `createMonitorService` CRUD works
 * for both target types), and apps/web already depends on `@loxep/market`
 * via `getMonitorService()`. This module find-or-creates the target row
 * directly through that service instead — the same `monitor_targets` row
 * shape `@loxep/commerce`'s `ensureOrderSyncTarget` would write (empty
 * `config` on first creation, the same default interval), which its sync
 * executors (`sync.ts`/`ebay-sync.ts`, wired in `@loxep/app`) already read
 * and write via the shared `commerceSync` config namespace. Only creation
 * and enable/disable live here.
 *
 * ELIGIBILITY (loxep-cxh):
 * - WooCommerce: any connection that is not archived. `active` and
 *   `disabled` both create/keep the target row — `disabled` just means the
 *   connection's own credential polling is paused, not that order sync must
 *   be too — but the UI (see `order-sync-cell.tsx`) only surfaces the
 *   control on `active` rows, matching the task's "active woocommerce
 *   always" rule.
 * - eBay: only when the granted OAuth scopes include the `orders` consent
 *   tier (loxep-ld0) — `sell.fulfillment.readonly` — read from
 *   `connections.config.ebayOAuth.scopes` the same way
 *   `EbayCredentialStatus`/`EbayConnectionActions`
 *   (`@/features/settings/components/ebay-connection-actions`) do.
 * - Medusa (loxep-xxz): like WooCommerce, not eBay — no OAuth, no consent
 *   tier, no scope check. Any connection that is not archived is eligible,
 *   full stop.
 * - Archived connections are never eligible: they are retired and skipped
 *   everywhere.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

/**
 * Mirrors `@loxep/commerce`'s `WOO_ORDERS_TARGET_TYPE`/`EBAY_ORDERS_TARGET_TYPE`/
 * `MEDUSA_ORDERS_TARGET_TYPE` and the matching `@loxep/market`
 * `MonitorTargetType` entries. Re-declared, not imported — see the module
 * doc above for why apps/web does not depend on `@loxep/commerce`. The
 * re-declaration discipline mirrors `@loxep/market`'s own
 * `commerceSyncStateSchema` (which re-declares `@loxep/commerce`'s config
 * shape for the same cross-boundary reason).
 */
export const WOO_ORDERS_TARGET_TYPE = 'woo_orders' as const;
export const EBAY_ORDERS_TARGET_TYPE = 'ebay_orders' as const;
export const MEDUSA_ORDERS_TARGET_TYPE = 'medusa_orders' as const;
export type OrderSyncTargetType =
  | typeof WOO_ORDERS_TARGET_TYPE
  | typeof EBAY_ORDERS_TARGET_TYPE
  | typeof MEDUSA_ORDERS_TARGET_TYPE;

/** Mirrors `@loxep/commerce`'s `DEFAULT_SYNC_INTERVAL_SECONDS`. */
const DEFAULT_ORDER_SYNC_INTERVAL_SECONDS = 900;

/**
 * Mirrors `@loxep/market`'s `POLL_TARGET_TASK_NAME` (`packages/market/src/
 * tasks.ts`) — re-declared, not imported at the top level, for the same
 * reason every other cross-boundary constant in this file is (see the
 * module doc): apps/web reaches `@loxep/market` only through the dynamic
 * `getMarketModule()`/`getMonitorService()` accessors, never a static
 * top-level import. `market.dispatch-due-monitors`'s own dispatcher enqueues
 * exactly this task, with exactly this job-key shape, for every DUE
 * `monitor_targets` row regardless of `targetType` — `woo_orders`/
 * `ebay_orders`/`medusa_orders` included — so "Sync now" reuses the same
 * task rather than inventing a second, order-sync-specific one.
 */
const MARKET_POLL_TARGET_TASK_NAME = 'market.poll-target';

/**
 * Mirrors `@loxep/jobs`'s `jobKeyFor(taskName, stableId)` convention
 * (`taskName:stableId`) — re-declared rather than imported, since importing
 * `@loxep/jobs` here would pull graphile-worker into the web bundle (the one
 * thing this codebase's job-enqueue conventions forbid apps/web from doing).
 * Using the SAME key the dispatcher's own `enqueuePollJob` builds means a
 * manual "Sync now" click and the next scheduled poll dedupe against each
 * other (`jobKeyMode: 'replace'`) instead of double-queuing.
 */
function marketPollTargetJobKey(monitorTargetId: string): string {
  return `${MARKET_POLL_TARGET_TASK_NAME}:${monitorTargetId}`;
}

const WOOCOMMERCE_PROVIDER = 'woocommerce';
const EBAY_PROVIDER = 'ebay';
/** Mirrors `@loxep/commerce`'s `MEDUSA_PROVIDER`. */
const MEDUSA_PROVIDER = 'medusa';
/** Mirrors `@/server/ebay-oauth`'s `EBAY_ORDER_SCOPE`. */
const EBAY_ORDER_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly';

/** Per-connection order-sync status, folded into `ConnectionDto.orderSync`. */
export interface OrderSyncStatusDto {
  targetId: string;
  targetType: OrderSyncTargetType;
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

/** Whether a connection's granted eBay scopes include the orders tier (loxep-ld0). */
function hasEbayOrderScope(config: Record<string, unknown>): boolean {
  const scopes = readObject(config['ebayOAuth'])['scopes'];
  return Array.isArray(scopes) && scopes.includes(EBAY_ORDER_SCOPE);
}

/** The order-sync target type this provider uses, or `null` for an unsupported provider. */
function orderSyncTargetTypeForProvider(provider: string): OrderSyncTargetType | null {
  if (provider === WOOCOMMERCE_PROVIDER) return WOO_ORDERS_TARGET_TYPE;
  if (provider === EBAY_PROVIDER) return EBAY_ORDERS_TARGET_TYPE;
  if (provider === MEDUSA_PROVIDER) return MEDUSA_ORDERS_TARGET_TYPE;
  return null;
}

/** Whether order sync may be turned ON for this connection right now. */
function isOrderSyncEligible(connection: {
  provider: string;
  status: string;
  config: Record<string, unknown>;
}): boolean {
  if (connection.status === 'archived') return false;
  if (connection.provider === WOOCOMMERCE_PROVIDER) return true;
  if (connection.provider === EBAY_PROVIDER) return hasEbayOrderScope(connection.config);
  if (connection.provider === MEDUSA_PROVIDER) return true;
  return false;
}

/**
 * A lookup, not a binary ternary (loxep-xxz) — the ternary this replaced
 * silently gave any third provider the eBay label the day one was added.
 * Keyed by target type so an unrecognized future type still fails loudly
 * (`satisfies Record<OrderSyncTargetType, string>` below) rather than
 * falling through to the wrong name.
 */
const TARGET_NAME_PREFIXES = {
  [WOO_ORDERS_TARGET_TYPE]: 'WooCommerce orders',
  [EBAY_ORDERS_TARGET_TYPE]: 'eBay orders',
  [MEDUSA_ORDERS_TARGET_TYPE]: 'Medusa orders'
} as const satisfies Record<OrderSyncTargetType, string>;

function targetNamePrefix(targetType: OrderSyncTargetType): string {
  return TARGET_NAME_PREFIXES[targetType];
}

/**
 * Provider-aware ineligibility reason (loxep-xxz) — the message this
 * replaced was eBay-worded ("has not granted order access yet") for every
 * provider, which is simply wrong for WooCommerce/Medusa (neither has a
 * consent tier to grant).
 */
function ineligibleOrderSyncMessage(provider: string): string {
  if (provider === EBAY_PROVIDER) {
    return 'This eBay account has not granted order access yet — use "Grant order access" first';
  }
  return `Order sync is not currently eligible for this ${provider} account`;
}

function toOrderSyncStatusDto(row: {
  id: string;
  targetType: string;
  enabled: boolean;
  lastSuccessAt: Date | null;
}): OrderSyncStatusDto {
  return {
    targetId: row.id,
    targetType: row.targetType as OrderSyncTargetType,
    enabled: row.enabled,
    lastSuccessAt: iso(row.lastSuccessAt)
  };
}

/**
 * Find or create the `woo_orders`/`ebay_orders` target for a connection and
 * enable it. Creation and re-enablement both go through
 * `MonitorService.createTarget`/`updateTarget` — see the module doc for why
 * that stands in for `@loxep/commerce`'s `ensure*OrderSyncTarget` helpers.
 */
export const enableOrderSync = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ connectionId: z.uuid() }))
  .handler(async ({ data }): Promise<OrderSyncStatusDto> => {
    const { requireAdmin, getAdminServices, getMonitorService } = await import('@/server/admin');
    const session = await requireAdmin();
    const { connections, handle } = getAdminServices();
    const connection = await connections.getConnection(data.connectionId);

    const targetType = orderSyncTargetTypeForProvider(connection.provider);
    if (targetType === null) {
      throw new Error(`Order sync is not supported for provider "${connection.provider}"`);
    }
    if (!isOrderSyncEligible(connection)) {
      throw new Error(
        connection.status === 'archived'
          ? 'Cannot enable order sync for an archived account'
          : ineligibleOrderSyncMessage(connection.provider)
      );
    }

    const monitor = await getMonitorService();
    const existing = await handle.db.query.monitorTargets.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.connectionId, connection.id), eq(table.targetType, targetType)),
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)]
    });

    const row =
      existing === undefined
        ? await monitor.createTarget({
            targetType,
            name: `${targetNamePrefix(targetType)} — ${connection.name}`,
            connectionId: connection.id,
            enabled: true,
            intervalSeconds: DEFAULT_ORDER_SYNC_INTERVAL_SECONDS,
            createdByUserId: session.user.id
          })
        : existing.enabled
          ? existing
          : await monitor.updateTarget(existing.id, { enabled: true });

    return toOrderSyncStatusDto(row);
  });

/** Disable an existing order-sync target for a connection. */
export const disableOrderSync = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ connectionId: z.uuid() }))
  .handler(async ({ data }): Promise<OrderSyncStatusDto> => {
    const { requireAdmin, getAdminServices, getMonitorService } = await import('@/server/admin');
    await requireAdmin();
    const { connections, handle } = getAdminServices();
    const connection = await connections.getConnection(data.connectionId);

    const targetType = orderSyncTargetTypeForProvider(connection.provider);
    if (targetType === null) {
      throw new Error(`Order sync is not supported for provider "${connection.provider}"`);
    }

    const existing = await handle.db.query.monitorTargets.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.connectionId, connection.id), eq(table.targetType, targetType)),
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)]
    });
    if (existing === undefined) {
      throw new Error('No order-sync target exists for this account yet');
    }

    if (!existing.enabled) {
      return toOrderSyncStatusDto(existing);
    }
    const monitor = await getMonitorService();
    const row = await monitor.updateTarget(existing.id, { enabled: false });
    return toOrderSyncStatusDto(row);
  });

/**
 * "Sync now" (loxep-u8c A25). Order-sync's registry entry describes exactly
 * this as its on-demand entry point, but nothing wired one up. Re-enqueues
 * `market.poll-target` for the connection's EXISTING order-sync target —
 * the same task/job-key `market.dispatch-due-monitors` already uses for its
 * regular polling, so a manual click and the next scheduled poll dedupe
 * against each other (`jobKeyMode: 'replace'`) rather than double-queuing,
 * and this function never creates or enables a target (that stays
 * `enableOrderSync`'s job) — it only wakes one up early.
 *
 * Goes through `getSyncNowEnqueue()` (`@loxep/infrastructure`'s
 * `TransactionalEnqueue`, a plain `graphile_worker.add_job` INSERT run
 * inside a transaction) rather than a raw Graphile `addJob` — `@loxep/jobs`
 * never reaches the web bundle this way.
 */
export const syncOrdersNow = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ connectionId: z.uuid() }))
  .handler(async ({ data }): Promise<{ enqueued: true }> => {
    const { requireAdmin, getAdminServices, getSyncNowEnqueue } = await import('@/server/admin');
    await requireAdmin();
    const { connections, handle } = getAdminServices();
    const connection = await connections.getConnection(data.connectionId);

    const targetType = orderSyncTargetTypeForProvider(connection.provider);
    if (targetType === null) {
      throw new Error(`Order sync is not supported for provider "${connection.provider}"`);
    }

    const existing = await handle.db.query.monitorTargets.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.connectionId, connection.id), eq(table.targetType, targetType)),
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)]
    });
    if (existing === undefined || !existing.enabled) {
      throw new Error('Enable order sync before syncing on demand');
    }

    const enqueue = getSyncNowEnqueue();
    await handle.db.transaction(async (tx) => {
      await enqueue(
        tx,
        MARKET_POLL_TARGET_TASK_NAME,
        { monitorTargetId: existing.id },
        { jobKey: marketPollTargetJobKey(existing.id), jobKeyMode: 'replace' }
      );
    });
    return { enqueued: true };
  });

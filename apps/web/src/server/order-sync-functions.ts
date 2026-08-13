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
 * - Archived connections are never eligible: they are retired and skipped
 *   everywhere.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

/**
 * Mirrors `@loxep/commerce`'s `WOO_ORDERS_TARGET_TYPE`/`EBAY_ORDERS_TARGET_TYPE`
 * and the matching `@loxep/market` `MonitorTargetType` entries. Re-declared,
 * not imported — see the module doc above for why apps/web does not depend
 * on `@loxep/commerce`. The re-declaration discipline mirrors
 * `@loxep/market`'s own `commerceSyncStateSchema` (which re-declares
 * `@loxep/commerce`'s config shape for the same cross-boundary reason).
 */
export const WOO_ORDERS_TARGET_TYPE = 'woo_orders' as const;
export const EBAY_ORDERS_TARGET_TYPE = 'ebay_orders' as const;
export type OrderSyncTargetType = typeof WOO_ORDERS_TARGET_TYPE | typeof EBAY_ORDERS_TARGET_TYPE;

/** Mirrors `@loxep/commerce`'s `DEFAULT_SYNC_INTERVAL_SECONDS`. */
const DEFAULT_ORDER_SYNC_INTERVAL_SECONDS = 900;

const WOOCOMMERCE_PROVIDER = 'woocommerce';
const EBAY_PROVIDER = 'ebay';
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
  return false;
}

function targetNamePrefix(targetType: OrderSyncTargetType): string {
  return targetType === WOO_ORDERS_TARGET_TYPE ? 'WooCommerce orders' : 'eBay orders';
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
          : 'This eBay account has not granted order access yet — use "Grant order access" first'
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

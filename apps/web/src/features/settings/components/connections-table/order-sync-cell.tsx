import { formatDateTime } from '@/lib/format';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { ebayConsentTierForScopes, ebayGrantedScopes } from '@/server/ebay-oauth';
import type { ConnectionDto } from '@/server/admin-functions';

const WOOCOMMERCE_PROVIDER = 'woocommerce';
const EBAY_PROVIDER = 'ebay';

/**
 * Whether the "Order sync" control should even offer to turn sync on
 * (loxep-cxh) — mirrors `@/server/order-sync-functions`'
 * `isOrderSyncEligible`, narrowed to `active` rows only (the task's "active
 * woocommerce always" rule). WooCommerce: any active account. eBay: only
 * once the connection's granted scopes include the orders consent tier
 * (loxep-ld0), read the same way
 * `@/features/settings/components/ebay-connection-actions`'
 * `EbayCredentialStatus`/`EbayConnectionActions` already do.
 */
export function isOrderSyncEligible(connection: ConnectionDto): boolean {
  if (connection.status !== 'active') return false;
  if (connection.provider === WOOCOMMERCE_PROVIDER) return true;
  if (connection.provider === EBAY_PROVIDER) {
    return ebayConsentTierForScopes(ebayGrantedScopes(connection.config)) === 'orders';
  }
  return false;
}

/** Whether this connection's provider has an order-sync concept at all. */
export function supportsOrderSync(connection: ConnectionDto): boolean {
  return connection.provider === WOOCOMMERCE_PROVIDER || connection.provider === EBAY_PROVIDER;
}

/** A one-line reason the control is not offered yet, or `null` when it is (or never will be). */
export function orderSyncIneligibleHint(connection: ConnectionDto): string | null {
  if (!supportsOrderSync(connection) || isOrderSyncEligible(connection)) return null;
  // Archived is a retired, neutral terminal state — its row already reads
  // that way everywhere else, so no extra hint text is added here.
  if (connection.status === 'archived') return null;
  if (connection.status !== 'active') return 'Account must be active';
  if (connection.provider === EBAY_PROVIDER) {
    return 'Needs order access — use "Grant order access" first';
  }
  return null;
}

/**
 * Read-only state badge for the connections table's "Order sync" column.
 * `success` tone when enabled — mirrors the table's convention that an
 * operator state never rides on alarm colors alone (see
 * `CONNECTION_STATUS_TONE` in `./columns`).
 */
export function OrderSyncStatusCell({ connection }: { connection: ConnectionDto }) {
  if (!supportsOrderSync(connection)) {
    return <span className='text-muted-foreground'>—</span>;
  }

  const hint = orderSyncIneligibleHint(connection);
  if (hint !== null) {
    return <span className='text-muted-foreground text-xs'>{hint}</span>;
  }

  const orderSync = connection.orderSync;
  if (orderSync === null || !orderSync.enabled) {
    return <ToneBadge tone='outline'>Off</ToneBadge>;
  }

  return (
    <ToneBadge
      tone='success'
      title={
        orderSync.lastSuccessAt
          ? `Last successful sync ${formatDateTime(orderSync.lastSuccessAt)}`
          : 'Enabled — no successful sync yet'
      }
    >
      Syncing{orderSync.lastSuccessAt ? ` · ${formatDateTime(orderSync.lastSuccessAt)}` : ''}
    </ToneBadge>
  );
}

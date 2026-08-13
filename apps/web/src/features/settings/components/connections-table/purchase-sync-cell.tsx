import { formatDateTime } from '@/lib/format';
import { ToneBadge } from '@/features/settings/components/status-tone';
import type { ConnectionDto } from '@/server/admin-functions';

const EBAY_PROVIDER = 'ebay';

/**
 * Whether a connection's `config.ebayOAuth` records ANY granted scope —
 * consent completed, at whichever tier. Local, read-only twin of
 * `@/server/purchase-sync-functions`' `hasEbayUserConsent` — this file is
 * client-rendered (the connections table), so it reads the same
 * already-fetched `ConnectionDto.config` rather than calling the server.
 */
function hasEbayUserConsent(config: Record<string, unknown>): boolean {
  const ebayOAuth = config['ebayOAuth'];
  const scopes =
    typeof ebayOAuth === 'object' && ebayOAuth !== null && !Array.isArray(ebayOAuth)
      ? (ebayOAuth as Record<string, unknown>)['scopes']
      : undefined;
  return Array.isArray(scopes) && scopes.length > 0;
}

/**
 * Whether the "Purchase sync" control should even offer to turn sync on
 * (loxep-dgf.5) — mirrors `@/server/purchase-sync-functions`'
 * `isPurchaseSyncEligible`. Unlike order sync, no consent TIER narrowing:
 * `GetMyeBayBuying`'s `WonList` needs only the base `watchlist`-tier token
 * every consented eBay connection already holds.
 */
export function isPurchaseSyncEligible(connection: ConnectionDto): boolean {
  if (connection.status !== 'active') return false;
  if (connection.provider !== EBAY_PROVIDER) return false;
  return hasEbayUserConsent(connection.config);
}

/** Whether this connection's provider has a purchase-sync concept at all. */
export function supportsPurchaseSync(connection: ConnectionDto): boolean {
  return connection.provider === EBAY_PROVIDER;
}

/** A one-line reason the control is not offered yet, or `null` when it is (or never will be). */
export function purchaseSyncIneligibleHint(connection: ConnectionDto): string | null {
  if (!supportsPurchaseSync(connection) || isPurchaseSyncEligible(connection)) return null;
  // Archived is a retired, neutral terminal state — its row already reads
  // that way everywhere else, so no extra hint text is added here.
  if (connection.status === 'archived') return null;
  if (connection.status !== 'active') return 'Account must be active';
  return 'Connect an eBay account first';
}

/**
 * Read-only state badge for the connections table's "Purchase sync" column.
 * Same tone convention as `OrderSyncStatusCell`: `success` when enabled, an
 * operator state never rides on alarm colors alone.
 */
export function PurchaseSyncStatusCell({ connection }: { connection: ConnectionDto }) {
  if (!supportsPurchaseSync(connection)) {
    return <span className='text-muted-foreground'>—</span>;
  }

  const hint = purchaseSyncIneligibleHint(connection);
  if (hint !== null) {
    return <span className='text-muted-foreground text-xs'>{hint}</span>;
  }

  const purchaseSync = connection.purchaseSync;
  if (purchaseSync === null || !purchaseSync.enabled) {
    return <ToneBadge tone='outline'>Off</ToneBadge>;
  }

  return (
    <ToneBadge
      tone='success'
      title={
        purchaseSync.lastSuccessAt
          ? `Last successful sync ${formatDateTime(purchaseSync.lastSuccessAt)}`
          : 'Enabled — no successful sync yet'
      }
    >
      Syncing{purchaseSync.lastSuccessAt ? ` · ${formatDateTime(purchaseSync.lastSuccessAt)}` : ''}
    </ToneBadge>
  );
}

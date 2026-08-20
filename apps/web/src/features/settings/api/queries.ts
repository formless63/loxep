import { queryOptions } from '@tanstack/react-query';
import {
  fetchApplicationSettings,
  fetchAuthProvisioning,
  fetchConnections,
  fetchEntities,
  fetchFirstAdminBootstrap,
  fetchFleetEvidenceSources,
  fetchGatusPushSettings,
  fetchHealthReport,
  fetchIntegrationHealth,
  fetchIntegrationsEnabled,
  fetchMonitorTargetOptions,
  fetchNotificationDeliveries,
  fetchNotificationFeed,
  fetchNotificationEndpoints,
  fetchNotificationRules,
  fetchOnboardingOidcPrompt,
  fetchProviderWritePolicy,
  fetchStorageBackends,
  fetchUsers
} from '@/server/admin-functions';
import { fetchAuditEvents } from '@/server/audit-functions';
import { fetchEbayCallbackUrl, fetchEbayKeysetStatus } from '@/server/ebay-oauth';
import { fetchEtsyCallbackUrl, fetchEtsyKeysetStatus } from '@/server/etsy-oauth';
import {
  fetchStorageBackendOptions,
  fetchStorageMigrations,
  fetchStorageMigrationStatus
} from '@/server/storage-migration-functions';

export const healthReportQuery = queryOptions({
  queryKey: ['settings', 'health'],
  queryFn: () => fetchHealthReport(),
  refetchInterval: 30_000
});

/** Phase 8 milestone 1 (loxep-ovj.1): subjects by status, from `integration_health`. */
export const integrationHealthQuery = queryOptions({
  queryKey: ['settings', 'integration-health'],
  queryFn: () => fetchIntegrationHealth(),
  refetchInterval: 30_000
});

export const entitiesQuery = queryOptions({
  queryKey: ['settings', 'entities'],
  queryFn: () => fetchEntities()
});

export const connectionsQuery = queryOptions({
  queryKey: ['settings', 'connections'],
  queryFn: () => fetchConnections()
});

/** Phase 8 milestone 7 (loxep-ovj.7): configured inbound evidence sources. */
export const fleetEvidenceSourcesQuery = queryOptions({
  queryKey: ['settings', 'fleet-evidence-sources'],
  queryFn: () => fetchFleetEvidenceSources()
});

export const ebayKeysetStatusQuery = queryOptions({
  queryKey: ['settings', 'ebay-keyset-status'],
  queryFn: () => fetchEbayKeysetStatus()
});

/**
 * This installation's eBay callback URL — a deployment fact, not a secret,
 * shown in the keyset setup guidance so it can be copied into eBay's
 * "auth accepted URL" field. It only changes when the deployment moves.
 */
export const ebayCallbackUrlQuery = queryOptions({
  queryKey: ['settings', 'ebay-callback-url'],
  queryFn: () => fetchEbayCallbackUrl(),
  staleTime: Infinity
});

export const etsyKeysetStatusQuery = queryOptions({
  queryKey: ['settings', 'etsy-keyset-status'],
  queryFn: () => fetchEtsyKeysetStatus()
});

/**
 * This installation's Etsy callback URL — shown in the keyset setup
 * guidance so the operator can register the exact redirect URI with Etsy
 * (Etsy takes the literal URL, unlike eBay's RuName indirection).
 */
export const etsyCallbackUrlQuery = queryOptions({
  queryKey: ['settings', 'etsy-callback-url'],
  queryFn: () => fetchEtsyCallbackUrl(),
  staleTime: Infinity
});

export const storageBackendsQuery = queryOptions({
  queryKey: ['settings', 'storage-backends'],
  queryFn: () => fetchStorageBackends()
});

/** The migrate-objects dialog's source/destination pickers (loxep-7fs, A15). */
export const storageBackendOptionsQuery = queryOptions({
  queryKey: ['settings', 'storage-backend-options'],
  queryFn: () => fetchStorageBackendOptions()
});

/** Live progress for one storage migration — polled while it is `running`. */
export const storageMigrationStatusQuery = (id: string) =>
  queryOptions({
    queryKey: ['settings', 'storage-migration', id],
    queryFn: () => fetchStorageMigrationStatus({ data: { id } })
  });

/**
 * Every migration this installation has started, newest first (loxep-rh0) —
 * lets the `/settings/storage` panel survive a reload instead of only
 * tracking whichever migration it started in local React state. Polled
 * while anything is still `running`.
 */
export const storageMigrationsQuery = queryOptions({
  queryKey: ['settings', 'storage-migrations'],
  queryFn: () => fetchStorageMigrations({ data: {} }),
  refetchInterval: (query) =>
    (query.state.data ?? []).some((migration) => migration.status === 'running') ? 5000 : false
});

export const usersQuery = queryOptions({
  queryKey: ['settings', 'users'],
  queryFn: () => fetchUsers()
});

/** Account provisioning policy (ADR-0024) — admin-only, like the user directory. */
export const authProvisioningQuery = queryOptions({
  queryKey: ['settings', 'auth-provisioning'],
  queryFn: () => fetchAuthProvisioning()
});

export const firstAdminBootstrapQuery = queryOptions({
  queryKey: ['settings', 'first-admin-bootstrap'],
  queryFn: () => fetchFirstAdminBootstrap()
});

/**
 * Onboarding card (ADR-0024 §2, loxep-yk8): whether `/dashboard/overview`
 * should offer to open OIDC auto-provisioning. Safe for a member to fetch —
 * the server function itself returns `{show: false}` for a non-admin rather
 * than 403ing, since the dashboard route is not admin-gated.
 */
export const onboardingOidcPromptQuery = queryOptions({
  queryKey: ['settings', 'onboarding-oidc-prompt'],
  queryFn: () => fetchOnboardingOidcPrompt()
});

export const applicationSettingsQuery = queryOptions({
  queryKey: ['settings', 'application-settings'],
  queryFn: () => fetchApplicationSettings()
});

/** Phase 8 milestone 2 (loxep-ovj.2): the Gatus outward push configuration. */
export const gatusPushSettingsQuery = queryOptions({
  queryKey: ['settings', 'gatus-push'],
  queryFn: () => fetchGatusPushSettings()
});

/**
 * The `integrations.enabled` catalog-visibility map (loxep-dgg). Member-
 * readable: every provider-enumerating surface (catalog grid, connection-add
 * options) filters by this, not only the admin-only toggle that writes it.
 */
export const integrationsEnabledQuery = queryOptions({
  queryKey: ['settings', 'integrations-enabled'],
  queryFn: () => fetchIntegrationsEnabled()
});

/**
 * The `infrastructure.provider_write_policy` map (Pangolin chain design M3,
 * loxep-acj.3). Member-readable, matching `integrationsEnabledQuery` — only
 * the flip itself (`setConnectionWritePolicy`) is admin-only. A connection
 * absent from this map is `'read_only'`, applied by the connections table's
 * own render, not here.
 */
export const providerWritePolicyQuery = queryOptions({
  queryKey: ['settings', 'provider-write-policy'],
  queryFn: () => fetchProviderWritePolicy()
});

export const notificationEndpointsQuery = queryOptions({
  queryKey: ['settings', 'notification-endpoints'],
  queryFn: () => fetchNotificationEndpoints()
});

export const notificationRulesQuery = queryOptions({
  queryKey: ['settings', 'notification-rules'],
  queryFn: () => fetchNotificationRules()
});

export const monitorTargetOptionsQuery = queryOptions({
  queryKey: ['settings', 'monitor-target-options'],
  queryFn: () => fetchMonitorTargetOptions()
});

/** The product shell's bell (loxep-oii): the real notification-event feed. */
export const notificationFeedQuery = queryOptions({
  queryKey: ['notifications', 'feed'],
  queryFn: () => fetchNotificationFeed(),
  refetchInterval: 60_000
});

export const notificationDeliveriesQuery = queryOptions({
  queryKey: ['settings', 'notification-deliveries'],
  queryFn: () => fetchNotificationDeliveries(),
  refetchInterval: 15_000
});

/** `/settings/audit`'s server-side filters (loxep-161) — pushed into `fetchAuditEvents`, never applied client-side over a full fetch (this ledger grows forever). */
export interface AuditEventsFilterParams {
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  action?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export const auditEventsQuery = (filter: AuditEventsFilterParams) =>
  queryOptions({
    queryKey: ['settings', 'audit', filter],
    queryFn: () => fetchAuditEvents({ data: filter })
  });

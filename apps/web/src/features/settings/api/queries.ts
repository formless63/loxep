import { queryOptions } from '@tanstack/react-query';
import {
  fetchApplicationSettings,
  fetchConnections,
  fetchEntities,
  fetchFirstAdminBootstrap,
  fetchGatusPushSettings,
  fetchHealthReport,
  fetchIntegrationHealth,
  fetchMonitorTargetOptions,
  fetchNotificationDeliveries,
  fetchNotificationEndpoints,
  fetchNotificationRules,
  fetchStorageBackends,
  fetchUsers
} from '@/server/admin-functions';
import { fetchEbayCallbackUrl, fetchEbayKeysetStatus } from '@/server/ebay-oauth';
import { fetchEtsyCallbackUrl, fetchEtsyKeysetStatus } from '@/server/etsy-oauth';

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

export const usersQuery = queryOptions({
  queryKey: ['settings', 'users'],
  queryFn: () => fetchUsers()
});

export const firstAdminBootstrapQuery = queryOptions({
  queryKey: ['settings', 'first-admin-bootstrap'],
  queryFn: () => fetchFirstAdminBootstrap()
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

export const notificationDeliveriesQuery = queryOptions({
  queryKey: ['settings', 'notification-deliveries'],
  queryFn: () => fetchNotificationDeliveries(),
  refetchInterval: 15_000
});
